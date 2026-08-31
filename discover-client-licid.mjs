import { chromium, request } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '.credentials.local.json'), 'utf-8'));
const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');
const roleArg = process.argv[2] || 'Admin';
const rootUser = creds.users.find(u => u.role === roleArg);

// DTS tree for the License_Management module (MmsId=180), read live from
// GET /api/screen/dts?mmsId=180: Admin_List(452) -> Distributor_List(456) ->
// Partner_List(460) -> Client_List(464) -> BA_List(468). Each level's grid must be
// queried with ITS OWN StartedDtsId (not a single shared one) plus the parent's licId.
const LEVELS = [
  { name: 'Admin_List', dtsId: 452 },
  { name: 'Distributor_List', dtsId: 456 },
  { name: 'Partner_List', dtsId: 460 },
  { name: 'Client_List', dtsId: 464 },
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

  const apiCtx = await request.newContext({ baseURL: API_BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

  async function getLevel(startedDtsId, parentLicId) {
    const res = await apiCtx.post('/api/license-mgt/grid', {
      data: { startedDtsId, parentLicId, gridRequest: { page: 1, pageSize: 50 } },
    });
    const status = res.status();
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    return { status, json };
  }

  let parentLicId = null;
  const path_ = [];
  for (const level of LEVELS) {
    const { status, json } = await getLevel(level.dtsId, parentLicId);
    console.log(`\n${level.name} (dtsId=${level.dtsId}, parentLicId=${parentLicId}) -> status=${status} rows=${json?.data?.length}`);
    console.log('  all rows:', JSON.stringify(json?.data));
    if (status !== 200 || !json?.data?.length) {
      console.log(`No rows at ${level.name} — stopping here.`);
      break;
    }
    const node = json.data[0];
    path_.push({ level: level.name, node });
    parentLicId = node.licId;
  }

  console.log('\n\n=== Path walked ===');
  console.log(JSON.stringify(path_, null, 2));

  if (path_.length === LEVELS.length) {
    const clientLicId = path_[path_.length - 1].node.licId;
    console.log(`\nReached Client_List — testing businessAdministration/grid with licId=${clientLicId}`);
    const gridCheck = await apiCtx.post('/api/businessAdministration/grid', {
      data: { licId: clientLicId, gridRequest: { page: 1, pageSize: 20 } },
    });
    console.log('businessAdministration/grid status:', gridCheck.status());
    console.log('body:', (await gridCheck.text()).slice(0, 1000));
  }

  await apiCtx.dispose();
  await browser.close();
})();
