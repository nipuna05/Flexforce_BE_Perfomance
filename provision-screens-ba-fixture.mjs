import { chromium, request } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Deliberate, on-demand fixture provisioning for measure-screens-api.mjs — NOT run
// automatically by any measure-*.mjs script, and NOT triggered automatically by
// check-screens-fixture.mjs. Run this by hand only after check-screens-fixture.mjs
// reports FAIL.
//
// Background: the original fixture (BA 185, 228 — both children of the old LicId 110,
// see the LIC hierarchy findings) is gone. Rather than create yet more throwaway data,
// this reuses the 2 BA rows (431, 432) already seeded under the new Client 1585 by
// provision-lic-fixture.mjs on 7 Sep 2026 — no ownership needed for BA_ID_FALLBACK, and
// this script adds the one missing piece: a real BA_Users membership row for
// baperform@gmail.com on BA 432, via POST businessAdministration/users (confirmed shape
// from reading UsersToBusinessAdministration.cs / SetUsersToBACommandHandler.cs directly).
// That call is idempotent — safe to run more than once, no duplicate row, no error.
//
// Usage: node provision-screens-ba-fixture.mjs

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '.credentials.local.json'), 'utf-8'));
const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');
const rootUser = creds.users.find((u) => u.role === 'Root');
const baUser = creds.users.find((u) => u.role === 'BA');

const BA_ID_FALLBACK = 431;
const BA_ROLE_OWN_BA_ID = 432;

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
  console.log('Provisioning Screens BA_Users membership —', new Date().toISOString().slice(0, 10));
  console.log(`Reusing existing BA rows: BA_ID_FALLBACK=${BA_ID_FALLBACK}, BA_ROLE_OWN_BA_ID=${BA_ROLE_OWN_BA_ID}\n`);

  const rootToken = await loginAndGetToken(rootUser);
  const apiCtx = await request.newContext({ baseURL: API_BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${rootToken}` } });

  // Confirm both BA rows still exist before touching anything.
  const dtsRes = await apiCtx.get('/api/businessAdministration/Dts', { params: { baid: BA_ID_FALLBACK } });
  if (dtsRes.status() === 404) {
    console.error(`FATAL: BA_ID_FALLBACK=${BA_ID_FALLBACK} no longer exists — cannot proceed. Provision a fresh BA row first.`);
    await apiCtx.dispose();
    process.exit(1);
  }
  console.log(`  Confirmed BA_ID_FALLBACK=${BA_ID_FALLBACK} still exists.`);

  const dtsRes2 = await apiCtx.get('/api/businessAdministration/Dts', { params: { baid: BA_ROLE_OWN_BA_ID } });
  if (dtsRes2.status() === 404) {
    console.error(`FATAL: BA_ROLE_OWN_BA_ID=${BA_ROLE_OWN_BA_ID} no longer exists — cannot proceed. Provision a fresh BA row first.`);
    await apiCtx.dispose();
    process.exit(1);
  }
  console.log(`  Confirmed BA_ROLE_OWN_BA_ID=${BA_ROLE_OWN_BA_ID} still exists.`);

  // Create the membership row (idempotent). Body is camelCase — confirmed against every
  // other endpoint in this codebase (default ASP.NET Core minimal-API JSON policy), not
  // the PascalCase C# record property names (UsersToBARequest.BusinessAdministrationId).
  const addRes = await apiCtx.post('/api/businessAdministration/users', {
    data: { userList: [{ businessAdministrationId: BA_ROLE_OWN_BA_ID, userAccount: baUser.username }] },
  });
  const addStatus = addRes.status();
  const addBody = await addRes.text();
  console.log(`  POST businessAdministration/users — status ${addStatus}, body: ${addBody.slice(0, 300)}`);
  if (addStatus < 200 || addStatus >= 300) {
    console.error('FATAL: could not create the BA_Users membership row.');
    await apiCtx.dispose();
    process.exit(1);
  }

  // Verify it actually landed.
  const verifyRes = await apiCtx.post('/api/businessAdministration/users/grid', {
    data: { baId: BA_ROLE_OWN_BA_ID, gridRequest: { page: 1, pageSize: 50 } },
  });
  const verifyJson = await verifyRes.json().catch(() => null);
  const found = verifyJson?.data?.some?.((row) => row.userName === baUser.username);
  console.log(`  Verify via GetBaUsers: ${found ? 'OK — membership confirmed' : 'FAIL — membership not found'}, body: ${JSON.stringify(verifyJson)?.slice(0, 250)}`);

  console.log('\n=== Update these constants by hand and commit the change ===');
  console.log(`  measure-screens-api.mjs:  const BA_ID_FALLBACK = ${BA_ID_FALLBACK};`);
  console.log(`  measure-screens-api.mjs:  const BA_ROLE_OWN_BA_ID = ${BA_ROLE_OWN_BA_ID};`);

  await apiCtx.dispose();
  process.exit(found ? 0 : 1);
})();
