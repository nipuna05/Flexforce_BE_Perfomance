import { chromium, request } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '.credentials.local.json'), 'utf-8'));
const RUN_LABEL = process.argv[2] || 'ba-grid-before-release';
const RUN_TS = process.argv[3] || String(Date.now());

const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(resultsDir, { recursive: true });

const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');

// Confirmed live on IT (see discover-client-licid.mjs): licId=110 ("Gas Client") is a real
// Client-tier (LicType.Order=4) node under Admin(104) -> Distributor(106) -> Partner(109) ->
// Client(110), and already has 2 BA rows (one owned by the baperform@gmail.com test account),
// so the grid steps below measure a non-empty, realistic result rather than an empty page.
const LIC_ID = 110;

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

async function measureBaGridApi(browser, user) {
  console.log(`\n########## ${user.role} (${user.username}) [BA Grid API] ##########`);
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

    await context.close();

    apiCtx = await request.newContext({
      baseURL: API_BASE_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    // ===================== API: POST api/businessAdministration/grid (default page) =====================
    flow.push(await step('API: POST businessAdministration/grid (page 1, size 20)', async () => {
      const res = await apiCtx.post('/api/businessAdministration/grid', {
        data: {
          licId: LIC_ID,
          gridRequest: { page: 1, pageSize: 20, sortBy: 'businessAdministrationName', sortDir: 'asc', filters: [], columns: ['businessAdministrationId', 'businessAdministrationName', 'firstUserEmail'] },
        },
      });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      return { status, url: res.url(), totalCount: json?.totalCount, dataLength: json?.data?.length };
    }));

    // ===================== API: POST api/businessAdministration/grid (larger page, search+filter) =====================
    flow.push(await step('API: POST businessAdministration/grid (page 1, size 100, search)', async () => {
      const res = await apiCtx.post('/api/businessAdministration/grid', {
        data: {
          licId: LIC_ID,
          gridRequest: { page: 1, pageSize: 100, sortBy: 'businessAdministrationName', sortDir: 'asc', search: 'a', filters: [], columns: ['businessAdministrationId', 'businessAdministrationName', 'firstUserEmail'] },
        },
      });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      return { status, url: res.url(), totalCount: json?.totalCount, dataLength: json?.data?.length };
    }));

    // ===================== Create/Update/Delete cycle on a throwaway BA =====================
    // Wrapped so DELETE cleanup always runs (finally), even if update throws, to avoid
    // orphaned BA rows piling up under the shared LIC_ID used for testing.
    let createdBaId = null;
    try {
      const throwawayName = `perf-ba-${Date.now()}`;
      flow.push(await step('API: POST businessAdministration (create)', async () => {
        const res = await apiCtx.post('/api/businessAdministration', {
          data: { businessAdministrationName: throwawayName, licId: LIC_ID, baId: 0 },
        });
        const status = res.status();
        let body = null;
        try { body = await res.text(); } catch { /* ignore */ }
        if (status >= 200 && status < 300) {
          try {
            const parsedBody = JSON.parse(body);
            createdBaId = Number.isFinite(parsedBody?.data) ? parsedBody.data : null;
          } catch { /* not JSON */ }
        }
        return { status, url: res.url(), body: body?.slice(0, 300) || null, createdBaId };
      }));
      if (!createdBaId) {
        notes.push('Create step did not return a usable BA id — update/delete steps below will be skipped for this role.');
      }

      flow.push(await step('API: POST businessAdministration (update)', async () => {
        if (!createdBaId) {
          throw new Error('No BA id from create step — cannot exercise update.');
        }
        const res = await apiCtx.post('/api/businessAdministration', {
          data: { businessAdministrationName: `${throwawayName}-upd`, licId: LIC_ID, baId: createdBaId },
        });
        const status = res.status();
        let body = null;
        try { body = await res.text(); } catch { /* ignore */ }
        return { status, url: res.url(), body: body?.slice(0, 300) || null };
      }));
    } finally {
      flow.push(await step('API: DELETE businessAdministration/{baId} (cleanup)', async () => {
        if (!createdBaId) {
          return { skipped: true, reason: 'No BA id to clean up (create step did not return one).' };
        }
        const res = await apiCtx.delete(`/api/businessAdministration/${createdBaId}`);
        return { status: res.status(), url: res.url() };
      }));
    }

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
  const roleFilter = process.env.ROLE_FILTER ? process.env.ROLE_FILTER.split(',') : ['Root', 'Admin', 'BA'];
  const usersToRun = creds.users.filter(u => roleFilter.includes(u.role));
  const results = [];
  for (const user of usersToRun) {
    const r = await measureBaGridApi(browser, user);
    results.push(r);
    console.log(JSON.stringify(r, null, 2));
  }
  await browser.close();

  const output = {
    runLabel: RUN_LABEL,
    runTimestamp: RUN_TS,
    baseUrl: creds.baseUrl,
    module: 'Business Administration (BA) Grid',
    results,
  };
  const outPath = path.join(resultsDir, `${RUN_LABEL}-${RUN_TS}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n\nSaved results to ${outPath}`);
})();
