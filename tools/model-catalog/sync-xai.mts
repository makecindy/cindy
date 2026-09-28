/** Run: node --import tsx tools/model-catalog/sync-xai.mts --help */
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseCatalog } from '../../packages/model-providers/src/index.js';
import { buildXaiSyncCandidate, inspectXaiImport, XAI_MODELS_URL, XAI_DETAILS_URL } from './xai-sync.js';

const { values } = parseArgs({ options: {
  help: { type: 'boolean' }, catalog: { type: 'string' }, output: { type: 'string' },
  'grok-auth': { type: 'string' }, 'account-input': { type: 'string' }, 'details-input': { type: 'string' },
  'observed-at': { type: 'string' }, 'require-complete': { type: 'boolean' },
} });
if (values.help) {
  console.log(`Sync xAI API metadata into an account-scoped Cindy catalog and verify three harness projections.

node --import tsx tools/model-catalog/sync-xai.mts --grok-auth /path/to/.grok/auth.json --output /tmp/xai-sync-run
  Alternatively set CINDY_XAI_ACCESS_TOKEN (never pass tokens as command arguments).
  --catalog FILE       Existing V5 catalog; otherwise GET the Cindy public catalog.
  --account-input FILE --details-input FILE  Offline replay; both are required together.
  --observed-at ISO     Observation time for offline replay only.
  --require-complete    Exit 2 if the report has unknown capability/price fields.

Creates a new output directory containing catalog.json and report.json only after validation.
For isolated Desktop verification use XDT_MODELS_PATH=<output>/catalog.json.
Does not modify credentials, preferences, the running app, server catalog, or scheduled tasks.
Account membership is private to this connection: do not publish this artifact as a global catalog.
Only metadata GETs; no inference requests. Verified catalog mappings supplement missing API facts.`);
  process.exit(0);
}
if (!values.output) throw new Error('--output is required');
const offline = !!values['account-input'];
if (offline !== !!values['details-input']) throw new Error('Offline replay requires both input files');
if (values['observed-at'] && !offline) throw new Error('--observed-at is only allowed for offline replay');
const readJson = async (file: string): Promise<unknown> => {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch { throw new Error('Could not read an input JSON file'); }
  // JSON.parse errors can contain source snippets, including tokens in a malformed auth file.
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error('An input file contains invalid JSON'); }
};
async function getJson(url: string, headers: Record<string, string> = {}) {
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...headers },
      redirect: 'error', signal: AbortSignal.timeout(20_000) });
  } catch { throw new Error(`Metadata GET failed: ${url}`); }
  if (!response.ok) throw new Error(`Metadata GET HTTP ${response.status}: ${url}`);
  // Do not print upstream error bodies, request headers, or credentials.
  try { return await response.json() as unknown; }
  catch { throw new Error(`Invalid JSON: ${url}`); }
}
try {
  const catalogUrl = 'https://model-access.cindy.app/api/model-catalog/catalog?registrySchemaVersion=5&registryMedia=1';
  const baseline = parseCatalog(values.catalog ? await readJson(values.catalog) : await getJson(catalogUrl));
  let account: unknown;
  let details: unknown;
  if (offline) {
    account = await readJson(values['account-input']!);
    details = await readJson(values['details-input']!);
  } else {
    let token = process.env.CINDY_XAI_ACCESS_TOKEN;
    if (values['grok-auth']) {
      const auth = await readJson(values['grok-auth']);
      // The native CLI keys its store by authorization-server URL + client ID.
      const rows = auth && typeof auth === 'object' ? Object.values(auth) : [];
      const candidates = rows.filter(row => row && typeof row === 'object' && typeof row.key === 'string');
      if (candidates.length !== 1) throw new Error('Expected exactly one Grok login; use CINDY_XAI_ACCESS_TOKEN to select explicitly');
      token = candidates[0].key;
    }
    if (!token) throw new Error('Supply --grok-auth or CINDY_XAI_ACCESS_TOKEN');
    const headers = { Authorization: `Bearer ${token}`, 'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-client-version': '1.0.3', 'x-grok-client-mode': 'interactive' };
    // Fixed official hosts only; credentials never follow redirects or a user-controlled URL.
    [account, details] = await Promise.all([getJson(XAI_MODELS_URL, headers), getJson(XAI_DETAILS_URL, headers)]);
  }
  const observedAt = values['observed-at'] ?? new Date().toISOString();
  const candidate = buildXaiSyncCandidate(baseline, account, details, observedAt);
  const report = { observedAt, scope: 'xai-subscription-account',
    sources: { membership: XAI_MODELS_URL, details: XAI_DETAILS_URL, catalog: values.catalog ? 'local' : catalogUrl },
    ...inspectXaiImport(candidate) };
  const destination = path.resolve(values.output);
  await mkdir(path.dirname(destination), { recursive: true });
  // Exclusive directory creation leaves every prior successful run untouched.
  await mkdir(destination, { mode: 0o700 });
  try {
    await writeFile(path.join(destination, 'catalog.json'), JSON.stringify(candidate.catalog, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(destination, { force: true, recursive: true });
    throw error;
  }
  console.log(JSON.stringify({ output: destination, importedModels: report.importedModels,
    harnessProjections: report.harnessProjections, complete: report.complete, gaps: report.gaps, generationRequests: 0 }, null, 2));
  if (values['require-complete'] && !report.complete) process.exitCode = 2;
} catch (error) {
  // Parser diagnostics are controlled, never serialize the upstream response or auth store.
  console.error(error instanceof Error ? error.message : 'Model sync failed');
  process.exitCode = 1;
}
