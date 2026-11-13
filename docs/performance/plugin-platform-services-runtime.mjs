import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

const host = process.cwd();
const load = file => import(pathToFileURL(path.resolve(host, file)).href);
const { createHostToolService } = await load('src/agent/host-tools.ts');
const { createHostConfirmations } = await load('src/host-confirmations.ts');
const { GhostInstallReceiptStore, createGhostInstallReceipt } = await load('../desktop/src/main/cindy-brain/ghostInstallReceipt.ts');
const { validateGhostManifest } = await load('../desktop/src/shared/ghost.ts');
const { HostStorageService } = await load('../desktop/src/main/cindy-brain/storageService.ts');
const { setCurrentDbClient, clearCurrentDbClient } = await load('../desktop/src/main/localDb/client/current.ts');

const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-platform-perf-')));
const root = path.join(profile, 'receipts');
await fs.mkdir(root);
const parsed = validateGhostManifest({ schemaVersion: 3, minCindyVersion: '0.1.61', id: 'bench', name: 'Benchmark', version: '1.0.0',
  kind: 'chip', entry: 'main.js', agent: { hostTools: ['terminal', 'discovery', 'storage'] } });
if (!parsed.ok) throw new Error(parsed.reason);
const receipt = createGhostInstallReceipt({ manifest: parsed.manifest, localeResources: {}, enabled: true,
  trust: { level: 'unverified', publisherSigned: false, publisherVerified: false, reviewed: false },
  skillContentSha256: {}, approvedHostToolGroups: ['terminal', 'discovery', 'storage'] });
await fs.writeFile(path.join(root, 'bench.json'), JSON.stringify(receipt));
const store = new GhostInstallReceiptStore(() => root);
let reads = 0, readMs = 0;
const getGhost = () => {
  const start = performance.now();
  const loaded = store.read('bench');
  reads++; readMs += performance.now() - start;
  if (loaded.state !== 'approved') throw new Error(JSON.stringify(loaded));
  const value = loaded.receipt;
  return { dir: profile, enabled: value.enabled, manifest: value.manifest,
    approval: { state: 'approved', revision: value.revision }, namespace: null, namespaceState: 'confirmed',
    approvedHostToolGroups: value.approvedHostToolGroups };
};
const database = { drizzle: {} };
setCurrentDbClient(database, 'owner');
const idle = async () => {
  global.gc?.();
  const before = process.memoryUsage(), start = performance.now(), cpu = process.cpuUsage();
  await wait(2000);
  const used = process.cpuUsage(cpu), after = process.memoryUsage(), ms = performance.now() - start;
  return { elapsedMs: ms, cpuMs: (used.user + used.system) / 1000,
    cpuPercentOfOneCore: (used.user + used.system) / (ms * 10),
    heapUsedDelta: after.heapUsed - before.heapUsed, rssDelta: after.rss - before.rss };
};
const report = { node: process.version, platform: process.platform, samples: 50, receiptBytes: Buffer.byteLength(JSON.stringify(receipt)),
  scope: 'Isolated production Node Host tool assembly; real receipt IO, fake DB port; excludes app startup and GhostManager projection.' };
report.idleControl = await idle();
const resourcesBefore = process.getActiveResourcesInfo();
const started = performance.now();
const confirmations = createHostConfirmations({ current: () => true });
const storage = new HostStorageService({ ownerKey: () => 'owner', getGhost, listGhosts: () => [getGhost()],
  providers: [{ id: 'fixture', operations: ['read'], available: () => true, call: async () => ({ ok: true, value: 'bounded' }) }],
  handoff: {}, confirmShare: async () => false });
const service = createHostToolService({ profileDir: profile, ownerId: 'owner', current: () => true,
  owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }), getGhost, getSession: () => undefined,
  manager: {}, confirmations, storage: () => storage, t: key => key });
report.assemblyMs = performance.now() - started;
report.resourcesBefore = resourcesBefore;
report.resourcesAfter = process.getActiveResourcesInfo();
report.idleUnusedAssembly = await idle();
const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
report.calls = [];
for (const [tool, args] of [['terminal_list', {}], ['host_services', {}],
  ['storage_request', { op: 'providers' }], ['storage_request', { op: 'call', provider: 'fixture', request: { op: 'read' } }]]) {
  const run = async () => {
    const result = await service.request('bench', { type: 'host-tool-request', server: 'cindy_helper', tool, args }, () => true);
    const value = JSON.parse(result.content.find(item => item.type === 'text').text);
    if (value.ok !== true) throw new Error(JSON.stringify(value));
  };
  for (let warm = 0; warm < 5; warm++) await run();
  reads = 0; readMs = 0;
  const times = [], counts = [];
  for (let sample = 0; sample < report.samples; sample++) {
    const before = reads, start = performance.now();
    await run(); times.push(performance.now() - start); counts.push(reads - before);
  }
  times.sort((a, b) => a - b);
  report.calls.push({ tool, op: args.op, readsPerCall: [...new Set(counts)],
    p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), meanReceiptMsPerCall: readMs / report.samples });
}
service.close(); confirmations.close(); clearCurrentDbClient(database);
report.resourcesAfterClose = process.getActiveResourcesInfo();
await fs.writeFile('/tmp/plugin-platform-perf-runtime-results.json', JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
