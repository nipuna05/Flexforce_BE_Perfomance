import { chromium, request } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Pre-flight check: verifies the hardcoded LIC hierarchy that measure-ba-grid-api.mjs
// and measure-lic-api.mjs depend on (Admin 1582 -> Distributor 1583 -> Partner 1584 ->
// Client 1585, provisioned 7 Sep 2026 via provision-lic-fixture.mjs after the original
// Admin 104 -> ... -> Client 110 fixture disappeared from IT) still resolves, BEFORE
// running either ~13-minute timed suite.
//
// Read-only. Creates nothing, deletes nothing, does not touch measure-*.mjs.
// Exit code 0 = fixture intact, safe to run the timed suites.
// Exit code 1 = fixture missing/broken - do not run the timed suites; the results
// would be 404-timing noise, not real performance data (see 7 Sep finding).
//
// Usage: node check-lic-fixture.mjs

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '.credentials.local.json'), 'utf-8'));
const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');
const rootUser = creds.users.find((u) => u.role === 'Root');

const FIXTURE = [
  { licId: 1582, label: 'Admin (provisioned 7 Sep 2026)' },
  { licId: 1583, label: 'Distributor (provisioned 7 Sep 2026)' },
  { licId: 1584, label: 'Partner (provisioned 7 Sep 2026)' },
  { licId: 1585, label: 'Client (provisioned 7 Sep 2026, 2 BA rows — used by measure-ba-grid-api.mjs)' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${creds.baseUrl}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'User Name' }).waitFor({ state: 'visible' });
  const respPromise = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('apidemo'));
  await page.getByRole('textbox', { name: 'User Name' }).fill(rootUser.username);
  await page.locator('input[type="password"]').fill(rootUser.password);
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

  const apiCtx = await request.newContext({ baseURL: API_BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

  console.log('LIC fixture pre-flight check — ' + new Date().toISOString().slice(0, 10));
  console.log('Verifying each node resolves via GET license-mgt/license?contractId=0&licId={id}\n');

  let allOk = true;
  for (const { licId, label } of FIXTURE) {
    const res = await apiCtx.get(`/api/license-mgt/license?contractId=0&licId=${licId}`);
    const status = res.status();
    // 404 here means the node itself doesn't resolve. Any other status (200, or even
    // a different 4xx from license-specific logic) means the node exists.
    const ok = status !== 404;
    if (!ok) allOk = false;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  licId ${licId} (${label}) — status ${status}`);
  }

  console.log();
  if (allOk) {
    console.log('Fixture intact. Safe to run measure-ba-grid-api.mjs / measure-lic-api.mjs.');
  } else {
    console.log('Fixture broken — do NOT run the timed suites yet. Results would be 404-timing');
    console.log('noise, not real performance data. Provision a replacement fixture first.');
  }

  await apiCtx.dispose();
  process.exit(allOk ? 0 : 1);
})();
