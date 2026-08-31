import { chromium, request } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '.credentials.local.json'), 'utf-8'));
const RUN_LABEL = process.argv[2] || 'auth-lang-baseline';
const RUN_TS = process.argv[3] || String(Date.now());

const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(resultsDir, { recursive: true });

const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');

function now() {
  return process.hrtime.bigint();
}
function msSince(start) {
  return Number(now() - start) / 1e6;
}

async function step(label, fn) {
  const start = now();
  let ok = true, error = null, extra = null;
  try {
    extra = await fn();
  } catch (e) {
    ok = false;
    error = e.message?.slice(0, 300) || String(e);
  }
  const ms = msSince(start);
  return { label, ms: Math.round(ms), ok, error, extra };
}

// Decodes the middle (payload) segment of a standard three-part JWT. The token issued by
// POST api/auth/login carries the caller's numeric id in a claim literally named "UserId"
// (see src/Infrastructure/Authentication/TokenProvider.cs / ClaimsPrincipalExtensions.cs in
// FlexForce_BE) - decoding it here avoids ever having to guess/hardcode a userId.
function decodeJwtUserId(token) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(`Token does not look like a 3-part JWT (got ${parts.length} parts).`);
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  const userId = Number(payload.UserId);
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error(`Could not find a positive numeric "UserId" claim in the decoded JWT payload: ${JSON.stringify(payload)}`);
  }
  return userId;
}

