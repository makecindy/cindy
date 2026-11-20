/**
 * Device Link transfer baseline: one fixed session per controller profile over a
 * loopback self-hosted relay, counted frame by frame on the controller socket.
 * Run with `pnpm transfer:baseline` (see ./README.md). Output directory comes from
 * TRANSFER_BASELINE_OUT (default: <os tmp>/cindy-transfer-baseline).
 */
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type WebSocket from 'ws';
import { encodeReliableFrames, MAX_TRANSPORT_CHUNK_BYTES, PROTOCOL_VERSION } from '@cindy/device-link';
import { buildFixture, LARGE_SIDEBAR_SESSIONS } from './fixture';
import { startBaselineHost } from './hostHarness';
import { PROFILES } from './profiles';
import { buildReport, renderMarkdown, type BaselineReport, type ProfileResult, type SelfCheck } from './report';
import { startBaselineRelay } from './relay';
import { EXTRA_STAGES, LIST_REPEAT_STAGES, LIST_SCALE_SUFFIX, STAGES, V4_STAGES, runListRepeat, runProfile, runV4, withListScale, type ScenarioEnv } from './scenarios';
import type { ControllerProfile } from './profiles';
import { applyCapabilitySwitches, readCapabilitySwitches, readHarnessSwitches } from './switches';
import type { DeclaredCapabilities } from './wireMeter';
import { webSocketFrameBytes, WireMeter } from './wireMeter';

// PR #9937: the meter's public socket tap must attribute duplicate segments'
// frames, bytes and retransmit counts to the same channel. The fixed-session
// self-checks did not inject duplicates. Manual baseline tier, in-memory socket.
it('wire meter attributes in-flight and completed retransmits to their actual channel', () => {
  const meter = new WireMeter();
  const socket = Object.assign(new EventEmitter(), { send: () => {} });
  meter.tap(socket as unknown as WebSocket, 'controller');
  meter.setStage('segmented');
  const logical = { channel: 'maker:event', payload: { text: 'x'.repeat(MAX_TRANSPORT_CHUNK_BYTES + 1) } };
  const frames = encodeReliableFrames({ v: PROTOCOL_VERSION, kind: 'push', payload: logical }, 'meter-stream', 1);
  expect(frames.length).toBeGreaterThan(1);
  const observed = [frames[0], frames[0], ...frames.slice(1), frames[0]];
  for (const frame of observed) socket.emit('message', Buffer.from(JSON.stringify(frame)), false);
  const rows = meter.finish().rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ channel: 'maker:event', kind: 'push', frames: observed.length,
    retransmitFrames: 2, messages: 1, decodedBytes: Buffer.byteLength(JSON.stringify(logical)),
    wireBytes: observed.reduce((sum, frame) => sum + webSocketFrameBytes(Buffer.byteLength(JSON.stringify(frame)), false), 0) });
});

const HOST_ID = 'baseline-host';

/** One loopback relay + controlled host for one profile; torn down even when a stage fails. */
async function withEnvironment(fixture: ReturnType<typeof buildFixture>, meter: WireMeter, dropTransfer: readonly string[],
  run: (env: ScenarioEnv) => Promise<void>): Promise<void> {
  const relay = await startBaselineRelay(HOST_ID, PROFILES.map((p) => ({ deviceId: p.deviceId, deviceName: p.deviceName, platform: p.platform })));
  try {
    const host = await startBaselineHost({ wsUrl: relay.wsUrl, deviceId: HOST_ID, credential: relay.credentials.get(HOST_ID)!, meter, fixture });
    try {
      await expect.poll(() => host.client.getStatus(), { timeout: 15_000, interval: 20 }).toBe('online');
      await run({ host, meter, wsUrl: relay.wsUrl, credentials: relay.credentials, dropTransfer });
    } finally {
      await host.close();
    }
  } finally {
    await relay.close();
  }
}

function sourceInfo(): { commit: string | null; dirty: boolean | null } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

