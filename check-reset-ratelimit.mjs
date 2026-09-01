import { request } from 'playwright';
import fs from 'fs';
const creds = JSON.parse(fs.readFileSync('.credentials.local.json', 'utf-8'));
const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');

(async () => {
  const apiCtx = await request.newContext({ baseURL: API_BASE_URL });
  console.log('Firing 10x POST api/auth/request-password-reset in a tight loop (no auth, no delay)...');
  for (let i = 0; i < 10; i++) {
    const res = await apiCtx.post('/api/auth/request-password-reset', {
      data: { email: 'baperform@gmail.com' },
    });
    console.log(`  #${i + 1}: status ${res.status()}`);
  }
  console.log('\nFiring 10x POST api/auth/register (throwaway unique emails) in a tight loop...');
  const createdIds = [];
  for (let i = 0; i < 10; i++) {
    const email = `perf-ratelimit-check-${Date.now()}-${i}@test.com`;
    const res = await apiCtx.post('/api/auth/register', {
      data: { email, password: 'User@1234' },
    });
    const status = res.status();
    let id = null;
    if (status >= 200 && status < 300) {
      const body = await res.text();
      const parsed = Number(body);
      if (Number.isFinite(parsed)) id = parsed;
    }
    console.log(`  #${i + 1}: status ${status}${id ? ` (userId ${id})` : ''}`);
    if (id) createdIds.push(id);
  }

  // Cleanup: delete-user requires auth. Log in as Root to clean up the throwaway accounts.
  if (createdIds.length) {
    const { chromium } = await import('playwright');
    const rootUser = creds.users.find(u => u.role === 'Root');
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
    const authedCtx = await request.newContext({ baseURL: API_BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    console.log(`\nCleaning up ${createdIds.length} throwaway account(s)...`);
    for (const id of createdIds) {
      const res = await authedCtx.delete(`/api/auth/delete-user/${id}`);
      console.log(`  delete-user/${id}: status ${res.status()}`);
    }
    await authedCtx.dispose();
  }

  await apiCtx.dispose();
})();
