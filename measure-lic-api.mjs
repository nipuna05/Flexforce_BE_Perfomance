import { chromium, request } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '.credentials.local.json'), 'utf-8'));
const RUN_LABEL = process.argv[2] || 'lic-baseline';
const RUN_TS = process.argv[3] || String(Date.now());

const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(resultsDir, { recursive: true });

const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');

// Confirmed live on IT (see discover-client-licid.mjs / task notes): a real, non-empty LIC
// hierarchy branch — Admin(104, "Gas Supplier Worldwide") -> Distributor(106, "Gas Supplier -
// USA") -> Partner(109, "Gas Supplier - Canada") -> Client(110, "Gas Client"). Used for all
// read-only grid/lookup calls below. The mutating CreateLIC/CreateLicense cycle deliberately
// does NOT create anything under Client 110 itself (see comment on that cycle) to avoid any
// risk of touching this real, shared node's data.
const ADMIN_LIC_ID = 104;
const PARTNER_LIC_ID = 109;
const CLIENT_LIC_ID = 110;

// DTS tree for the License_Management module (MmsId=180), read live from
// GET /api/screen/dts?mmsId=180 (see measure-api.mjs / discover-client-licid.mjs).
const DTS_ADMIN_LIST = 452;
const DTS_DISTRIBUTOR_LIST = 456;
const DTS_CLIENT_LIST = 464;

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
  if (loginObserved) {
    if (loginObserved.status === 429) {
      throw new Error(`Login returned 429 (rate limited) — token is garbage, do not trust anything downstream for this role.`);
    }
  } else {
    throw new Error('Login endpoint NOT observed — waitForResponse did not resolve.');
  }

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

