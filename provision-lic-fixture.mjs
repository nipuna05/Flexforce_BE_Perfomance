import { chromium, request } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Deliberate, on-demand fixture provisioning — NOT run automatically by any measure-*.mjs
// script, and NOT triggered automatically by check-lic-fixture.mjs. Run this by hand only
// after confirming (via check-lic-fixture.mjs) that the old Admin 104 -> Distributor 106
// -> Partner 109 -> Client 110 hierarchy is genuinely gone.
//
// Creates a full replacement hierarchy — Admin -> Distributor -> Partner -> Client, seeded
// with 2 BA rows under the Client — so the new fixture is realistically populated like the
// old one was, not an empty node (an empty node would make grid-list timings measure a
// different, easier case than what this suite has tracked since 31 Aug).
//
// Prints the new IDs. Updating LIC_ID / ADMIN_LIC_ID / PARTNER_LIC_ID in measure-ba-grid-api.mjs
// and measure-lic-api.mjs stays a separate, manual step — reviewed and committed like any
// other code change, not auto-applied by this script.
//
// Usage: node provision-lic-fixture.mjs

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '.credentials.local.json'), 'utf-8'));
const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');
const rootUser = creds.users.find((u) => u.role === 'Root');
const baUser = creds.users.find((u) => u.role === 'BA');

const DTS_IDS = { admin: 452, distributor: 456, partner: 460, client: 464 };
const TIER_NAMES = ['admin', 'distributor', 'partner', 'client'];

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
  console.log('Provisioning a replacement LIC fixture (Root-bypass creation) —', new Date().toISOString().slice(0, 10));
  console.log('This creates real, permanent data on IT. Ctrl+C now to abort.\n');

  const rootToken = await loginAndGetToken(rootUser);
  const apiCtx = await request.newContext({ baseURL: API_BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${rootToken}` } });

  // Step 1: discover the licTypeId for each tier via its DTS id.
  const licTypeIds = {};
  for (const tier of TIER_NAMES) {
    const res = await apiCtx.get(`/api/license-mgt/lic-type?startedDtsId=${DTS_IDS[tier]}`);
    const json = await res.json().catch(() => null);
    if (res.status() !== 200 || !Number.isFinite(json?.licTypeId)) {
      console.error(`FATAL: could not discover licTypeId for ${tier} (dtsId=${DTS_IDS[tier]}) — status ${res.status()}`);
      await apiCtx.dispose();
      process.exit(1);
    }
    licTypeIds[tier] = json.licTypeId;
    console.log(`  ${tier} licTypeId = ${json.licTypeId}`);
  }

  // Step 2: create the chain, each node parented to the previous.
  const ids = {};
  let parentId = null;
  for (const tier of TIER_NAMES) {
    const res = await apiCtx.post('/api/license-mgt', { data: { typeId: licTypeIds[tier], parentId } });
    const status = res.status();
    const json = await res.json().catch(() => null);
    if (status < 200 || status >= 300 || !Number.isFinite(json?.data?.licId)) {
      console.error(`FATAL: failed to create ${tier} node (parentId=${parentId}) — status ${status}, body: ${JSON.stringify(json)}`);
      console.error('Nodes created so far (not rolled back — clean up manually if needed):', JSON.stringify(ids));
      await apiCtx.dispose();
      process.exit(1);
    }
    console.log(`  Created ${tier}: licId ${json.data.licId} (parent ${parentId ?? 'null'})`);
    ids[tier] = json.data.licId;
    parentId = json.data.licId;
  }

  // Step 3: seed 2 BA rows under the new Client, as the old fixture had.
  const baIds = [];
  for (let i = 0; i < 2; i++) {
    const res = await apiCtx.post('/api/businessAdministration', {
      data: { businessAdministrationName: `perf-fixture-ba-${Date.now()}-${i}`, licId: ids.client, baId: 0 },
    });
    const status = res.status();
    const body = await res.text();
    let createdBaId = null;
    try { createdBaId = JSON.parse(body)?.data; } catch { /* not JSON */ }
    if (status < 200 || status >= 300 || !Number.isFinite(createdBaId)) {
      console.error(`WARNING: failed to seed BA row ${i} under client ${ids.client} — status ${status}, body: ${body}`);
      continue;
    }
    baIds.push(createdBaId);
    console.log(`  Seeded BA row: baId ${createdBaId} under client ${ids.client}`);
  }

  console.log('\n=== New fixture — update these constants by hand and commit the change ===');
  console.log(`  measure-lic-api.mjs:      const ADMIN_LIC_ID = ${ids.admin};`);
  console.log(`  measure-lic-api.mjs:      const PARTNER_LIC_ID = ${ids.partner};`);
  console.log(`  measure-ba-grid-api.mjs:  const LIC_ID = ${ids.client};`);
  console.log(`  Full chain: Admin ${ids.admin} -> Distributor ${ids.distributor} -> Partner ${ids.partner} -> Client ${ids.client}`);
  console.log(`  BA rows under Client ${ids.client}: ${baIds.join(', ') || 'none created'}`);
  console.log('\nAlso update check-lic-fixture.mjs\'s FIXTURE array to these new IDs.');

  await apiCtx.dispose();
})();
