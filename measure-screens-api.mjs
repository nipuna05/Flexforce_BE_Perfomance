import { chromium, request } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '.credentials.local.json'), 'utf-8'));
const RUN_LABEL = process.argv[2] || 'screens-baseline';
const RUN_TS = process.argv[3] || String(Date.now());

const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(resultsDir, { recursive: true });

const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');

// DTS tree for the License_Management module (MmsId=180), read live from
// GET /api/screen/dts?mmsId=180 (see measure-lic-api.mjs / discover-client-licid.mjs).
const MMS_ID_LICENSE_MGT = 180;
const DTS_ADMIN_LIST = 452;
const DTS_CLIENT_LIST = 464;
const DTS_BA_LIST = 468;

// Confirmed live on IT: licId=110 ("Gas Client") has 2 real BA rows: 185 and 228. Used as the
// explicit `baid` override for BusinessAdministration-module GET calls when the caller (Root/
// Admin) has no BA of its own. A BA-role login (baperform@gmail.com) instead uses its OWN BA,
// decoded from its JWT "BA" claim, since GetBaObj and the whole Users/BusinessAdministration/*
// subtree enforce real BA_Users/USER_BA_* membership that Root/Admin do not have.
const BA_ID_FALLBACK = 185;

// baperform@gmail.com's Users.BAId column is null in this environment (no "BA" JWT claim at all —
// confirmed live: decodeJwtClaims(...).baId comes back null for this account), so it cannot be
// used to discover baperform's own BA. Its REAL membership lives only in the BA_Users join table
// and was confirmed live via GetBaObj (the only endpoint here with a genuine BA_Users ownership
// check): baid=185 -> 403 Forbidden, baid=228 -> 200 with real data. Hardcoded from that discovery.
const BA_ROLE_OWN_BA_ID = 228;

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

// Decodes the JWT payload issued by POST api/auth/login. Claims are literally named "UserId",
// "LanguageId" and "BA" (see src/Infrastructure/Authentication/TokenProvider.cs /
// ClaimsPrincipalExtensions.cs in FlexForce_BE) - decoding them avoids ever having to guess a
// caller's own userId/languageId/baId.
function decodeJwtClaims(token) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(`Token does not look like a 3-part JWT (got ${parts.length} parts).`);
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  const userId = Number(payload.UserId);
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error(`Could not find a positive numeric "UserId" claim in the decoded JWT payload: ${JSON.stringify(payload)}`);
  }
  const languageIdRaw = Number(payload.LanguageId);
  const baIdRaw = Number(payload.BA);
  return {
    userId,
    languageId: Number.isFinite(languageIdRaw) && languageIdRaw > 0 ? languageIdRaw : null,
    baId: Number.isFinite(baIdRaw) && baIdRaw > 0 ? baIdRaw : null,
  };
}