async function measureLicApi(browser, user) {
  console.log(`\n########## ${user.role} (${user.username}) [LIC API] ##########`);
  const flow = [];
  const notes = [];
  let apiCtx = null;

  try {
    const token = await loginAndGetToken(browser, user, flow);

    apiCtx = await request.newContext({
      baseURL: API_BASE_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    // ===================== API: POST api/license-mgt/grid (GetLICLevel) =====================
    flow.push(await step('API: POST license-mgt/grid (Admin_List, top-level, parentLicId=null)', async () => {
      const res = await apiCtx.post('/api/license-mgt/grid', {
        data: { startedDtsId: DTS_ADMIN_LIST, parentLicId: null, gridRequest: { page: 1, pageSize: 50 } },
      });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      return { status, url: res.url(), totalCount: json?.totalCount, dataLength: json?.data?.length };
    }));

    flow.push(await step('API: POST license-mgt/grid (Distributor_List under Admin 104)', async () => {
      const res = await apiCtx.post('/api/license-mgt/grid', {
        data: { startedDtsId: DTS_DISTRIBUTOR_LIST, parentLicId: ADMIN_LIC_ID, gridRequest: { page: 1, pageSize: 50 } },
      });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      return { status, url: res.url(), totalCount: json?.totalCount, dataLength: json?.data?.length };
    }));

    flow.push(await step('API: POST license-mgt/grid (Client_List under Partner 109)', async () => {
      const res = await apiCtx.post('/api/license-mgt/grid', {
        data: { startedDtsId: DTS_CLIENT_LIST, parentLicId: PARTNER_LIC_ID, gridRequest: { page: 1, pageSize: 50 } },
      });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      return { status, url: res.url(), totalCount: json?.totalCount, dataLength: json?.data?.length };
    }));

    // ===================== API: GET api/license-mgt/lic-type (GetLicType) =====================
    // Resolves LIC_Type.LicTypeId for a given list-level DTS. Needed (not just measured) below:
    // CreateLicenseContract, CreateLIC, and GetLicenseGrid all require the caller to pass the
    // correct LicTypeId for the node in question, so these are discovered live rather than
    // hardcoded (per the "never invent an ID" rule) and reused for the rest of this role's flow.
    let adminLicTypeId = null;
    flow.push(await step('API: GET license-mgt/lic-type?startedDtsId=452 (Admin)', async () => {
      const res = await apiCtx.get('/api/license-mgt/lic-type', { params: { startedDtsId: DTS_ADMIN_LIST } });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      if (status === 200 && Number.isFinite(json?.licTypeId)) {
        adminLicTypeId = json.licTypeId;
      }
      return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null };
    }));

    let clientLicTypeId = null;
    flow.push(await step('API: GET license-mgt/lic-type?startedDtsId=464 (Client)', async () => {
      const res = await apiCtx.get('/api/license-mgt/lic-type', { params: { startedDtsId: DTS_CLIENT_LIST } });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      if (status === 200 && Number.isFinite(json?.licTypeId)) {
        clientLicTypeId = json.licTypeId;
      }
      return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null };
    }));
    if (!adminLicTypeId) {
      notes.push('Could not discover adminLicTypeId from GET license-mgt/lic-type?startedDtsId=452 — the SetLicUser mapping cycle below will be skipped for this role.');
    }
    if (!clientLicTypeId) {
      notes.push('Could not discover clientLicTypeId from GET license-mgt/lic-type?startedDtsId=464 — GetLicenseGrid and the CreateLIC/CreateLicense cycle below will be skipped/limited for this role.');
    }

    // ===================== API: POST api/license-mgt/licenses/grid (GetLicenseGrid) =====================
    // The only LIC endpoint decorated with .RequireAuthorization() at the route level (all its
    // siblings are currently anonymous per a prior audit) — still calling it authenticated here,
    // same as every other step, just noting the difference.
    flow.push(await step('API: POST license-mgt/licenses/grid (Client 110, authenticated)', async () => {
      if (!clientLicTypeId) {
        throw new Error('No clientLicTypeId discovered — cannot call GetLicenseGrid with a valid LicType.');
      }
      const res = await apiCtx.post('/api/license-mgt/licenses/grid', {
        data: { licId: CLIENT_LIC_ID, licType: clientLicTypeId, gridRequest: { page: 1, pageSize: 20 } },
      });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      return { status, url: res.url(), totalCount: json?.totalCount, dataLength: json?.data?.length };
    }));
    notes.push('GetLicenseGrid (POST license-mgt/licenses/grid) is the only LIC endpoint with .RequireAuthorization() at the route level; all other LIC endpoints exercised here are currently anonymous at the route (still called authenticated throughout, per the task brief).');

    // ===================== SetLicUser add/remove-mapping cycle (Users/*) =====================
    // Mirrors the established pattern in measure-api.mjs: register a throwaway account, map it
    // to the shared Admin node 104 (LicType discovered above, expected LicTypeId=13), read it
    // back via GetLicUsersGrid, then unmap (soft delete) + purge (permanent delete) + delete the
    // throwaway account itself. Node 104 is real/shared but the row we add and remove is a
        // brand-new throwaway user, so nothing pre-existing is touched.
    let registeredUserId = null;
    let mappedUserId = null;
    try {
      const throwawayEmail = `perf-lic-user-${user.role.toLowerCase()}-${Date.now()}@test.com`;
      flow.push(await step('API: POST /api/auth/register (throwaway account for LicUser mapping)', async () => {
        const res = await apiCtx.post('/api/auth/register', {
          data: { email: throwawayEmail, password: 'User@1234' },
        });
        const status = res.status();
        const body = await res.text();
        if (status >= 200 && status < 300) {
          try {
            const parsed = JSON.parse(body);
            registeredUserId = Number.isFinite(parsed) ? parsed : null;
          } catch { /* not JSON */ }
        }
        return { status, url: res.url(), body: body?.slice(0, 300) || null, throwawayEmail, registeredUserId };
      }));
      if (!registeredUserId) {
        notes.push('Register step for the LicUser mapping cycle did not return a usable numeric userId — SetLicUser/GetLicUsersGrid/cleanup below will be attempted anyway with the throwaway email, but may not resolve to a real user.');
      }

      flow.push(await step('API: POST license-mgt/user (SetLicUser - map throwaway user to Admin node 104)', async () => {
        if (!adminLicTypeId) {
          throw new Error('No adminLicTypeId discovered — cannot call SetLicUser with a valid LicType.');
        }
        const res = await apiCtx.post('/api/license-mgt/user', {
          data: { licId: ADMIN_LIC_ID, licType: adminLicTypeId, userAccount: throwawayEmail },
        });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        // Confirmed live shape (raw, not the {message,status,isSuccess,data} envelope — this
        // endpoint calls result.Match(Results.Ok, ...) directly, not EndpointHelper.HandleCommand):
        // { status, message, licType, licId, licUserId }.
        if (status === 200 && Number.isFinite(json?.licUserId)) {
          mappedUserId = json.licUserId;
        }
        return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, mappedUserId };
      }));
      if (!mappedUserId) {
        notes.push('SetLicUser did not return a usable licUserId — GetLicUsersGrid verification and the DeleteLicUser cleanup below will be skipped/limited for this role.');
      }

      flow.push(await step('API: POST license-mgt/users/grid (GetLicUsersGrid for Admin node 104)', async () => {
        if (!adminLicTypeId) {
          throw new Error('No adminLicTypeId discovered — cannot call GetLicUsersGrid with a valid LicType.');
        }
        const res = await apiCtx.post('/api/license-mgt/users/grid', {
          data: { licId: ADMIN_LIC_ID, licType: adminLicTypeId, gridRequest: { page: 1, pageSize: 50 } },
        });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        const containsMappedUser = mappedUserId
          ? !!json?.data?.some?.(row => row.userId === mappedUserId)
          : null;
        return { status, url: res.url(), totalCount: json?.totalCount, dataLength: json?.data?.length, containsMappedUser };
      }));
    } finally {
      let softDeleteOk = false;
      flow.push(await step('API: DELETE license-mgt/{licId}/users/{userId} (soft delete cleanup)', async () => {
        if (!mappedUserId) {
          return { skipped: true, reason: 'No mappedUserId to clean up (SetLicUser step did not return one).' };
        }
        const res = await apiCtx.delete(`/api/license-mgt/${ADMIN_LIC_ID}/users/${mappedUserId}`);
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        // Confirmed live shape: {message, status, isSuccess, data:{status, licId, userId}} —
        // this endpoint DOES go through EndpointHelper.HandleCommand, unlike SetLicUser above.
        softDeleteOk = status >= 200 && status < 300 && json?.isSuccess === true;
        return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, softDeleteOk };
      }));

      let permanentDeleteOk = false;
      flow.push(await step('API: DELETE license-mgt/{licId}/users/{userId}?isPermanent=true (permanent cleanup)', async () => {
        if (!mappedUserId) {
          return { skipped: true, reason: 'No mappedUserId to purge.' };
        }
        if (!softDeleteOk) {
          return { skipped: true, reason: 'Soft-delete step above did not confirm success — DeleteLicUserAsync requires isDeleted=true before a permanent purge is allowed, so skipping to avoid a RecordNotMarkedDeleted failure.' };
        }
        const res = await apiCtx.delete(`/api/license-mgt/${ADMIN_LIC_ID}/users/${mappedUserId}`, { params: { isPermanent: 'true' } });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        permanentDeleteOk = status >= 200 && status < 300 && json?.isSuccess === true;
        return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, permanentDeleteOk };
      }));
      if (mappedUserId) {
        notes.push(permanentDeleteOk
          ? `Confirmed: LicUser mapping (LicId=${ADMIN_LIC_ID}, UserId=${mappedUserId}) fully deleted (soft delete then permanent purge both returned isSuccess=true).`
          : `WARNING: could not confirm full deletion of LicUser mapping (LicId=${ADMIN_LIC_ID}, UserId=${mappedUserId}) — check the two DELETE steps above.`);
      }

      flow.push(await step('API: DELETE /api/auth/delete-user/{userId} (cleanup throwaway account)', async () => {
        if (!registeredUserId) {
          return { skipped: true, reason: 'No registered userId to clean up.' };
        }
        const res = await apiCtx.delete(`/api/auth/delete-user/${registeredUserId}`);
        const status = res.status();
        const body = await res.text();
        let deleteConfirmed = false;
        try {
          const parsed = JSON.parse(body);
          deleteConfirmed = status >= 200 && status < 300 && (parsed?.data === true || parsed?.isSuccess === true);
        } catch { /* not JSON */ }
        return { status, url: res.url(), body: body?.slice(0, 300) || null, deleteConfirmed };
      }));
    }

    // ===================== CreateLIC + CreateLicense combined cycle (Root only) =====================
    // Deliberately scoped to Root only. Read from LicService.cs directly (Infrastructure/Services/
    // LIC/LicService.cs): the account "m.wanninayaka@h2compute.com" (RootAdminUserName) is an
    // unconditional super-user bypass for BOTH node creation (ValidateUserPermissionsAsync /
    // IsSpecialUserForRootCreation) AND node deletion (HasLicAccessAsync's RootAdmin short-
    // circuit) — the safest, most deterministic role for this mutating test. CreateSDNodeAsync
    // only INSERTs a single row into the LIC table (no other tables touched), and DeleteSDAsync
    // hard-deletes that exact row (plus any descendants/BusinessAdministrations — none exist for
    // a freshly created leaf), so create+delete of a throwaway leaf node is fully reversible.
    //
    // The throwaway node is created as a new Client under the REAL Partner 109 ("Gas Supplier -
    // Canada") rather than reusing the real Client 110 ("Gas Client") for the license-contract
    // test below — CreateLicenseContractCommandHandler.ResolveOrCreateLicenseeAsync reuses (and
    // RENAMES) an existing licensee Organization whenever a Contract with the same
    // (LicensorRelationId, LicId) pair already exists, which real node 110 already has via its
    // own live "Gas Client" contract. Creating a brand-new node guarantees no such existing
    // Contract can collide, so the throwaway licensee Organization created here is always a new,
    // separate row — never a rename of real data.
    if (user.role === 'Root') {
      let newLicId = null;
      let contractId = null;
      let licensePurgedOk = false; // guards the node delete below against an FK conflict
      try {
        flow.push(await step('API: POST license-mgt (CreateLIC - throwaway Client node under Partner 109)', async () => {
          if (!clientLicTypeId) {
            throw new Error('No clientLicTypeId discovered — cannot call CreateLIC with a valid TypeId.');
          }
          const res = await apiCtx.post('/api/license-mgt', {
            data: { typeId: clientLicTypeId, parentId: PARTNER_LIC_ID },
          });
          const status = res.status();
          let json = null;
          try { json = await res.json(); } catch { /* not JSON / empty body */ }
          if (status >= 200 && status < 300 && Number.isFinite(json?.data?.licId)) {
            newLicId = json.data.licId;
          }
          return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, newLicId };
        }));

        if (!newLicId) {
          notes.push('CreateLIC did not return a usable newLicId — CreateLicense/DeleteLicense and DeleteLICLevel below are skipped for this role.');
        } else {
          try {
            let licensorRelationId = null;
            flow.push(await step('API: GET license-mgt/license?contractId=0&licId={newLicId} (GetLicLicensor)', async () => {
              const res = await apiCtx.get('/api/license-mgt/license', { params: { contractId: 0, licId: newLicId } });
              const status = res.status();
              let json = null;
              try { json = await res.json(); } catch { /* not JSON / empty body */ }
              if (status === 200 && Number.isFinite(json?.licensorRelationId)) {
                licensorRelationId = json.licensorRelationId;
              }
              return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, licensorRelationId };
            }));
            if (!licensorRelationId) {
              notes.push('GetLicLicensor did not resolve a usable licensorRelationId for the new node — CreateLicenseContract below is skipped for this role.');
            }

            try {
              if (licensorRelationId) {
                flow.push(await step('API: POST license-mgt/license (CreateLicenseContract, throwaway node)', async () => {
                  const startDate = new Date();
                  const endDate = new Date(startDate.getTime() + 365 * 24 * 60 * 60 * 1000);
                  const res = await apiCtx.post('/api/license-mgt/license', {
                    data: {
                      licId: newLicId,
                      licTypeId: clientLicTypeId,
                      licensorRelationId,
                      licenseeName: `perf-lic-${Date.now()}`,
                      startDate: startDate.toISOString(),
                      endDate: endDate.toISOString(),
                    },
                  });
                  const status = res.status();
                  let json = null;
                  try { json = await res.json(); } catch { /* not JSON / empty body */ }
                  if (status === 201 && Number.isFinite(json?.contractId)) {
                    contractId = json.contractId;
                  }
                  return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, contractId };
                }));
              }
            } finally {
              let softDeleteOk = false;
              flow.push(await step('API: DELETE license-mgt/license/{contractId} (soft delete cleanup)', async () => {
                if (!contractId) {
                  return { skipped: true, reason: 'No contractId to clean up (create step did not return one, or was itself skipped).' };
                }
                const res = await apiCtx.delete(`/api/license-mgt/license/${contractId}`);
                const status = res.status();
                let json = null;
                try { json = await res.json(); } catch { /* not JSON / empty body */ }
                softDeleteOk = status >= 200 && status < 300 && json?.isSuccess === true;
                return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, softDeleteOk };
              }));

              flow.push(await step('API: DELETE license-mgt/license/{contractId}?isPermanent=true (permanent cleanup)', async () => {
                if (!contractId) {
                  return { skipped: true, reason: 'No contractId to purge.' };
                }
                if (!softDeleteOk) {
                  return { skipped: true, reason: 'Soft-delete step above did not confirm success — DeleteLicenseAsync requires IsDeleted=true before a permanent purge is allowed, so skipping to avoid a RecordNotMarkedDeleted failure.' };
                }
                const res = await apiCtx.delete(`/api/license-mgt/license/${contractId}`, { params: { isPermanent: 'true' } });
                const status = res.status();
                let json = null;
                try { json = await res.json(); } catch { /* not JSON / empty body */ }
                licensePurgedOk = status >= 200 && status < 300 && json?.isSuccess === true;
                return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, licensePurgedOk };
              }));
              if (contractId) {
                notes.push(licensePurgedOk
                  ? `Confirmed: throwaway license contract ${contractId} fully deleted (soft delete then permanent purge both returned isSuccess=true).`
                  : `WARNING: could not confirm full deletion of throwaway license contract ${contractId} — check the two DELETE steps above.`);
                notes.push('Known backend gap (not a script bug): CreateLicenseContractCommandHandler always inserts a new Relation+Organization row for the licensee even when the licensor context is reused, and DeleteLicense has no cascading cleanup for those rows — there is no LIC API endpoint to delete a Relation/Organization directly. The throwaway licensee Relation+Organization pair created above (name "perf-lic-<timestamp>") is therefore an unavoidable, harmless, clearly-named leftover.');
              }
            }
          } finally {
            flow.push(await step('API: DELETE license-mgt/{licId} (DeleteLICLevel - cleanup throwaway node)', async () => {
              if (!newLicId) {
                return { skipped: true, reason: 'No newLicId to clean up.' };
              }
              if (contractId && !licensePurgedOk) {
                return { skipped: true, reason: 'License contract cleanup was not confirmed permanently purged — skipping node delete to avoid a possible Contract->LIC FK conflict. Leaves the throwaway node behind for manual review rather than risking a failed/partial delete.' };
              }
              const res = await apiCtx.delete(`/api/license-mgt/${newLicId}`);
              const status = res.status();
              let json = null;
              try { json = await res.json(); } catch { /* not JSON / empty body */ }
              const nodeDeleteOk = status >= 200 && status < 300 && json?.isSuccess === true;
              if (!nodeDeleteOk) {
                notes.push(`WARNING: could not confirm deletion of throwaway LIC node ${newLicId} — check this DELETE step's status/body.`);
              } else {
                notes.push(`Confirmed: throwaway LIC node ${newLicId} (Client, under Partner ${PARTNER_LIC_ID}) deleted successfully (isSuccess=true, deletedChildCount=${json?.data?.deletedChildCount}).`);
              }
              return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, nodeDeleteOk };
            }));
          }
        }
      } catch (e) {
        notes.push(`CreateLIC/CreateLicense combined cycle failed unexpectedly: ${e.message}`);
      }
    } else {
      notes.push('CreateLIC/DeleteLICLevel + CreateLicense/DeleteLicense combined cycle is only exercised under the Root role (see script comments) — Root has an unconditional RootAdminUserName bypass in LicService.cs for both node creation/deletion and license creation, making it the safest, most deterministic role for this mutating test.');
    }

  } catch (e) {
    notes.push(`Fatal error during measurement: ${e.message}`);
    console.log('FATAL for', user.role, e.message);
  } finally {
    if (apiCtx) await apiCtx.dispose().catch(() => {});
  }

  return { role: user.role, username: user.username, flow, notes };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const roleFilter = process.env.ROLE_FILTER ? process.env.ROLE_FILTER.split(',') : ['Root', 'Admin'];
  const usersToRun = creds.users.filter(u => roleFilter.includes(u.role));
  const results = [];

  // Each role below performs exactly ONE login. With only Root/Admin (2 logins total, well
  // under the 5/minute login rate limit) no extra pacing delay is strictly required, but a
  // short pause is added anyway between roles as a courtesy margin on a real shared IT env.
  for (let i = 0; i < usersToRun.length; i++) {
    if (i > 0) {
      await new Promise(r => setTimeout(r, 3000));
    }
    const r = await measureLicApi(browser, usersToRun[i]);
    results.push(r);
    console.log(JSON.stringify(r, null, 2));
  }
  await browser.close();

  const output = {
    runLabel: RUN_LABEL,
    runTimestamp: RUN_TS,
    baseUrl: creds.baseUrl,
    module: 'LIC (License Management hierarchy + licenses + users)',
    results,
  };
  const outPath = path.join(resultsDir, `${RUN_LABEL}-${RUN_TS}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n\nSaved results to ${outPath}`);
})();
