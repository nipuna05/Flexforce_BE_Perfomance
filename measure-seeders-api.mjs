import { chromium, request } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '.credentials.local.json'), 'utf-8'));
const RUN_LABEL = process.argv[2] || 'seeders-baseline';
const RUN_TS = process.argv[3] || String(Date.now());

const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(resultsDir, { recursive: true });

const API_BASE_URL = creds.baseUrl.replace('uidemo', 'apidemo');

// =============================================================================
// MODULE 5 SCOPE: the two "seeder" endpoint groups in FlexForce_BE, read directly
// from source (src/Api/Endpoints/Objects/ObjectsDataseeder.cs,
// src/Api/Endpoints/Tokens/LanguageTokens.cs, src/Infrastructure/Data/ObjectDataSeeder.cs,
// src/Infrastructure/Data/LanguageObjectDataSeeder.cs) before writing a single line of this
// script, per the same rule measure-screens-api.mjs used: only mutate via a verified
// byte-identical no-op round trip (or a write the handler code PROVES can never change a row),
// or skip with a documented reason.
//
// Both `api/objects` and `api/language-tokens` route groups are confirmed anonymous end to
// end: neither endpoint file calls .HasPermission()/.RequireAuthorization(), and
// src/Infrastructure/DependencyInjection.cs's AddAuthorizationInternal() is a bare
// services.AddAuthorization() with no FallbackPolicy requiring authentication - so the
// LanguageTokens.cs doc-comment claim "Requires administrator privileges" is confirmed FALSE
// by source, matching the task brief. Both seeder classes are registered
// (services.AddScoped<ObjectDataSeeder>()/<LanguageObjectDataSeeder>() in
// DependencyInjection.cs), so these are live, reachable endpoints, not dead code.
//
// CRITICAL FINDING that shapes every decision below: `Objects`/`LanguageObjects` (the EF
// entities these two seeders write - DbSet<Objects> Objects / DbSet<LanguageObject>
// LanguageObjects in FlexForceDbContext.cs) are a COMPLETELY SEPARATE, much smaller table
// pair from the `OBJ`/`LAN_OBJ`/`BA_OBJ`/`USER_BA_OBJ` catalog the Screens phase exercised
// (GetObjItems/SetObjItems). Confirmed by comparing column sets: sp_GetObjItems.sql selects
// from `OBJ`/`ObjType` (OBJId, OBJTypeId, OBJName, OBJDescription, StartColumn, RowNumber,
// ColSpan, RowSpan, ParentDtsId, DETId ...) - none of which exist on the `Objects` entity
// (ObjectId, ObjectName, ObjectType int, Det_PageName int - just 4 columns total, see
// src/Domain/Object/Object.cs). This `Objects`/`LanguageObjects` pair exists for exactly one
// purpose: GetSignInTokensByLanguageIdQueryHandler.cs's raw SQL is
// `SELECT ObjectId FROM Objects WHERE Det_PageName = @PageName` joined to
// `LanguageObjects lo ... WHERE lo.LanguageId = @LanguageId AND o.ObjectId IN @ObjectIds` -
// and DetailedPageName (src/Domain/Enums/ObjectType.cs) has exactly 4 values: SignIn=1,
// Landing=2, ForgotPassword=3, ResetPassword=4. In other words: this pair of tables holds the
// text shown on the SIGN-IN, LANDING, FORGOT-PASSWORD and RESET-PASSWORD pages, globally,
// for every tenant, and is read through a 10-20 minute in-memory cache
// (GetSignInTokensByLanguageIdQueryHandler's MemoryCacheEntryOptions) - so a bad write here
// would not even surface immediately. This is a materially HIGHER blast radius than any prior
// module: BA/LIC rows are per-tenant, Objects/LanguageObjects are pre-auth, global, and cached.
//
// No GET/read endpoint anywhere in the codebase exposes a raw ObjectId for this table pair.
// The only reads that touch it at all are the 4 page-token endpoints
// (api/languages/getSignInPageTokens, getForgotPasswordPageTokens, getResetPasswordPageTokens
// - a Landing one exists in Application/ but has no mapped API route) - and those return
// {LanguageCode, ObjectName, Token} (see Application/Languages/TokenResponse.cs), never the
// numeric ObjectId the write endpoints key on. Those 3 GET endpoints are also already
// exercised by Module 2 (measure-auth-lang-api.mjs, "auth-lang" phase), so this script does
// not re-measure them - re-hitting the same anonymous GETs here would just be duplicate load
// against the shared environment, not new coverage.
// =============================================================================

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

