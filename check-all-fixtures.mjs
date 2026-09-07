import { chromium, request } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Combined pre-flight check: runs every hardcoded-fixture check this suite has (LIC
// hierarchy + Screens BA fixture) under a single Root login, before a full suite run.
// One go/no-go instead of remembering to run check-lic-fixture.mjs and
// check-screens-fixture.mjs separately. Those two scripts still exist standalone (useful
// when only one module is being rerun) — this just saves a login when running everything.
//
// Read-only. Creates nothing, deletes nothing, does not touch any measure-*.mjs script.
// Exit code 0 = every fixture intact, safe to run the full suite.
// Exit code 1 = at least one fixture missing/broken - do not run the affected suite(s) yet.
//
// Usage: node check-all-fixtures.mjs

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '.credentials.local.json'), 'utf-8'));
const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');
const rootUser = creds.users.find((u) => u.role === 'Root');
const baUser = creds.users.find((u) => u.role === 'BA');

const LIC_FIXTURE = [
  { licId: 1582, label: 'Admin (provisioned 7 Sep 2026)' },
  { licId: 1583, label: 'Distributor (provisioned 7 Sep 2026)' },
  { licId: 1584, label: 'Partner (provisioned 7 Sep 2026)' },
  { licId: 1585, label: 'Client (provisioned 7 Sep 2026, 2 BA rows — used by measure-ba-grid-api.mjs)' },
];
const SCREENS_BA_ID_FALLBACK = 431;
const SCREENS_BA_ROLE_OWN_BA_ID = 432;

async function loginAndGetToken(user) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${creds.baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'User Name' }).waitFor({ state: 'visible' });
  const respPromise = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('apidemo'));
  await page.getByRole('textbox', { name: 'User Name' }).fill(user.username);
  await page.locator('input[type="password"]').fill(user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await respPromise;
  await page.locator('#header-action-user > div > div > svg').waitFor({ state: 'visible', timeout: 20000 });
  const token = await page.evaluate(() => {
    const admin = JSON.parse(localStorage.getItem('admin'));
    const auth = JSON.parse(admin.auth);
    return auth.session.token;
  });
  await context.close();
  await browser.close();
  return token;
}

(async () => {
  console.log('Combined fixture pre-flight check — ' + new Date().toISOString().slice(0, 10));
  console.log('Single Root login, covers: LIC hierarchy (BA Grid + LIC suites), Screens BA fixture.\n');

  const token = await loginAndGetToken(rootUser);
  const apiCtx = await request.newContext({ baseURL: API_BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

  // ===== LIC hierarchy =====
  console.log('LIC hierarchy (measure-ba-grid-api.mjs / measure-lic-api.mjs):');
  let licOk = true;
  for (const { licId, label } of LIC_FIXTURE) {
    const res = await apiCtx.get('/api/license-mgt/license', { params: { contractId: 0, licId } });
    const status = res.status();
    const ok = status !== 404;
    if (!ok) licOk = false;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  licId ${licId} (${label}) — status ${status}`);
  }

  // ===== Screens BA fixture =====
  console.log('\nScreens BA fixture (measure-screens-api.mjs):');
  let screensOk = true;

  const dtsRes = await apiCtx.get('/api/businessAdministration/Dts', { params: { baid: SCREENS_BA_ID_FALLBACK } });
  const dtsOk = dtsRes.status() !== 404;
  if (!dtsOk) screensOk = false;
  console.log(`  ${dtsOk ? 'OK  ' : 'FAIL'}  BA_ID_FALLBACK=${SCREENS_BA_ID_FALLBACK} exists (GetBaDts) — status ${dtsRes.status()}`);

  const usersRes = await apiCtx.post('/api/businessAdministration/users/grid', {
    data: { baId: SCREENS_BA_ROLE_OWN_BA_ID, gridRequest: { page: 1, pageSize: 50 } },
  });
  const usersJson = await usersRes.json().catch(() => null);
  const membershipOk = usersRes.status() === 200 && usersJson?.data?.some?.((row) => row.userName === baUser.username);
  if (!membershipOk) screensOk = false;
  console.log(`  ${membershipOk ? 'OK  ' : 'FAIL'}  ${baUser.username} is a member of BA_ROLE_OWN_BA_ID=${SCREENS_BA_ROLE_OWN_BA_ID} — status ${usersRes.status()}`);

  // ===== Summary =====
  console.log('\n=== Summary ===');
  console.log(`  LIC hierarchy:      ${licOk ? 'OK — safe to run measure-ba-grid-api.mjs / measure-lic-api.mjs' : 'FAIL — do not run measure-ba-grid-api.mjs / measure-lic-api.mjs yet (provision-lic-fixture.mjs)'}`);
  console.log(`  Screens BA fixture: ${screensOk ? 'OK — safe to run measure-screens-api.mjs' : 'FAIL — do not run measure-screens-api.mjs yet (provision-screens-ba-fixture.mjs)'}`);

  const allOk = licOk && screensOk;
  console.log(`\n${allOk ? 'All fixtures intact. Safe to run the full suite.' : 'At least one fixture is broken — see above before running the affected suite(s).'}`);

  await apiCtx.dispose();
  process.exit(allOk ? 0 : 1);
})();