async function loginAndGetToken(browser, user, flow) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  flow.push(await step('Page Load - Sign In page', async () => {
    await page.goto(`${creds.baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: 'User Name' }).waitFor({ state: 'visible' });
  }));

  let loginObserved = null;
  flow.push(await step('Login (API response)', async () => {
    const respPromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes('apidemo'),
    );
    await page.getByRole('textbox', { name: 'User Name' }).fill(user.username);
    await page.locator('input[type="password"]').fill(user.password);
    await page.getByRole('button', { name: 'Sign In' }).click();
    const resp = await respPromise;
    loginObserved = { method: resp.request().method(), url: resp.url(), status: resp.status() };
    return loginObserved;
  }));

  flow.push(await step('Post-login redirect/home render', async () => {
    await page.locator('#header-action-user > div > div > svg').waitFor({ state: 'visible', timeout: 20000 });
  }));

  const token = await page.evaluate(() => {
    const admin = JSON.parse(localStorage.getItem('admin'));
    const auth = JSON.parse(admin.auth);
    return auth.session.token;
  });

  await context.close();
  return token;
}

// previousRole carries the prior role's own userId forward so the second (and later) role's
// cross-user check can use a genuinely different ROLE's real userId, as requested. The very
// first role processed has no earlier role to borrow from, so its cross-user check instead
// uses its own freshly-registered throwaway account's id - still a real, empirically-obtained
// id that is provably not the caller's own, which is all the authorization branch cares about.
let previousRole = null;

async function measureAuthApi(browser, user) {
  console.log(`\n########## ${user.role} (${user.username}) [Auth API] ##########`);
  const flow = [];
  const notes = [];
  let apiCtx = null;
  let selfUserId = null;
  let ownThrowawayUserId = null;

  try {
    const token = await loginAndGetToken(browser, user, flow);
    selfUserId = decodeJwtUserId(token);
    notes.push(`Decoded own userId from JWT payload: ${selfUserId}`);

    apiCtx = await request.newContext({
      baseURL: API_BASE_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    // ===================== API: POST api/auth/register (throwaway account) =====================
    const throwawayEmail = `perf-auth-${user.role.toLowerCase()}-${Date.now()}@test.com`;
    flow.push(await step('API: POST api/auth/register', async () => {
      const res = await apiCtx.post('/api/auth/register', {
        data: { email: throwawayEmail, password: 'User@1234' },
      });
      const status = res.status();
      const body = await res.text();
      if (status >= 200 && status < 300) {
        try {
          const parsed = JSON.parse(body);
          ownThrowawayUserId = Number.isFinite(parsed) ? parsed : null;
        } catch { /* not JSON */ }
      }
      return { status, url: res.url(), body: body?.slice(0, 300) || null, throwawayEmail, registeredUserId: ownThrowawayUserId };
    }));
    if (!ownThrowawayUserId) {
      notes.push('Register step did not return a usable numeric userId - cross-user/delete steps below will fall back or be skipped for this role.');
    }

    // A real, different-from-self userId for the cross-user authorization check below.
    const crossCheckUserId = previousRole ? previousRole.selfUserId : ownThrowawayUserId;
    const crossCheckSource = previousRole
      ? `previous role's (${previousRole.role}) own userId`
      : "this role's own freshly-registered throwaway account (no earlier role available yet)";

    // ===================== API: GET api/auth/{userId} - self (expect success) =====================
    flow.push(await step('GET auth/{userId} - self', async () => {
      const res = await apiCtx.get(`/api/auth/${selfUserId}`);
      const status = res.status();
      const body = await res.text();
      return { status, url: res.url(), body: body?.slice(0, 300) || null };
    }));

    // ===================== API: GET api/auth/{userId} - cross-user (expect rejection) =====================
    flow.push(await step('GET auth/{userId} - cross-user (expect rejection)', async () => {
      if (!crossCheckUserId) {
        throw new Error('No cross-check userId available (neither previous role nor own throwaway registration produced one).');
      }
      const res = await apiCtx.get(`/api/auth/${crossCheckUserId}`);
      const status = res.status();
      const body = await res.text();
      return { status, url: res.url(), body: body?.slice(0, 300) || null, crossCheckUserId, crossCheckSource };
    }));
    notes.push(`Cross-user check target userId ${crossCheckUserId} sourced from: ${crossCheckSource}. GetUserByIdQueryHandler only allows query.UserId === caller's own UserId, so a non-2xx/Unauthorized-shaped response here is the EXPECTED, correct behavior - not a script failure.`);

    // ===================== API: POST api/auth/request-password-reset =====================
    // Anonymous endpoint - measuring the request itself only. Using this role's own real
    // account email; this only sends a reset email, it never completes/consumes a reset, so
    // it cannot lock the shared account out.
    flow.push(await step('API: POST api/auth/request-password-reset', async () => {
      const res = await apiCtx.post('/api/auth/request-password-reset', {
        data: { email: user.username },
      });
      const status = res.status();
      const body = await res.text();
      return { status, url: res.url(), body: body?.slice(0, 300) || null };
    }));

    // ===================== API: GET api/auth/validate/{token} (fake token) =====================
    // Anonymous endpoint. A fake token is expected to 404/400 - that is expected data, not a
    // script failure, so we record the status/body but never throw on a non-2xx here.
    flow.push(await step('GET api/auth/validate/{token} (fake token, expect 404/400)', async () => {
      const fakeToken = `perf-fake-reset-token-${Date.now()}`;
      const res = await apiCtx.get(`/api/auth/validate/${fakeToken}`);
      const status = res.status();
      const body = await res.text();
      return { status, url: res.url(), body: body?.slice(0, 300) || null };
    }));

  } catch (e) {
    notes.push(`Fatal error during measurement: ${e.message}`);
    console.log('FATAL for', user.role, e.message);
  } finally {
    // ===================== Cleanup: DELETE the throwaway account this role registered =====================
    // Wrapped in finally so cleanup always runs even if an earlier step threw. Only ever
    // targets ownThrowawayUserId (the account THIS role's own register step created) - never
    // crossCheckUserId, which for the second+ role is a real named test account's id and must
    // never be deleted (DeleteUserCommandHandler has no self-only check - it will delete
    // whatever id it is given as long as the caller is authenticated at all).
    let deleteConfirmed = false;
    if (apiCtx) {
      flow.push(await step('API: DELETE api/auth/delete-user/{userId} (cleanup throwaway account)', async () => {
        if (!ownThrowawayUserId) {
          return { skipped: true, reason: 'No throwaway userId to clean up (register step did not return one).' };
        }
        const res = await apiCtx.delete(`/api/auth/delete-user/${ownThrowawayUserId}`);
        const status = res.status();
        const body = await res.text();
        // Confirmed live shape: { message, status, isSuccess, data } where data is the bool
        // result of DeleteUserCommandHandler - NOT a bare boolean body, so parse the envelope
        // and check its "data"/"isSuccess" fields rather than comparing the whole parse to true.
        try {
          const parsed = JSON.parse(body);
          deleteConfirmed = status >= 200 && status < 300 && (parsed?.data === true || parsed?.isSuccess === true);
        } catch { /* not JSON */ }
        return { status, url: res.url(), body: body?.slice(0, 300) || null, deleteConfirmed };
      }));
      if (ownThrowawayUserId) {
        notes.push(deleteConfirmed
          ? `Confirmed: DELETE of throwaway userId ${ownThrowawayUserId} returned 2xx with body "true".`
          : `WARNING: could not confirm deletion of throwaway userId ${ownThrowawayUserId} succeeded - check the DELETE step's status/body above.`);
      }

      // ===================== API: POST api/auth/logout (MUST be last - invalidates the token) =====================
      flow.push(await step('API: POST api/auth/logout', async () => {
        const res = await apiCtx.post('/api/auth/logout');
        const status = res.status();
        const body = await res.text();
        return { status, url: res.url(), body: body?.slice(0, 300) || null };
      }));

      await apiCtx.dispose().catch(() => {});
    }
  }

  if (selfUserId) {
    previousRole = { role: user.role, selfUserId };
  }

  return { role: user.role, username: user.username, flow, notes };
}

async function measureLanguagesApi() {
  console.log(`\n########## Languages API (anonymous, no login) ##########`);
  const flow = [];
  const notes = ['All four steps below are anonymous GET endpoints - no login/browser flow needed at all.'];
  const anonCtx = await request.newContext({ baseURL: API_BASE_URL });
  let languageId = null;

  try {
    flow.push(await step('API: GET api/languages', async () => {
      const res = await anonCtx.get('/api/languages');
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      if (Array.isArray(json) && json.length > 0) {
        languageId = json[0].languageId;
      }
      return { status, url: res.url(), count: Array.isArray(json) ? json.length : null, discoveredLanguageId: languageId };
    }));
    if (!languageId) {
      notes.push('Could not discover a real LanguageId from GET api/languages - the three token endpoints below will be called without LanguageId and are expected to 400 (LanguageErrors.EmptyLanguage), which is a validation-path measurement rather than the success path.');
    }

    // GetSignInTokensByLanguageIdQueryHandler (and the Reset/Forgot equivalents) require a
    // non-null LanguageId - without one they short-circuit to a 400 (LanguageErrors.EmptyLanguage)
    // before ever touching the DB. Passing the real LanguageId discovered above exercises the
    // actual success path (DB lookup + token list) instead of just the validation failure.
    flow.push(await step('API: GET api/languages/getForgotPasswordPageTokens', async () => {
      const res = await anonCtx.get('/api/languages/getForgotPasswordPageTokens', { params: languageId ? { LanguageId: languageId } : {} });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      return { status, url: res.url(), count: Array.isArray(json) ? json.length : null };
    }));

    flow.push(await step('API: GET api/languages/getResetPasswordPageTokens', async () => {
      const res = await anonCtx.get('/api/languages/getResetPasswordPageTokens', { params: languageId ? { LanguageId: languageId } : {} });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      return { status, url: res.url(), count: Array.isArray(json) ? json.length : null };
    }));

    flow.push(await step('API: GET api/languages/getSignInPageTokens', async () => {
      const res = await anonCtx.get('/api/languages/getSignInPageTokens', { params: languageId ? { LanguageId: languageId } : {} });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      return { status, url: res.url(), count: Array.isArray(json) ? json.length : null };
    }));
  } catch (e) {
    notes.push(`Fatal error during measurement: ${e.message}`);
    console.log('FATAL for Languages API', e.message);
  } finally {
    await anonCtx.dispose().catch(() => {});
  }

  return { role: 'N/A (anonymous)', username: null, flow, notes };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const roleFilter = process.env.ROLE_FILTER ? process.env.ROLE_FILTER.split(',') : ['Root', 'Admin'];
  const usersToRun = creds.users.filter(u => roleFilter.includes(u.role));
  const results = [];

  // Languages pass first: anonymous, doesn't touch the login rate limiter at all.
  results.push(await measureLanguagesApi());
  console.log(JSON.stringify(results[results.length - 1], null, 2));

  // Each role below performs exactly ONE login. With only Root/Admin (2 logins total, well
  // under the 5/minute login rate limit) no extra pacing delay is needed, but a short pause
  // is added anyway between roles as a courtesy margin since this hits a real shared IT env.
  for (let i = 0; i < usersToRun.length; i++) {
    if (i > 0) {
      await new Promise(r => setTimeout(r, 3000));
    }
    const r = await measureAuthApi(browser, usersToRun[i]);
    results.push(r);
    console.log(JSON.stringify(r, null, 2));
  }
  await browser.close();

  const output = {
    runLabel: RUN_LABEL,
    runTimestamp: RUN_TS,
    baseUrl: creds.baseUrl,
    module: 'Auths + Languages',
    results,
  };
  const outPath = path.join(resultsDir, `${RUN_LABEL}-${RUN_TS}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n\nSaved results to ${outPath}`);
})();