it('measures the fixed remote session for every controller profile', async () => {
  const harness = readHarnessSwitches();
  const fixture = buildFixture(undefined, { realisticRows: harness.realisticRows });
  const largeFixture = buildFixture(LARGE_SIDEBAR_SESSIONS, { realisticRows: harness.realisticRows });
  const only = process.env.TRANSFER_BASELINE_PROFILE;
  const profiles = PROFILES.filter((p) => !only || p.id === only);
  if (profiles.length === 0) throw new Error(`TRANSFER_BASELINE_PROFILE must be one of: ${PROFILES.map((p) => p.id).join(', ')}`);
  const results: ProfileResult[] = [];
  // Debug aids: TRANSFER_BASELINE_TRACE=stage,stage (or *) keeps a per-message timeline in the
  // JSON; TRANSFER_BASELINE_SCOPE=v1 stops after the v1 stages, =lists runs only the v3 list
  // stages (both sizes), for quick checks.
  const traceStages = new Set((process.env.TRANSFER_BASELINE_TRACE ?? '').split(',').map((name) => name.trim()).filter(Boolean));
  const scope = process.env.TRANSFER_BASELINE_SCOPE ?? 'all';
  if (!['all', 'v1', 'lists'].includes(scope)) throw new Error('TRANSFER_BASELINE_SCOPE must be all, v1 or lists');
  const v1Only = scope === 'v1';
  for (const base of profiles) {
    const switches = readCapabilitySwitches(base.id);
    const profile = applyCapabilitySwitches(base, switches);
    // v1 + v2 on one host; v3 (two list sizes) and v4 each on fresh hosts.
    type Run = [ReturnType<typeof buildFixture>, (env: ScenarioEnv) => Promise<void>];
    const runs: Run[] = [];
    if (scope !== 'lists') runs.push([fixture, (env) => runProfile(env, profile, { v1Only })]);
    if (scope !== 'v1') {
      runs.push([fixture, (env) => runListRepeat(env, profile)]);
      runs.push([largeFixture, (env) => runListRepeat(env, profile, LIST_SCALE_SUFFIX)]);
    }
    if (scope === 'all') runs.push([fixture, (env) => runV4(env, profile)]);
    const parts = [];
    const declared: DeclaredCapabilities = {};
    for (const [stageFixture, run] of runs) {
      const meter = new WireMeter(traceStages);
      await withEnvironment(stageFixture, meter, switches.dropTransfer, run);
      parts.push({ ...meter.finish(), trace: meter.trace });
      for (const key of ['hello', 'linkOpen', 'subscribe'] as const) {
        const seen = meter.declared[key];
        if (seen) declared[key] = [...new Set([...(declared[key] ?? []), ...seen])];
      }
    }
    results.push({
      profile: profile.id, rows: parts.flatMap((part) => part.rows), sockets: parts.flatMap((part) => part.sockets),
      declared, switches, trace: parts.flatMap((part) => part.trace),
    });
  }
  const report = buildReport(results, sourceInfo(), harness);
  report.selfChecks = selfChecks(report);
  const outDir = process.env.TRANSFER_BASELINE_OUT || path.join(os.tmpdir(), 'cindy-transfer-baseline');
  await mkdir(outDir, { recursive: true });
  const markdown = renderMarkdown(report);
  await writeFile(path.join(outDir, 'transfer-baseline.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outDir, 'transfer-baseline.md'), `${markdown}\n`);
  process.stdout.write(`\n${markdown}\n\nWrote ${path.join(outDir, 'transfer-baseline.json')}\n`);
  // Written first, so a failed check still leaves the data; `unknown` (undecodable pushes) does not fail.
  const failed = (report.selfChecks ?? []).filter((check) => check.result === 'fail');
  expect(failed.map((check) => `${check.profile} ${check.name}: ${check.detail}`)).toEqual([]);
});

/** The stages that ran must have measured what they are named after (stages a scope skipped are not checked). */
function selfChecks(report: BaselineReport): SelfCheck[] {
  const checks: SelfCheck[] = [];
  for (const [id, profile] of Object.entries(report.profiles)) {
    const ran = (stage: string) => stage in profile.stages;
    const channel = (stage: string, kind: string, name: string) =>
      profile.stages[stage]?.channels.find((row) => row.direction === 'host_to_controller' && row.kind === kind && row.channel === name);
    const check = (name: string, ok: boolean, detail: string, unknown = false) =>
      checks.push({ profile: id, name, result: unknown ? 'unknown' : ok ? 'pass' : 'fail', detail });
    const atLeast = (name: string, stage: string, kind: string, channelName: string, min: number) => {
      if (!ran(stage)) return;
      const count = channel(stage, kind, channelName)?.messages ?? 0;
      check(name, count >= min, `${count} ${channelName} ${kind} messages (want >= ${min})`);
    };
    const repeat = withListScale(LIST_REPEAT_STAGES[id as ControllerProfile['id']]);
    for (const stage of [...STAGES, ...EXTRA_STAGES, ...repeat, ...V4_STAGES].filter(ran)) {
      const messages = profile.stages[stage].totals.host_to_controller.messages;
      check(`${stage} has traffic`, messages > 0, `${messages} messages`);
    }
    atLeast('expand details', 'expand_work_groups', 'result', 'local-db:messages:work-details', 2);
    if (ran('live_turn_tool_results')) {
      const batch = channel('live_turn_tool_results', 'push', 'maker:event:batch');
      const visible = batch?.breakdown?.['event:tool_result_full']?.count ?? 0;
      check('visible results', visible === 6, `${visible} tool_result_full events (want 6)`, (batch?.decodedUnknownMessages ?? 0) > 0);
    }
    atLeast('expanded refetch', 'live_turn_with_expanded', 'result', 'local-db:messages:work-details', 1);
    for (const stage of repeat) atLeast(`${stage} list read`, stage, 'result', 'local-db:sessions:list', 1);
    atLeast('noskip read-ahead', 'reconnect_after_prefetch_noskip', 'result', 'local-db:messages:view', 5);
    atLeast('running group expanded', 'live_turn_expanded_running', 'result', 'local-db:messages:work-details', 1);
  }
  return checks;
}