// Compares a re-fetched row against the originally captured one on the given fields only —
// used to satisfy the task's mutation-safety rule (c): after every no-op Update*, re-GET and
// confirm the value is byte-identical to what was read before the write.
function fieldsIdentical(before, after, fields) {
  if (!before || !after) return false;
  return fields.every(f => (before[f] ?? null) === (after[f] ?? null));
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
      throw new Error('Login returned 429 (rate limited) — token is garbage, do not trust anything downstream for this role.');
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

async function measureScreensApi(browser, user) {
  console.log(`\n########## ${user.role} (${user.username}) [Screens API] ##########`);
  const flow = [];
  const notes = [];
  let apiCtx = null;

  try {
    const token = await loginAndGetToken(browser, user, flow);
    const claims = decodeJwtClaims(token);
    notes.push(`Decoded JWT claims: userId=${claims.userId}, languageId=${claims.languageId ?? 'none'}, baId=${claims.baId ?? 'none'}.`);

    apiCtx = await request.newContext({
      baseURL: API_BASE_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    // =====================================================================
    // SCREENS: DAL
    // =====================================================================
    let dalSampleRow = null; // { dalId, dalToken, dtsId } from the first dtsId that returned rows
    for (const dtsId of [DTS_ADMIN_LIST, DTS_CLIENT_LIST, DTS_BA_LIST]) {
      const r = await step(`API: GET screen/dal?dtsId=${dtsId} (GetDal)`, async () => {
        const res = await apiCtx.get('/api/screen/dal', { params: { dtsId } });
        const status = res.status();
        const bodyText = await res.text();
        let json = null;
        try { json = JSON.parse(bodyText); } catch { /* not JSON / empty body */ }
        if (status === 200 && Array.isArray(json) && json.length > 0 && !dalSampleRow) {
          dalSampleRow = { dalId: json[0].dalId, dalToken: json[0].dalToken, dtsId };
        }
        return { status, url: res.url(), dataLength: Array.isArray(json) ? json.length : null, body: !Array.isArray(json) ? bodyText?.slice(0, 300) : undefined };
      });
      flow.push(r);
    }
    notes.push('GetDal: a 403 (DalError.NoPermissionForNode) or 404 (DalNotFound) for a given dtsId is handler-internal permission/data behavior (LicService.IsUserHasPermissionToAccessDal gates Lic-hierarchy callers with no BA, i.e. Root/Admin here), not a script failure.');

    // AddDal + DeleteDal throwaway cycle — Root only, to keep the create/delete blast radius to a
    // single, most-deterministic role (same spirit as the LIC CreateLIC/DeleteLICLevel cycle).
    // DalToken is deliberately left EMPTY: AddDalCommandHandler only fans out to BA_DAL/LAN_DAL/
    // USER_BA_DAL (one row per existing BA / user-BA pair in the whole system) when DalToken is
    // non-empty — an empty token keeps this a single clean INSERT into DAL with zero other rows
    // touched, which DeleteDal can then remove as a single clean DELETE (no cascade children).
    if (user.role === 'Root') {
      let createdDalId = null;
      try {
        const throwawayName = `perf-dal-${Date.now()}`;
        flow.push(await step('API: POST screen/dal (AddDal - throwaway row, empty token)', async () => {
          const res = await apiCtx.post('/api/screen/dal', {
            data: { DalList: [{ DtsId: DTS_CLIENT_LIST, DalName: throwawayName, DalDescription: 'perf test throwaway', IconId: null, DalOrder: 999, DalToken: '' }] },
          });
          const status = res.status();
          let json = null;
          try { json = await res.json(); } catch { /* not JSON / empty body */ }
          if (status >= 200 && status < 300 && Number.isFinite(json?.data)) {
            createdDalId = json.data;
          }
          return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, createdDalId };
        }));
        if (!createdDalId) {
          notes.push('AddDal did not return a usable dalId — DeleteDal cleanup below will be skipped.');
        }
      } finally {
        flow.push(await step('API: DELETE screen/dal/{dalId} (DeleteDal cleanup)', async () => {
          if (!createdDalId) {
            return { skipped: true, reason: 'No dalId to clean up (AddDal did not return one).' };
          }
          const res = await apiCtx.delete(`/api/screen/dal/${createdDalId}`);
          const status = res.status();
          let json = null;
          try { json = await res.json(); } catch { /* not JSON / empty body */ }
          const deleteOk = status >= 200 && status < 300 && json?.isSuccess === true;
          if (!deleteOk) {
            notes.push(`WARNING: could not confirm deletion of throwaway DalId ${createdDalId} — check this DELETE step's status/body.`);
          } else {
            notes.push(`Confirmed: throwaway DalId ${createdDalId} (empty DalToken, no BA_DAL/LAN_DAL/USER_BA_DAL fan-out) deleted successfully.`);
          }
          return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, deleteOk };
        }));
      }
    } else {
      notes.push('AddDal/DeleteDal throwaway create+delete cycle only exercised under Root (lowest-risk single role, mirrors the LIC phase\'s CreateLIC/DeleteLICLevel pattern).');
    }

    // UpdateLanDal no-op round trip: identity key is (DALId, LanId). sp_GetDalItems (read directly
    // from src/Infrastructure/Database/StoredProcedures/Sql/sp_GetDalItems.sql) returns
    // ISNULL(NULLIF(LAN_DAL.DALToken,''), DAL.DALName) for @LanId = the caller's own language, so
    // writing the exact dalToken GetDal just returned back to (DALId, LanId=own languageId) is
    // either a true UPDATE no-op (a real LAN_DAL row exists) or a safe no-op rejection
    // (LanDalError.LanDalNotFound — the handler never inserts, only updates an existing row).
    if (dalSampleRow && claims.languageId) {
      flow.push(await step('API: POST screen/dal/tokens (UpdateLanDal - no-op round trip)', async () => {
        const res = await apiCtx.post('/api/screen/dal/tokens', {
          data: { Items: [{ LanId: claims.languageId, DALId: dalSampleRow.dalId, DALToken: dalSampleRow.dalToken }] },
        });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, dalId: dalSampleRow.dalId, languageId: claims.languageId };
      }));
      flow.push(await step('API: GET screen/dal?dtsId=... (verify UpdateLanDal wrote back byte-identical dalToken)', async () => {
        const res = await apiCtx.get('/api/screen/dal', { params: { dtsId: dalSampleRow.dtsId } });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        const row = Array.isArray(json) ? json.find(r => r.dalId === dalSampleRow.dalId) : null;
        const identical = fieldsIdentical(dalSampleRow, row, ['dalToken']);
        if (row && !identical) {
          notes.push(`WARNING: UpdateLanDal verification MISMATCH for dalId=${dalSampleRow.dalId} — before="${dalSampleRow.dalToken}" after="${row.dalToken}".`);
        }
        return { status, identical, before: dalSampleRow.dalToken, after: row?.dalToken };
      }));
    } else {
      notes.push('UpdateLanDal no-op round trip skipped: no dalSampleRow/languageId captured from the GetDal calls above.');
    }
    notes.push('SetDtsMenu, DeleteDts, SetMmsMenu, DeleteMms, SetObjItems, DeleteObj, DeleteDet all SKIPPED: read directly (DtsService/MmsService/DetService/ObjService), each Set* is INSERT-only (409/duplicate error on any repeat, fans out to BA_*/USER_BA_*/LAN_* for every existing BA/user), and each Delete* is an explicit recursive/cascading hard delete of a real, structural node — none are safely reversible against real shared data (task guidance: skip DeleteDts/DeleteMms/DeleteObj/DeleteDet entirely, confirmed correct, no counter-evidence found).');

    // =====================================================================
    // SCREENS: DTS
    // =====================================================================
    flow.push(await step(`API: GET screen/dts?mmsId=${MMS_ID_LICENSE_MGT} (GetDtsMenu)`, async () => {
      const res = await apiCtx.get('/api/screen/dts', { params: { mmsId: MMS_ID_LICENSE_MGT } });
      const status = res.status();
      const bodyText = await res.text();
      return { status, url: res.url(), bodyLength: bodyText?.length ?? 0 };
    }));
    notes.push('GetDtsMenu/GetMmsMenu/GetMmsTokens/GetMtsTokens/GetObjItems all return Result<string> (a JSON-encoded hierarchy blob as a raw C# string) — the HTTP body is therefore a double-encoded JSON string, not a parsed array/object; only bodyLength/status is recorded for these, matching how GetDal (typed List<T>, single-encoded) is treated differently above.');

    // =====================================================================
    // SCREENS: MMS
    // =====================================================================
    flow.push(await step('API: GET screen/mms (GetMmsMenu, context-derived baid/languageId)', async () => {
      const res = await apiCtx.get('/api/screen/mms');
      const status = res.status();
      const bodyText = await res.text();
      return { status, url: res.url(), bodyLength: bodyText?.length ?? 0 };
    }));
    flow.push(await step(`API: GET screen/mms-tokens?baId=${BA_ID_FALLBACK} (GetMmsTokens)`, async () => {
      const res = await apiCtx.get('/api/screen/mms-tokens', { params: { baId: BA_ID_FALLBACK, ...(claims.languageId ? { languageId: claims.languageId } : {}) } });
      const status = res.status();
      const bodyText = await res.text();
      return { status, url: res.url(), bodyLength: bodyText?.length ?? 0 };
    }));
    notes.push('GetMmsTokens/GetMtsTokens (400 Token.TokenNotFound "Missing Tokens") for baId=185/languageId=2: confirmed via live probe this is a genuine data condition (no LAN_MMS/LAN_MTS token rows exist for that BA+language combo), not a script defect — both params were valid and explicitly supplied.');
    notes.push('SetMmsMenu, UpdateLanMms, DeleteMms SKIPPED: SetMmsMenu is INSERT-only (documented in source as "never updates an existing MMS row", 409 on repeat name+parent); UpdateLanMms is a true no-op UPDATE by (MmsId,LanId) in principle, but the only current-value source is the opaque double-encoded hierarchy blob from GetMmsMenu/GetMmsTokens with no confirmed fallback semantics (unlike UpdateLanDal, whose stored procedure was read directly and confirmed safe) — skipping per the "when genuinely unsure, skip" rule rather than risk overwriting a real live menu translation; DeleteMms is an explicit recursive subtree hard delete.');

    // =====================================================================
    // SCREENS: MTS
    // =====================================================================
    let mtsSampleRow = null; // { mtsId, businessAdministrationId } — an existing, real BA_MTS pair
    flow.push(await step(`API: GET screen/mts?BAId=${BA_ID_FALLBACK} (GetMtsMenu)`, async () => {
      const res = await apiCtx.get('/api/screen/mts', { params: { BAId: BA_ID_FALLBACK } });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      if (status === 200 && Array.isArray(json) && json.length > 0) {
        // sp_GetMTSMenu.sql: businessAdministrationId is only the REAL BA_MTS.BAId when a custom
        // BA_MTS menu exists for @BAID; otherwise it falls back to the global Mts catalog and
        // hardcodes `0 AS BusinessAdministrationId` — a placeholder, not a real association. Only
        // treat a row as a safe SetMtsMenu no-op candidate when businessAdministrationId is the
        // real, non-zero BA we asked for (confirmed live: BA 185 has no BA_MTS rows, so every row
        // comes back with businessAdministrationId=0, and posting that back 409s — an FK violation
        // on BAMts.BAId=0, not a real BusinessAdministration row — caught by the handler's outer
        // catch-all as Mts.UnexpectedError).
        const realRow = json.find(r => r.businessAdministrationId === BA_ID_FALLBACK);
        if (realRow) {
          mtsSampleRow = { mtsId: realRow.id, businessAdministrationId: realRow.businessAdministrationId };
        }
      }
      return { status, url: res.url(), dataLength: Array.isArray(json) ? json.length : null };
    }));
    flow.push(await step(`API: GET screens/mts-tokens?baId=${BA_ID_FALLBACK} (GetMtsTokens, note plural "screens")`, async () => {
      const res = await apiCtx.get('/api/screens/mts-tokens', { params: { baId: BA_ID_FALLBACK, ...(claims.languageId ? { languageId: claims.languageId } : {}) } });
      const status = res.status();
      const bodyText = await res.text();
      return { status, url: res.url(), bodyLength: bodyText?.length ?? 0 };
    }));
    // SetMtsMenu no-op round trip: read directly from SetMtsCommandHandler.UpdateData — for an
    // EXISTING (MtsId,BAId) pair, sending IconId:null/MTSOrder:null leaves ba_mts.IconId/MtsOrder
    // completely untouched (the ResolveValue/ternary only overwrites when the request value is
    // HasValue && != 0). Only attempted when a genuinely real BA_MTS pair was found above.
    if (mtsSampleRow) {
      flow.push(await step('API: POST screen/mts (SetMtsMenu - no-op round trip, null Icon/Order)', async () => {
        const res = await apiCtx.post('/api/screen/mts', {
          data: { mtsList: [{ MtsId: mtsSampleRow.mtsId, BusinessAdministrationId: mtsSampleRow.businessAdministrationId, IconId: null, MTSOrder: null }] },
        });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, mtsId: mtsSampleRow.mtsId };
      }));
      flow.push(await step('API: GET screen/mts?BAId=... (verify SetMtsMenu no-op)', async () => {
        const res = await apiCtx.get('/api/screen/mts', { params: { BAId: BA_ID_FALLBACK } });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        const row = Array.isArray(json) ? json.find(r => r.id === mtsSampleRow.mtsId && r.businessAdministrationId === mtsSampleRow.businessAdministrationId) : null;
        return { status, found: !!row };
      }));
    } else {
      notes.push(`SetMtsMenu no-op round trip skipped: GetMtsMenu returned no row with a real, non-zero businessAdministrationId=${BA_ID_FALLBACK} — BA ${BA_ID_FALLBACK} has no BA_MTS customizations yet, so every returned row is the global Mts-catalog fallback (businessAdministrationId hardcoded to 0 by sp_GetMTSMenu), which is not a safe no-op target.`);
    }

    // =====================================================================
    // SCREENS: OBJECT / DET
    // =====================================================================
    flow.push(await step(`API: GET screen/det/obj?dtsId=${DTS_CLIENT_LIST} (GetObjItems)`, async () => {
      const res = await apiCtx.get('/api/screen/det/obj', { params: { dtsId: DTS_CLIENT_LIST } });
      const status = res.status();
      const bodyText = await res.text();
      return { status, url: res.url(), bodyLength: bodyText?.length ?? 0 };
    }));
    flow.push(await step('API: POST screen/det/obj/batch (GetObjItemsBatch, DtsIds=[452,464,468])', async () => {
      const res = await apiCtx.post('/api/screen/det/obj/batch', {
        data: { BaId: null, LanguageId: claims.languageId, DtsIds: [DTS_ADMIN_LIST, DTS_CLIENT_LIST, DTS_BA_LIST] },
      });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      return { status, url: res.url(), dataLength: Array.isArray(json) ? json.length : null };
    }));
    notes.push('BUG FOUND (backend, not this script): GetObjItemsBatch can 404 (Obj.ObjNotFound) for the exact same dtsId that succeeds via the single GetObjItems endpoint for the same caller — confirmed live for Admin/BA on dtsId=464. Root cause read directly from source: GetObjItemsQueryHandler.cs passes `@BaId = baId ?? 0` to Sp_GetObjItems, while GetObjItemsBatchQueryHandler.cs passes the raw nullable `baId` with no `?? 0` coalesce — when the caller\'s resolved baId is null (Root/Admin/BA all have no BA claim here), the batch endpoint sends SQL NULL instead of 0, and the stored procedure does not treat NULL and 0 equivalently. Not fixed here (read-only measurement task); reported as a discovered backend bug.');
    notes.push('SetObjItems, UpdateObjTokens, DeleteObj, DeleteDet all SKIPPED: SetObjItems is an INSERT-only Det+Obj(+associations) creator (duplicate-name error on repeat); UpdateObjTokens is a true upsert by (OBJId,LanId) in principle but, like UpdateLanMms, its only current-value source is the opaque double-encoded blob from GetObjItems/GetObjItemsBatch with unconfirmed fallback semantics — skipped for the same reason; DeleteObj/DeleteDet are hard deletes that DB-cascade (convention Cascade FK, confirmed by reading FlexForceDbContext\'s required non-nullable navigations) into BA_OBJ/USER_BA_OBJ/LAN_OBJ.');

    // =====================================================================
    // BUSINESSADMINISTRATION MODULE (Dal/Dts/Mms/Object, scoped by baid)
    // =====================================================================
    // Root/Admin have no BA of their own, so they use the known real BA_ID_FALLBACK (185) as an
    // explicit override. A BA-role login uses its OWN BA (from the JWT), which matters for
    // GetBaObj specifically — it enforces real BA_Users membership, unlike its GetBaDts/GetBaMms
    // siblings, which only resolve/validate baId without checking caller ownership.
    const effectiveBaId = user.role === 'BA' ? BA_ROLE_OWN_BA_ID : BA_ID_FALLBACK;
    notes.push(`BusinessAdministration-module calls below use baid=${effectiveBaId} (${user.role === 'BA' ? "this role's own real BA_Users membership (228), discovered live via GetBaObj — not from the JWT, which carries no BA claim for this account" : 'known real fallback BA under Client 110'}).`);

    let baDtsRow = null;
    let baDtsRows = [];
    flow.push(await step(`API: GET businessAdministration/Dts?baid=${effectiveBaId} (GetBaDts)`, async () => {
      const res = await apiCtx.get('/api/businessAdministration/Dts', { params: { baid: effectiveBaId, ...(claims.languageId ? { languageId: claims.languageId } : {}) } });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      if (status === 200 && Array.isArray(json) && json.length > 0) {
        baDtsRows = json;
        baDtsRow = json[0];
      }
      return { status, url: res.url(), dataLength: Array.isArray(json) ? json.length : null };
    }));

    let baMmsRow = null;
    flow.push(await step(`API: GET businessAdministration/MMS?baid=${effectiveBaId} (GetBaMms)`, async () => {
      const res = await apiCtx.get('/api/businessAdministration/MMS', { params: { baid: effectiveBaId, ...(claims.languageId ? { languageId: claims.languageId } : {}) } });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      if (status === 200 && Array.isArray(json) && json.length > 0) {
        baMmsRow = json[0];
      }
      return { status, url: res.url(), dataLength: Array.isArray(json) ? json.length : null };
    }));

    // GetBaDal requires dtsId to belong to that BA (BaDalError.InvalidDtsIdForgivenBaId otherwise)
    // — not every DTS menu node has DAL-level list items, so try a handful of distinct dtsId
    // candidates discovered from GetBaDts above (stopping at the first real hit) before giving up.
    let baDalRow = null;
    const dtsCandidatesForBaDal = [...new Set(baDtsRows.map(r => r.dtsId))].slice(0, 5);
    for (const dtsId of dtsCandidatesForBaDal) {
      if (baDalRow) break;
      const r = await step(`API: GET businessAdministration/dal?baid=${effectiveBaId}&dtsId=${dtsId} (GetBaDal)`, async () => {
        const res = await apiCtx.get('/api/businessAdministration/dal', { params: { baid: effectiveBaId, dtsId, ...(claims.languageId ? { languageId: claims.languageId } : {}) } });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        if (status === 200 && Array.isArray(json) && json.length > 0 && !baDalRow) {
          baDalRow = json[0];
        }
        return { status, url: res.url(), dataLength: Array.isArray(json) ? json.length : null };
      });
      flow.push(r);
    }
    if (dtsCandidatesForBaDal.length === 0) {
      notes.push('GetBaDal skipped entirely: no dtsId could be discovered from GetBaDts to satisfy its required dtsId-belongs-to-baid check.');
    }

    let baObjRow = null;
    flow.push(await step(`API: GET businessAdministration/det/Obj?baid=${effectiveBaId} (GetBaObj)`, async () => {
      const res = await apiCtx.get('/api/businessAdministration/det/Obj', { params: { baid: effectiveBaId, ...(claims.languageId ? { languageId: claims.languageId } : {}) } });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      if (status === 200 && Array.isArray(json) && json.length > 0) {
        baObjRow = json[0];
      }
      return { status, url: res.url(), dataLength: Array.isArray(json) ? json.length : null };
    }));
    if (user.role !== 'BA') {
      notes.push(`GetBaObj is EXPECTED to reject with 403 (BaObjError.Forbidden) for ${user.role} here: unlike GetBaDts/GetBaMms, its handler enforces real BA_Users membership (own BA claim == baid, or a BA_Users row for that exact userId+baid) — Root/Admin have neither for baid=${BA_ID_FALLBACK}. This is the "actual exception" to the no-per-role-difference pattern for this module; the BA-role run below exercises the genuine success path using its own BA.`);
    }

    // UpdateBaDts no-op round trip: BaDtsResponse fields map 1:1 onto BaDtsRequest.
    if (baDtsRow) {
      flow.push(await step('API: POST businessAdministration/DTS (UpdateBaDts - no-op round trip)', async () => {
        const res = await apiCtx.post('/api/businessAdministration/DTS', {
          data: { BaDtsList: [{ BaId: baDtsRow.baId, DTSId: baDtsRow.dtsId, MmsId: baDtsRow.mmsId, DtsParentId: baDtsRow.dtsParentId ?? null, IconId: baDtsRow.iconId ?? null, DtsOrder: baDtsRow.dtsOrder, DtsVisible: baDtsRow.dtsVisible, DtsEnabled: baDtsRow.dtsEnabled, DtsName: baDtsRow.dtsName }] },
        });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null };
      }));
      flow.push(await step('API: GET businessAdministration/Dts?baid=... (verify UpdateBaDts wrote back byte-identical row)', async () => {
        const res = await apiCtx.get('/api/businessAdministration/Dts', { params: { baid: effectiveBaId, ...(claims.languageId ? { languageId: claims.languageId } : {}) } });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        const row = Array.isArray(json) ? json.find(r => r.dtsId === baDtsRow.dtsId) : null;
        const fields = ['mmsId', 'dtsParentId', 'iconId', 'dtsOrder', 'dtsVisible', 'dtsEnabled', 'dtsName'];
        const identical = fieldsIdentical(baDtsRow, row, fields);
        if (row && !identical) {
          notes.push(`WARNING: UpdateBaDts verification MISMATCH for dtsId=${baDtsRow.dtsId} — before=${JSON.stringify(baDtsRow)} after=${JSON.stringify(row)}.`);
        }
        return { status, identical };
      }));
    } else {
      notes.push('UpdateBaDts no-op round trip skipped: no baDtsRow captured from GetBaDts.');
    }

    // UpdateBaMms no-op round trip: body binds directly to a raw BaMmsRequest[] array (not a
    // {BaMmsList:[...]} wrapper, unlike its Dal/Dts siblings — confirmed from UpdateBaMms.cs).
    if (baMmsRow) {
      flow.push(await step('API: POST businessAdministration/MMS (UpdateBaMms - no-op round trip, raw array body)', async () => {
        const res = await apiCtx.post('/api/businessAdministration/MMS', {
          data: [{ BAId: baMmsRow.baId, MMSId: baMmsRow.mmsId, IconId: baMmsRow.iconId ?? null, MMSOrder: baMmsRow.mmsOrder, MMSVisible: baMmsRow.mmsVisible, MMSEnabled: baMmsRow.mmsEnabled }],
        });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null };
      }));
      flow.push(await step('API: GET businessAdministration/MMS?baid=... (verify UpdateBaMms wrote back byte-identical row)', async () => {
        const res = await apiCtx.get('/api/businessAdministration/MMS', { params: { baid: effectiveBaId, ...(claims.languageId ? { languageId: claims.languageId } : {}) } });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        const row = Array.isArray(json) ? json.find(r => r.mmsId === baMmsRow.mmsId) : null;
        const fields = ['iconId', 'mmsOrder', 'mmsVisible', 'mmsEnabled'];
        const identical = fieldsIdentical(baMmsRow, row, fields);
        if (row && !identical) {
          notes.push(`WARNING: UpdateBaMms verification MISMATCH for mmsId=${baMmsRow.mmsId} — before=${JSON.stringify(baMmsRow)} after=${JSON.stringify(row)}.`);
        }
        return { status, identical };
      }));
    } else {
      notes.push('UpdateBaMms no-op round trip skipped: no baMmsRow captured from GetBaMms.');
    }

    // UpdateBaDal / UpdateLanBaDal no-op round trips: BaDalResponse fields map 1:1 onto
    // BaDalRequest, and its dalToken is a genuine per-(BAId,DALId,LanId) LAN_BA_DAL value.
    if (baDalRow) {
      flow.push(await step('API: POST businessAdministration/dal (UpdateBaDal - no-op round trip)', async () => {
        const res = await apiCtx.post('/api/businessAdministration/dal', {
          data: { BaDalList: [{ BAId: baDalRow.baId, DALId: baDalRow.dalId, DTSId: baDalRow.dtsId, IconId: baDalRow.iconId ?? null, DALOrder: baDalRow.dalOrder, DALVisible: baDalRow.dalVisible, DALEnabled: baDalRow.dalEnabled }] },
        });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null };
      }));
      if (baDalRow.dalToken && claims.languageId) {
        flow.push(await step('API: POST businessAdministration/dal/tokens (UpdateLanBaDal - no-op round trip)', async () => {
          const res = await apiCtx.post('/api/businessAdministration/dal/tokens', {
            data: { BaDalList: [{ LanId: claims.languageId, BAId: baDalRow.baId, DALId: baDalRow.dalId, DALToken: baDalRow.dalToken }] },
          });
          const status = res.status();
          let json = null;
          try { json = await res.json(); } catch { /* not JSON / empty body */ }
          return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null };
        }));
      } else {
        notes.push('UpdateLanBaDal no-op round trip skipped: no non-empty dalToken/languageId available from the captured baDalRow.');
      }
      flow.push(await step('API: GET businessAdministration/dal?baid=...&dtsId=... (verify UpdateBaDal/UpdateLanBaDal wrote back byte-identical row)', async () => {
        const res = await apiCtx.get('/api/businessAdministration/dal', { params: { baid: effectiveBaId, dtsId: baDalRow.dtsId, ...(claims.languageId ? { languageId: claims.languageId } : {}) } });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        const row = Array.isArray(json) ? json.find(r => r.dalId === baDalRow.dalId) : null;
        const fields = ['iconId', 'dalOrder', 'dalVisible', 'dalEnabled', 'dalToken'];
        const identical = fieldsIdentical(baDalRow, row, fields);
        if (row && !identical) {
          notes.push(`WARNING: UpdateBaDal/UpdateLanBaDal verification MISMATCH for dalId=${baDalRow.dalId} — before=${JSON.stringify(baDalRow)} after=${JSON.stringify(row)}.`);
        }
        return { status, identical };
      }));
    } else {
      notes.push('UpdateBaDal/UpdateLanBaDal no-op round trips skipped: no baDalRow captured from GetBaDal.');
    }
    notes.push('DeleteBaDal SKIPPED: hard-deletes the BA_DAL row and (per DeleteBaDalCommandHandler) also cascades a RemoveRange over matching USER_BA_DAL rows — those per-user overrides are not readable via any endpoint in this set, so the delete is not losslessly reversible. DeleteBaMms SKIPPED: recreating via UpdateBaMms\'s insert path cannot restore the original MMSName/MMSParentId (not present on that request DTO). UpdateLanBaMms SKIPPED: BaMmsResponse exposes no MMSToken field to source a current value from. UpdateBaObj SKIPPED: GetBaObj\'s response has only 5 of the 13 fields UpdateBaObj\'s handler unconditionally overwrites (OBJName/OBJTypeId/layout columns/ParentDtsId would be blanked). UpdateBaObjTokens SKIPPED: no Get endpoint in this set exposes the current OBJToken.');

    // =====================================================================
    // USERS/BUSINESSADMINISTRATION MODULE — only meaningful for a real BA-scoped login.
    // GetUserBaDal takes no baid override at all (purely from the JWT "BA" claim, confirmed by
    // reading GetUserBaDalQueryHandler.cs). GetUserBaDts/GetUserBaMms DO accept an explicit `baid`
    // query param that overrides the token (confirmed by reading their handlers), so they can be
    // exercised using BA_ROLE_OWN_BA_ID even though baperform's JWT itself carries no "BA" claim.
    // A genuine per-user Update* round trip still needs UserId==the caller's own token
    // (UpdateUserBaDal/Mms enforce or assume this) — claims.userId (a separate JWT claim) is real
    // regardless of the missing BA claim. Root/Admin have no BA_Users membership at all, so this
    // whole subtree is only exercised for the BA role (baperform@gmail.com).
    // =====================================================================
    if (user.role === 'BA') {
      const mmsIdForUserBaDts = baDtsRow?.mmsId ?? null;
      let userBaDtsRow = null;
      if (mmsIdForUserBaDts) {
        flow.push(await step(`API: GET users/businessAdministration/DTS?baid=${BA_ROLE_OWN_BA_ID}&mmsId=${mmsIdForUserBaDts} (GetUserBaDts)`, async () => {
          const res = await apiCtx.get('/api/users/businessAdministration/DTS', { params: { baid: BA_ROLE_OWN_BA_ID, mmsId: mmsIdForUserBaDts, languageId: claims.languageId } });
          const status = res.status();
          let json = null;
          try { json = await res.json(); } catch { /* not JSON / empty body */ }
          if (status === 200 && Array.isArray(json) && json.length > 0) {
            userBaDtsRow = json[0];
          }
          return { status, url: res.url(), dataLength: Array.isArray(json) ? json.length : null };
        }));
      } else {
        notes.push('GetUserBaDts skipped: no mmsId discovered from the BusinessAdministration-module GetBaDts call above (GetUserBaDtsQueryHandler\'s own fallback for a missing mmsId is a genuine bug — it falls back to BusinessAdministrationId, not a usable MMS default — so a real mmsId must always be passed explicitly).');
      }

      let userBaMmsRow = null;
      flow.push(await step(`API: GET users/businessAdministration/MMS?baid=${BA_ROLE_OWN_BA_ID} (GetUserBaMms)`, async () => {
        const res = await apiCtx.get('/api/users/businessAdministration/MMS', { params: { baid: BA_ROLE_OWN_BA_ID, languageId: claims.languageId } });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        if (status === 200 && Array.isArray(json) && json.length > 0) {
          userBaMmsRow = json[0];
        }
        return { status, url: res.url(), dataLength: Array.isArray(json) ? json.length : null };
      }));

      const dtsIdForUserBaDal = userBaDtsRow?.dtsId ?? baDtsRow?.dtsId ?? null;
      let userBaDalRow = null;
      if (dtsIdForUserBaDal && claims.languageId) {
        flow.push(await step(`API: GET users/businessAdministration/dal?dtsId=${dtsIdForUserBaDal} (GetUserBaDal)`, async () => {
          // languageId must be passed explicitly — GetUserBaDalQueryHandler validates the RAW
          // request.LanguageId (not the context-resolved fallback), a bug confirmed by reading
          // GetUserBaDalQueryHandler.cs: it always requires this query param, despite the
          // Get*'s usual "falls back to context" convention holding for baId there.
          const res = await apiCtx.get('/api/users/businessAdministration/dal', { params: { dtsId: dtsIdForUserBaDal, languageId: claims.languageId } });
          const status = res.status();
          let json = null;
          try { json = await res.json(); } catch { /* not JSON / empty body */ }
          if (status === 200 && Array.isArray(json) && json.length > 0) {
            userBaDalRow = json[0];
          }
          if (status === 500 && !claims.baId) {
            notes.push('BUG FOUND (backend, not this script): GetUserBaDal returns HTTP 500 (title "UserBaDal.InvalidBaId") instead of a client-error status for a caller with no "BA" JWT claim (confirmed live for baperform@gmail.com, whose Users.BAId is null). Root cause read directly from source: UserBaDalError.InvalidBaId is declared via Error.Failure(...) (ErrorType.Failure), which EndpointHelper.HandleQuery\'s status-code switch does not have a case for (Validation/Problem/InvalidInputs->400, NotFound->404, Conflict->409, Unauthorized/InvalidUsernameOrPassword->401, Forbidden->403, else->500) — a client-side "missing BA context" validation error therefore falls through to a generic 500. Not fixed here (read-only measurement task); reported as a discovered backend bug.');
          }
          return { status, url: res.url(), dataLength: Array.isArray(json) ? json.length : null };
        }));
      } else if (!claims.baId) {
        notes.push('GetUserBaDal (and its UpdateUserBaDal sibling) SKIPPED for this role: unlike GetUserBaDts/GetUserBaMms, GetUserBaDalQueryHandler takes no baid override at all — it is scoped purely by _userContext.BusinessAdministrationId (the JWT "BA" claim). Confirmed live that baperform@gmail.com\'s JWT carries no "BA" claim (Users.BAId is null for this account; its real BA_Users membership at BA 228 is invisible to this specific handler), so this endpoint has no reachable success path with the available test accounts.');
      } else {
        notes.push('GetUserBaDal skipped: no dtsId candidate available.');
      }

      if (userBaDtsRow) {
        flow.push(await step('API: POST users/businessAdministration/DTS (UpdateUserBaDts - no-op round trip)', async () => {
          const res = await apiCtx.post('/api/users/businessAdministration/DTS', {
            data: { UserBaDtsList: [{ UserId: claims.userId, BAId: userBaDtsRow.baId, DTSId: userBaDtsRow.dtsId, DTSOrder: userBaDtsRow.dtsOrder, MMSId: userBaDtsRow.mmsId, DtsParentId: userBaDtsRow.dtsParentId ?? 0, DtsVisible: userBaDtsRow.dtsVisible, DtsEnabled: userBaDtsRow.dtsEnabled }] },
          });
          const status = res.status();
          let json = null;
          try { json = await res.json(); } catch { /* not JSON / empty body */ }
          return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null };
        }));
        flow.push(await step('API: GET users/businessAdministration/DTS?... (verify UpdateUserBaDts wrote back byte-identical row)', async () => {
          const res = await apiCtx.get('/api/users/businessAdministration/DTS', { params: { baid: BA_ROLE_OWN_BA_ID, mmsId: mmsIdForUserBaDts, languageId: claims.languageId } });
          const status = res.status();
          let json = null;
          try { json = await res.json(); } catch { /* not JSON / empty body */ }
          const row = Array.isArray(json) ? json.find(r => r.dtsId === userBaDtsRow.dtsId) : null;
          const identical = fieldsIdentical(userBaDtsRow, row, ['dtsOrder', 'dtsVisible', 'dtsEnabled']);
          if (row && !identical) {
            notes.push(`WARNING: UpdateUserBaDts verification MISMATCH for dtsId=${userBaDtsRow.dtsId} — before=${JSON.stringify(userBaDtsRow)} after=${JSON.stringify(row)}.`);
          }
          return { status, identical };
        }));
      } else {
        notes.push('UpdateUserBaDts no-op round trip skipped: no userBaDtsRow captured.');
      }

      if (userBaMmsRow) {
        flow.push(await step('API: POST users/businessAdministration/MMS (UpdateUserBaMms - no-op round trip)', async () => {
          const res = await apiCtx.post('/api/users/businessAdministration/MMS', {
            data: { UserBaMmsList: [{ UserId: claims.userId, BAId: userBaMmsRow.baId, MMSId: userBaMmsRow.mmsId, MMSOrder: userBaMmsRow.mmsOrder }] },
          });
          const status = res.status();
          let json = null;
          try { json = await res.json(); } catch { /* not JSON / empty body */ }
          return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null };
        }));
        flow.push(await step('API: GET users/businessAdministration/MMS?... (verify UpdateUserBaMms wrote back byte-identical row)', async () => {
          const res = await apiCtx.get('/api/users/businessAdministration/MMS', { params: { baid: BA_ROLE_OWN_BA_ID, languageId: claims.languageId } });
          const status = res.status();
          let json = null;
          try { json = await res.json(); } catch { /* not JSON / empty body */ }
          const row = Array.isArray(json) ? json.find(r => r.mmsId === userBaMmsRow.mmsId) : null;
          const identical = fieldsIdentical(userBaMmsRow, row, ['mmsOrder']);
          if (row && !identical) {
            notes.push(`WARNING: UpdateUserBaMms verification MISMATCH for mmsId=${userBaMmsRow.mmsId} — before=${JSON.stringify(userBaMmsRow)} after=${JSON.stringify(row)}.`);
          }
          return { status, identical };
        }));
      } else {
        notes.push('UpdateUserBaMms no-op round trip skipped: no userBaMmsRow captured.');
      }

      if (userBaDalRow) {
        flow.push(await step('API: POST users/businessAdministration/dal (UpdateUserBaDal - no-op round trip)', async () => {
          const res = await apiCtx.post('/api/users/businessAdministration/dal', {
            data: { UserBaDalList: [{ UserId: claims.userId, BAId: userBaDalRow.baId, DALId: userBaDalRow.dalId, DTSId: userBaDalRow.dtsId, DALOrder: userBaDalRow.dalOrder }] },
          });
          const status = res.status();
          let json = null;
          try { json = await res.json(); } catch { /* not JSON / empty body */ }
          return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null };
        }));
        flow.push(await step('API: GET users/businessAdministration/dal?... (verify UpdateUserBaDal wrote back byte-identical row)', async () => {
          const res = await apiCtx.get('/api/users/businessAdministration/dal', { params: { dtsId: dtsIdForUserBaDal, languageId: claims.languageId } });
          const status = res.status();
          let json = null;
          try { json = await res.json(); } catch { /* not JSON / empty body */ }
          const row = Array.isArray(json) ? json.find(r => r.dalId === userBaDalRow.dalId) : null;
          const identical = fieldsIdentical(userBaDalRow, row, ['dalOrder']);
          if (row && !identical) {
            notes.push(`WARNING: UpdateUserBaDal verification MISMATCH for dalId=${userBaDalRow.dalId} — before=${JSON.stringify(userBaDalRow)} after=${JSON.stringify(row)}.`);
          }
          return { status, identical };
        }));
      } else {
        notes.push('UpdateUserBaDal no-op round trip skipped: no userBaDalRow captured.');
      }

      notes.push('DeleteUserBaDal SKIPPED: hard-deletes every UserBaDal row for a whole (UserId,BAId,DTSId) at once, and re-creating via UpdateUserBaDal\'s insert path only clones template defaults from BA_DAL — it cannot restore the exact prior per-user row set/order, so this is not losslessly reversible against a real user\'s live customizations. UpdateUserBaObj SKIPPED: no GetUserBaObj endpoint exists anywhere in this folder to source current values from. SetBusinessAdministration SKIPPED: it reassigns Users.BAId for an arbitrary UserId with no self-only check and no corresponding "get current BA" read in this endpoint set — even a well-intentioned no-op write here risks permanently reassigning a real user\'s BA if the sourced "current" value were ever wrong; skipping entirely per the "when genuinely unsure, skip" rule.');
    } else {
      notes.push(`Users/BusinessAdministration/* subtree (GetUserBaDal/Dts/Mms + their Update* siblings) SKIPPED for role ${user.role}: Root/Admin have no BA_Users membership at all — only the BA-role login (baperform@gmail.com, real BA_Users membership at BA 228) is exercised here.`);
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
  // Root/Admin cover the "no per-role business logic difference" baseline (per task convention);
  // BA (baperform@gmail.com) is added because several endpoints in this phase (GetBaObj, and the
  // entire Users/BusinessAdministration/* subtree) only produce a genuine success path for a
  // caller with a real BA_Users/USER_BA_* membership, which Root/Admin do not have — see notes.
  const roleFilter = process.env.ROLE_FILTER ? process.env.ROLE_FILTER.split(',') : ['Root', 'Admin', 'BA'];
  const usersToRun = creds.users.filter(u => roleFilter.includes(u.role));
  const results = [];

  // Each role below performs exactly ONE login. 3 logins total, spaced 3s apart as a courtesy
  // margin, well under the 5/minute login rate limit.
  for (let i = 0; i < usersToRun.length; i++) {
    if (i > 0) {
      await new Promise(r => setTimeout(r, 3000));
    }
    const r = await measureScreensApi(browser, usersToRun[i]);
    results.push(r);
    console.log(JSON.stringify(r, null, 2));
  }
  await browser.close();

  const output = {
    runLabel: RUN_LABEL,
    runTimestamp: RUN_TS,
    baseUrl: creds.baseUrl,
    module: 'Screens (DAL/DTS/MMS/MTS/Object) + BusinessAdministration + Users/BusinessAdministration screen-config',
    results,
  };
  const outPath = path.join(resultsDir, `${RUN_LABEL}-${RUN_TS}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n\nSaved results to ${outPath}`);
})();
