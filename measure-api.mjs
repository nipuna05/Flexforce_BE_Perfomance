import { chromium, request } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '.credentials.local.json'), 'utf-8'));
const RUN_LABEL = process.argv[2] || 'before-release';
const RUN_TS = process.argv[3] || String(new Date('2026-07-14T00:00:00Z').getTime());

const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(resultsDir, { recursive: true });

// Derived from creds.baseUrl (hrm2-uidemo2-it -> hrm2-apidemo2-it), matching the UI/API
// host-naming pattern confirmed live elsewhere in this repo (see license-management-page.ts).
const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');

// A real, pre-existing license shared across the perf-testing accounts (same one used by
// try-restore-with-token.mjs / verify-register-then-map.mjs). licType 13 is the confirmed
// shape for the Admin User List mapping (see check-canonical-users-status.mjs / try-restore-*.mjs).
const LIC_ID = 104;
const LIC_TYPE = 13;

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

async function measureUserApi(browser, user) {
  console.log(`\n########## ${user.role} (${user.username}) [API] ##########`);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const flow = [];
  const notes = [];
  let apiCtx = null;

  try {
    // ===================== Page Load - Sign In page =====================
    flow.push(await step('Page Load - Sign In page', async () => {
      await page.goto(`${creds.baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('textbox', { name: 'User Name' }).waitFor({ state: 'visible' });
    }));

    // ===================== Login (API response) =====================
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
    if (loginObserved) {
      notes.push(`Login endpoint observed: ${loginObserved.method} ${loginObserved.url} -> ${loginObserved.status}`);
    } else {
      notes.push('Login endpoint NOT observed — waitForResponse did not resolve (see error on the Login step).');
    }

    // ===================== Post-login redirect/home render =====================
    flow.push(await step('Post-login redirect/home render', async () => {
      await page.locator('#header-action-user > div > div > svg').waitFor({ state: 'visible', timeout: 20000 });
    }));

    // ===================== Extract Bearer token =====================
    const token = await page.evaluate(() => {
      const admin = JSON.parse(localStorage.getItem('admin'));
      const auth = JSON.parse(admin.auth);
      return auth.session.token;
    });

    // Browser no longer needed for the remaining (pure API) steps.
    await context.close();

    apiCtx = await request.newContext({
      baseURL: API_BASE_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    // ===================== API: POST /api/auth/register =====================
    const throwawayEmail = `perf-be-${Date.now()}@test.com`;
    let registeredEmail = null;
    flow.push(await step('API: POST /api/auth/register', async () => {
      const res = await apiCtx.post('/api/auth/register', {
        data: { email: throwawayEmail, password: 'User@1234' },
      });
      const status = res.status();
      if (status >= 200 && status < 300) {
        registeredEmail = throwawayEmail;
      }
      let body = null;
      try { body = await res.text(); } catch { /* ignore */ }
      return { status, url: res.url(), body: body?.slice(0, 300) || null };
    }));
    if (!registeredEmail) {
      notes.push(`Register step did not return a 2xx — subsequent add/update/delete cycle will use "${throwawayEmail}" anyway (endpoint may reject duplicates/rate-limit; this is timing data, not a functional test).`);
      registeredEmail = throwawayEmail;
    }

    // ===================== API: GET /api/license-mgt/lic-type (known-404-elsewhere defect endpoint) =====================
    // NOTE: measure.mjs documents this endpoint 404ing when called with a sub-entity's
    // startedDtsId from the UI's own Add form (a genuine live defect blocking that form).
    // Called directly here with startedDtsId=452 (the top-level License Management dtsId),
    // live testing observed 200 — the defect is specific to child-entity IDs, not this one.
    // Either way: record the status as data, do NOT throw/mark ok:false just because it's a 404.
    flow.push(await step('API: GET /api/license-mgt/lic-type?startedDtsId=452', async () => {
      const res = await apiCtx.get('/api/license-mgt/lic-type?startedDtsId=452');
      const status = res.status();
      let body = null;
      try { body = await res.text(); } catch { /* ignore */ }
      return { status, url: res.url(), body: body?.slice(0, 300) || null, note: status === 404 ? 'Known defect: 404 (see measure.mjs Add-form blocker).' : undefined };
    }));

    // ===================== Add/Update/Delete cycle on a throwaway user =====================
    // Wrapped so DELETE cleanup always runs (finally), even if update throws, to avoid
    // orphaned mapping rows piling up on the shared real license (LIC_ID) used for testing.
    let addedUserId = null;
    try {
      flow.push(await step('API: POST /api/license-mgt/user', async () => {
        const res = await apiCtx.post('/api/license-mgt/user', {
          data: { licId: LIC_ID, licType: LIC_TYPE, userAccount: registeredEmail, isDeleted: false },
        });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        // Confirmed live shape: { status, message, licType, licId, licUserId }.
        addedUserId = json?.licUserId ?? json?.id ?? json?.userId ?? json?.data?.id ?? null;
        return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, userId: addedUserId };
      }));

      // DEVIATION FROM SPEC (adapted after live probing, see repo history / task report):
      // this route was hypothesized to support PUT for toggling isDeleted. Live probing
      // (register -> map -> PUT -> PATCH -> OPTIONS -> delete, on a throwaway account)
      // confirmed the server returns 405 for both PUT and PATCH, and an OPTIONS preflight
      // reports `Allow: DELETE` only — there is NO update/edit endpoint for User List rows
      // on this app at all (matches license-management-page.ts's own comments: User List
      // only ever exposes Add + Delete, never Edit). We still measure it (as timing data,
      // same treatment as the confirmed-defect lic-type 404 below) rather than drop the step,
      // so the report keeps a consistent step count/shape and documents the confirmed 405
      // as expected — not a script bug and not `ok:false`.
      let updateStatus = null;
      flow.push(await step('API: PUT /api/license-mgt/{licId}/users/{userId} (update)', async () => {
        if (!addedUserId) {
          throw new Error('No userId returned from the add step — cannot exercise update.');
        }
        const res = await apiCtx.put(`/api/license-mgt/${LIC_ID}/users/${addedUserId}`, {
          data: { isDeleted: true },
        });
        updateStatus = res.status();
        let body = null;
        try { body = await res.text(); } catch { /* ignore */ }
        return { status: updateStatus, url: res.url(), body: body?.slice(0, 300) || null };
      }));
      if (updateStatus === 405) {
        notes.push('Confirmed live: /api/license-mgt/{licId}/users/{userId} only allows DELETE (OPTIONS preflight Allow header = "DELETE"; PUT and PATCH both 405). No update/edit endpoint exists for User List rows on this app — the 405 recorded above is expected/confirmed behavior, not a failure.');
      }
    } finally {
      flow.push(await step('API: DELETE /api/license-mgt/{licId}/users/{userId} (cleanup)', async () => {
        if (!addedUserId) {
          return { skipped: true, reason: 'No userId to clean up (add step did not return one).' };
        }
        // Confirmed live (license-management-page.ts): this DELETE is bodyless with no
        // query string — there is no client-controllable payload on this request at all.
        const res = await apiCtx.delete(`/api/license-mgt/${LIC_ID}/users/${addedUserId}`);
        const status = res.status();
        return { status, url: res.url() };
      }));
    }

    notes.push('Confirmed endpoint DELETE /api/license-mgt/{licId} intentionally not exercised (destructive — deletes a whole distributor/partner/client shell entity).');

  } catch (e) {
    notes.push(`Fatal error during measurement: ${e.message}`);
    console.log('FATAL for', user.role, e.message);
  } finally {
    if (apiCtx) await apiCtx.dispose().catch(() => {});
    await context.close().catch(() => {});
  }

  return { role: user.role, username: user.username, flow, notes };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const roleFilter = process.env.ROLE_FILTER ? process.env.ROLE_FILTER.split(',') : null;
  const usersToRun = roleFilter ? creds.users.filter(u => roleFilter.includes(u.role)) : creds.users;
  const results = [];
  for (const user of usersToRun) {
    const r = await measureUserApi(browser, user);
    results.push(r);
    console.log(JSON.stringify(r, null, 2));
  }
  await browser.close();

  const output = {
    runLabel: RUN_LABEL,
    runTimestamp: RUN_TS,
    baseUrl: creds.baseUrl,
    results,
  };
  const outPath = path.join(resultsDir, `${RUN_LABEL}-${RUN_TS}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n\nSaved results to ${outPath}`);
})();
