import { chromium, request } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Pre-flight check: verifies the hardcoded BA fixture that measure-screens-api.mjs depends
// on (BA_ID_FALLBACK, BA_ROLE_OWN_BA_ID) still resolves on IT, BEFORE running the timed
// suite. Mirrors check-lic-fixture.mjs's role for the LIC hierarchy — same shared-IT-env
// disappearance risk applies to any hardcoded test fixture, not just LIC nodes.
//
// Read-only. Creates nothing, deletes nothing, does not touch measure-screens-api.mjs.
// Exit code 0 = fixture intact, safe to run the timed suite.
// Exit code 1 = fixture missing/broken - do not run the timed suite yet.
//
// Usage: node check-screens-fixture.mjs

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '.credentials.local.json'), 'utf-8'));
const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');
const rootUser = creds.users.find((u) => u.role === 'Root');

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
  const token = await loginAndGetToken(rootUser);
  const apiCtx = await request.newContext({ baseURL: API_BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

  console.log('Screens BA fixture pre-flight check — ' + new Date().toISOString().slice(0, 10));

  let allOk = true;

  // BA_ID_FALLBACK just needs to exist (GetBaDts has no ownership check).
  const dtsRes = await apiCtx.get('/api/businessAdministration/Dts', { params: { baid: BA_ID_FALLBACK } });
  const dtsOk = dtsRes.status() !== 404;
  if (!dtsOk) allOk = false;
  console.log(`  ${dtsOk ? 'OK  ' : 'FAIL'}  BA_ID_FALLBACK=${BA_ID_FALLBACK} exists (GetBaDts) — status ${dtsRes.status()}`);

  // BA_ROLE_OWN_BA_ID needs a real BA_Users membership for baperform@gmail.com — checked
  // via GetBaUsers rather than logging in as BA (keeps this check to a single login).
  // Confirmed shape (GetBaUsers.cs / GetBaUsersQuery.cs): POST users/grid, {baId, gridRequest},
  // response rows shaped {userId, userName} (sp_GetBaUsers columns), no ownership check on caller.
  const usersRes = await apiCtx.post('/api/businessAdministration/users/grid', {
    data: { baId: BA_ROLE_OWN_BA_ID, gridRequest: { page: 1, pageSize: 50 } },
  });
  const usersJson = await usersRes.json().catch(() => null);
  const baUser = creds.users.find((u) => u.role === 'BA');
  const membershipOk = usersRes.status() === 200 && usersJson?.data?.some?.((row) => row.userName === baUser.username);
  if (!membershipOk) allOk = false;
  console.log(`  ${membershipOk ? 'OK  ' : 'FAIL'}  ${baUser.username} is a member of BA_ROLE_OWN_BA_ID=${BA_ROLE_OWN_BA_ID} — status ${usersRes.status()}, body: ${JSON.stringify(usersJson)?.slice(0, 250)}`);

  console.log();
  if (allOk) {
    console.log('Fixture intact. Safe to run measure-screens-api.mjs.');
  } else {
    console.log('Fixture broken — do NOT run the timed suite yet. Provision a replacement first (provision-screens-ba-fixture.mjs).');
  }

  await apiCtx.dispose();
  process.exit(allOk ? 0 : 1);
})();