function decodeJwtUserId(token) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(`Token does not look like a 3-part JWT (got ${parts.length} parts).`);
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  const userId = Number(payload.UserId);
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error(`Could not find a positive numeric "UserId" claim in the decoded JWT payload: ${JSON.stringify(payload)}`);
  }
  return userId;
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
  if (loginObserved?.status === 429) {
    throw new Error('Login returned 429 (rate limited) — token is garbage, do not trust anything downstream for this role.');
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

// Candidate ObjectIds for the objects/update no-op test. Objects/LanguageObjects is a small,
// dedicated table (only 4 pre-auth pages' worth of labels/buttons/fields), seeded early via
// identity column, so low integers are plausible real rows; 999999999 is a deliberate
// out-of-range sentinel guaranteed absent. It does NOT matter whether any of these IDs are
// real: ApplyUpdates (ObjectDataSeeder.cs) only ever mutates ObjectName/ObjectType/Det_PageName
// when the corresponding request field is non-null/non-empty AND different from the current
// value - sending them all as null makes `changes` provably 0 for every row in this batch,
// found or not, so SaveChangesAsync is never reached (`if (updatedCount > 0)` gates it). This
// is a stronger guarantee than a round-trip diff: it is proven safe by the code BEFORE calling.
const OBJECTS_UPDATE_CANDIDATE_IDS = [1, 2, 3, 4, 5, 999999999];

// Sentinel (LanguageId, ObjectId) pairs for the language-tokens/update no-op test, chosen to be
// certainly absent from the real table (negative id, and int32 max). This is a different safety
// mechanism than objects/update: UpdateExistingTokensAsync's Token equality-check is NOT
// null-guarded (sending Token=null for a REAL existing key would overwrite a real page string
// with null - confirmed dangerous, so null-guarding like objects/update is not an option here).
// Instead, GetExistingTokensForBatchAsync filters by `batchLanguageIds.Contains(...) &&
// batchObjectIds.Contains(...)` against the real table; a key that cannot exist returns zero
// rows, hits `if (!existingTokens.Any()) continue;`, and this method has no insert path at all
// (confirmed by reading UpdateExistingTokensAsync/ProcessBatchAsync in full) - so this is a
// provable zero-write call regardless of what Token string is sent.
const LANGUAGE_TOKENS_UPDATE_SENTINELS = [
  { LanguageId: -999999, ObjectId: -999999, Token: 'perf-test-sentinel-must-never-match-a-real-row' },
  { LanguageId: 2147483647, ObjectId: 2147483647, Token: 'perf-test-sentinel-must-never-match-a-real-row' },
];

async function measureSeedersApi(browser, user, { anonymousConfirmation }) {
  console.log(`\n########## ${user.role} (${user.username}) [Seeders API] ##########`);
  const flow = [];
  const notes = [];
  let apiCtx = null;
  let anonCtx = null;

  try {
    const token = await loginAndGetToken(browser, user, flow);
    const userId = decodeJwtUserId(token);
    notes.push(`Decoded JWT claims: userId=${userId}. Neither seeder handler reads IUserContext at all (confirmed by reading ObjectDataSeeder.cs/LanguageObjectDataSeeder.cs in full) - there is no per-role branching to measure here, the Bearer token is attached purely for consistency with the other measure-*.mjs scripts.`);

    apiCtx = await request.newContext({
      baseURL: API_BASE_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    // =====================================================================
    // api/objects/seed - SKIPPED (no live call).
    // =====================================================================
    notes.push('POST api/objects/seed SKIPPED entirely (no live call attempted): SeedBulkObjectsAsync is insert-only, keyed purely by the caller-supplied ObjectId, and uses `SET IDENTITY_INSERT [Objects] ON` to let the caller dictate an arbitrary explicit ObjectId (confirmed in ObjectDataSeeder.cs) into the SAME small global `Objects` table that GetSignInTokensByLanguageIdQueryHandler.cs reads (`SELECT ObjectId FROM Objects WHERE Det_PageName=@PageName`) to render the SignIn/Landing/ForgotPassword/ResetPassword pages for every tenant, cached 10-20 minutes. A safe no-op here would require sending an ObjectId already known to exist (so the existing-id filter skips the insert) - but no GET/read endpoint anywhere exposes the raw numeric ObjectId (the only reads on this table, the 4 page-token endpoints, return ObjectName+Token, never ObjectId), so there is no way to source a verified-existing id, and this endpoint has no matching Delete/undo endpoint in its own route group (the Screens-phase DeleteObj/DeleteDet operate on the unrelated OBJ/LAN_OBJ/BA_OBJ table set, confirmed by comparing sp_GetObjItems.sql\'s columns against Object.cs\'s 4-column Objects entity - not the same physical table). A wrong guess creates a permanent, unlisted row in login-page-critical global content with no confirmed way back. Per the task\'s decision rule, this is exactly the "ambiguous + global shared naming + no verify/undo path" case that must be skipped.');

    // =====================================================================
    // api/objects/update - TESTED LIVE: code-proven zero-write no-op.
    // =====================================================================
    flow.push(await step(`API: POST api/objects/update (UpdateExistingObjectsAsync - proven no-op, ObjectIds=[${OBJECTS_UPDATE_CANDIDATE_IDS.join(',')}], all other fields null)`, async () => {
      const res = await apiCtx.post('/api/objects/update', {
        data: { Objects: OBJECTS_UPDATE_CANDIDATE_IDS.map(id => ({ ObjectId: id, ObjectName: null, ObjectType: null, Det_PageName: null })) },
      });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, count: json?.Count ?? json?.count };
    }));
    {
      const lastCall = flow[flow.length - 1];
      const count = lastCall?.extra?.count;
      if (lastCall?.ok && count !== 0) {
        notes.push(`WARNING: api/objects/update returned Count=${count}, expected 0 — ApplyUpdates should be structurally incapable of a nonzero change count when ObjectName/ObjectType/Det_PageName are all null in the request. Investigate before trusting the "proven no-op" reasoning for this environment/version.`);
      } else if (lastCall?.ok) {
        notes.push('Confirmed live: api/objects/update returned Count=0 as predicted from source — zero rows were written, whether or not any of the probed ObjectIds exist.');
      }
    }
    notes.push('api/objects/update code-safety justification: ApplyUpdates (ObjectDataSeeder.cs) only mutates ObjectName when the request value is non-null/non-empty AND differs, ObjectType/Det_PageName only when HasValue AND differs. Sending all three as null for every ObjectId in the batch makes `changes` provably 0 per row, so `if (updatedCount > 0)` never passes and SaveChangesAsync is never invoked — proven safe before the call, not just verified after.');

    // =====================================================================
    // api/language-tokens/seed and seed-from-file - SKIPPED (no live call).
    // =====================================================================
    notes.push('POST api/language-tokens/seed and POST api/language-tokens/seed-from-file BOTH SKIPPED entirely (no live call attempted, including the multipart file-upload variant): SeedBulkTokensAsync (which seed-from-file also calls, before its own UpdateExistingTokensAsync pass) UNCONDITIONALLY overwrites Token for any (LanguageId,ObjectId) key that already exists — `record.Token = existingToken.Token ?? throw ...` runs with no equality check first, unlike ObjectDataSeeder\'s update path — and INSERTS a brand-new row for any key that does not exist. Confirmed via FlexForceDbContext.cs/LanguageObject.cs that LanguageObjects has no FK constraint to Objects at all (the only migration touching such a constraint, Iteration 3\'s "RemoveLanguageObjectAndObjectsTables", DROPPED it and none since re-added it) — so there is no DB-level safety net that would reject a fabricated ObjectId either. Combined with the same "no read endpoint exposes ObjectId" gap documented for api/objects/seed above, there is no way to construct either (a) a guaranteed-non-colliding key (an insert would then permanently pollute the SignIn/Landing/ForgotPassword/ResetPassword content table) or (b) a byte-exact current Token value for a genuinely existing key (needed because the overwrite is unconditional). This is the highest-blast-radius write in this module and is fully skipped.');

    // =====================================================================
    // api/language-tokens/update - TESTED LIVE: guaranteed-absent-key no-op.
    // =====================================================================
    flow.push(await step('API: POST api/language-tokens/update (UpdateExistingTokensAsync - guaranteed-absent sentinel keys)', async () => {
      const res = await apiCtx.post('/api/language-tokens/update', {
        data: LANGUAGE_TOKENS_UPDATE_SENTINELS,
      });
      const status = res.status();
      let json = null;
      try { json = await res.json(); } catch { /* not JSON / empty body */ }
      return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, count: json?.Count ?? json?.count };
    }));
    {
      const lastCall = flow[flow.length - 1];
      const count = lastCall?.extra?.count;
      if (lastCall?.ok && count !== 0) {
        notes.push(`WARNING: api/language-tokens/update returned Count=${count}, expected 0 for keys chosen to be certainly absent (LanguageId/ObjectId of -999999 and 2147483647) — investigate immediately, this would mean either an unexpected real row exists at one of those keys or the write happened somewhere it should not have.`);
      } else if (lastCall?.ok) {
        notes.push('Confirmed live: api/language-tokens/update returned Count=0 as predicted — the sentinel keys matched no real row, so UpdateExistingTokensAsync (which has no insert path at all) wrote nothing.');
      }
    }
    notes.push('api/language-tokens/update code-safety justification: unlike objects/update, this handler\'s Token equality check is NOT null-guarded (sending Token=null against a REAL existing key would overwrite real page text with null), so the no-op here is achieved differently — via (LanguageId,ObjectId) keys chosen to be certainly absent from the real table, so GetExistingTokensForBatchAsync\'s Contains-filtered SELECT returns zero rows and the method\'s only write path (ProcessBatchAsync, reached only for keys it already fetched) is never entered. This is a less representative latency measurement than a genuine matched-row update would be (deliberately, for safety) — it exercises the lookup query and the empty-batch short-circuit, not the compare-and-write path.');

    // =====================================================================
    // Optional: confirm the "anonymous, unenforced" finding live (only once, both roles use
    // the identical zero-write payload, so this adds no incremental data risk beyond the
    // authenticated calls above).
    // =====================================================================
    if (anonymousConfirmation) {
      anonCtx = await request.newContext({ baseURL: API_BASE_URL });
      flow.push(await step('API: POST api/objects/update WITHOUT Authorization header (confirms anonymous access - same proven no-op payload)', async () => {
        const res = await anonCtx.post('/api/objects/update', {
          data: { Objects: OBJECTS_UPDATE_CANDIDATE_IDS.map(id => ({ ObjectId: id, ObjectName: null, ObjectType: null, Det_PageName: null })) },
        });
        const status = res.status();
        let json = null;
        try { json = await res.json(); } catch { /* not JSON / empty body */ }
        return { status, url: res.url(), body: JSON.stringify(json)?.slice(0, 300) || null, count: json?.Count ?? json?.count };
      }));
      const anonResult = flow[flow.length - 1];
      if (anonResult?.extra?.status === 200) {
        notes.push('CONFIRMED LIVE (backend finding, not a script defect): api/objects/update accepted a completely unauthenticated request (no Authorization header at all) and returned 200. This live-confirms the source finding that LanguageTokens.cs/ObjectsDataseeder.cs\'s doc-comments claiming "Requires administrator privileges" are enforced nowhere — neither endpoint group calls .HasPermission()/.RequireAuthorization(), and the app has no authentication FallbackPolicy (services.AddAuthorization() in DependencyInjection.cs, no fallback). Reported as a discovered backend security finding; not fixed here (read-only measurement task).');
      } else {
        notes.push(`Anonymous-access confirmation call returned status=${anonResult?.extra?.status} — does not match the "no auth enforced anywhere" conclusion from source; investigate before repeating this finding elsewhere.`);
      }
    }

  } catch (e) {
    notes.push(`Fatal error during measurement: ${e.message}`);
    console.log('FATAL for', user.role, e.message);
  } finally {
    if (apiCtx) await apiCtx.dispose().catch(() => {});
    if (anonCtx) await anonCtx.dispose().catch(() => {});
  }

  return { role: user.role, username: user.username, flow, notes };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  // Both live-tested endpoints (objects/update, language-tokens/update) are unconditionally
  // anonymous with zero per-role branching in the handler (neither reads IUserContext) - a
  // second role would measure identical code paths, not new behavior. Kept to Root only, the
  // single lowest-risk account, matching the LIC/Screens phases' precedent for throwaway-style
  // operations against shared global data. Override with ROLE_FILTER=Root,Admin if a second
  // data point on raw latency (not behavior) is wanted.
  const roleFilter = process.env.ROLE_FILTER ? process.env.ROLE_FILTER.split(',') : ['Root'];
  const usersToRun = creds.users.filter(u => roleFilter.includes(u.role));
  const results = [];

  for (let i = 0; i < usersToRun.length; i++) {
    if (i > 0) {
      await new Promise(r => setTimeout(r, 3000));
    }
    // The unauthenticated confirmation call is only fired once total (on the first role
    // processed), not once per role - it is a single backend finding, not a per-account check.
    const r = await measureSeedersApi(browser, usersToRun[i], { anonymousConfirmation: i === 0 });
    results.push(r);
    console.log(JSON.stringify(r, null, 2));
  }
  await browser.close();

  const output = {
    runLabel: RUN_LABEL,
    runTimestamp: RUN_TS,
    baseUrl: creds.baseUrl,
    module: 'Seeders (Objects data seeder + Language Tokens seeder) - api/objects/*, api/language-tokens/*',
    results,
  };
  const outPath = path.join(resultsDir, `${RUN_LABEL}-${RUN_TS}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n\nSaved results to ${outPath}`);
})();
