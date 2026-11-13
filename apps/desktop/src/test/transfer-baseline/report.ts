/** Machine-readable result + human table for the transfer baseline. */
import type { ContentBreakdown, DeclaredCapabilities, Direction, SocketTotals, TraceEntry, TrafficCounts, TrafficRow } from './wireMeter';
import type { CapabilitySwitches, HarnessSwitches } from './switches';
import { STUB_CHANNELS } from './hostHarness';
import { EXTRA_STAGES, LIST_REPEAT_SETUP_STAGES, LIST_REPEAT_STAGES, LIST_SCALE_SUFFIX, SCENARIO_VERSION, STAGES, V4_SETUP_STAGES, V4_STAGES, withListScale } from './scenarios';
import { LARGE_SIDEBAR_SESSIONS, SIDEBAR_SESSIONS } from './fixture';

/**
 * 2: adds `scenario`, `dataTotals`, `channels[].breakdown` and the v2 stages.
 * 3: v3 list stages, `body:` / `session:` breakdown keys.
 * 4: `declared` / `switches` / optional `trace` per profile, per-stage `signature`, v4 stages.
 * 5: top-level `harness` switches, `deflatedMessages` / `decodedUnknownMessages`, signature work patches.
 */
export const REPORT_SCHEMA_VERSION = 5;
const DIRECTIONS: Direction[] = ['controller_to_host', 'host_to_controller'];
/** Connection / reopen stages: reported in totals, not part of the measured scenario. */
const REPEAT_STAGES = withListScale(Object.values(LIST_REPEAT_STAGES).flat());
export const SETUP_STAGES = ['connect', 'connect_cold', 'extra_open', ...withListScale(LIST_REPEAT_SETUP_STAGES), ...V4_SETUP_STAGES];
const REPORTED_STAGES: string[] = [...STAGES, ...EXTRA_STAGES, ...REPEAT_STAGES, ...V4_STAGES, ...SETUP_STAGES];

export interface ProfileResult {
  profile: string;
  rows: TrafficRow[];
  sockets: SocketTotals[];
  /** What the controller put on the wire: per kind, the union over the runs of the last value each saw. */
  declared: DeclaredCapabilities;
  switches: CapabilitySwitches;
  trace: TraceEntry[];
}

export interface StageDirectionTotals extends TrafficCounts {
  /** Raw TCP bytes on the controller socket, the cross-check for wireBytes. */
  tcpBytes: number;
}

/** A stage measured what it is named after; `unknown` when encoded pushes could not be decoded. */
export interface SelfCheck {
  profile: string;
  name: string;
  result: 'pass' | 'fail' | 'unknown';
  detail: string;
}

export interface BaselineReport {
  schemaVersion: number;
  /** Checks for the stages this run measured. */
  selfChecks?: SelfCheck[];
  /**
   * v1: the four original stages. v2 adds EXTRA_STAGES, v3 adds the per-profile list-repeat
   * stages (also at listRows.large with LIST_SCALE_SUFFIX); earlier stages never change.
   */
  scenario: {
    version: number; stages: string[]; extraStages: string[];
    listRepeatStages: Record<string, string[]>; listScaleSuffix: string; listRows: { default: number; large: number };
    v4Stages: string[];
  };
  source: { commit: string | null; dirty: boolean | null };
  measuredAt: 'controller socket';
  /** Harness-wide switches of this run (switches.ts HarnessSwitches). */
  harness: HarnessSwitches;
  units: Record<string, string>;
  profiles: Record<string, {
    stages: Record<string, {
      totals: Record<Direction, StageDirectionTotals>;
      /** invoke / result / push / link traffic only: excludes transport ACKs and relay control frames, whose counts jitter by ±1 between runs. */
      dataTotals: Record<Direction, TrafficCounts>;
      /**
       * Read path of the stage: history page reads (`messages:view` results) and detail reads
       * (`work-details`), each with how many were notModified. Two runs of one commit should
       * agree; a different signature means the run took another timing path.
       */
      signature: {
        historyReads: number; historyNotModified: number; detailReads: number; detailNotModified: number;
        /** maker:history-work-patch / maker:history-view-changed pushes (host-side notice timing). */
        workPatches: number; historyNotices: number;
      };
      channels: Array<Omit<TrafficRow, 'stage' | 'side' | 'breakdown'> & { stub?: true; breakdown?: ContentBreakdown }>;
    }>;
    extensions: string[];
    /** Capabilities actually declared on the wire, and the switches that produced them. */
    declared: DeclaredCapabilities;
    switches: CapabilitySwitches;
    /** Only with TRANSFER_BASELINE_TRACE. */
    trace?: TraceEntry[];
  }>;
}

const COUNT_KEYS: (keyof TrafficCounts)[] = ['wireBytes', 'decodedBytes', 'frames', 'messages', 'retransmitFrames', 'gzipMessages', 'notModifiedMessages', 'makerEvents', 'deflatedMessages', 'decodedUnknownMessages'];

function add(target: TrafficCounts, row: TrafficCounts): void {
  for (const key of COUNT_KEYS) target[key] += row[key];
}

function zeroCounts(): TrafficCounts {
  return { wireBytes: 0, decodedBytes: 0, frames: 0, messages: 0, retransmitFrames: 0, gzipMessages: 0, notModifiedMessages: 0, makerEvents: 0, deflatedMessages: 0, decodedUnknownMessages: 0 };
}

function zero(): StageDirectionTotals {
  return { ...zeroCounts(), tcpBytes: 0 };
}

export function buildReport(results: ProfileResult[], source: BaselineReport['source'], harness: HarnessSwitches): BaselineReport {
  const report: BaselineReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    scenario: {
      version: SCENARIO_VERSION, stages: [...STAGES], extraStages: [...EXTRA_STAGES],
      listRepeatStages: Object.fromEntries(Object.entries(LIST_REPEAT_STAGES).map(([profile, names]) => [profile, [...names]])),
      listScaleSuffix: LIST_SCALE_SUFFIX, listRows: { default: SIDEBAR_SESSIONS, large: LARGE_SIDEBAR_SESSIONS },
      v4Stages: [...V4_STAGES],
    },
    source,
    measuredAt: 'controller socket',
    harness,
    units: {
      wireBytes: 'WebSocket frame bytes (header + payload as written by the client; pre-deflate if permessage-deflate is negotiated)',
      decodedBytes: 'logical message bytes after reassembly and result gzip inflation',
      frames: 'WebSocket text frames',
      messages: 'logical messages (reassembled reliable messages / single frames)',
      tcpBytes: 'raw TCP bytes on the controller socket (cross-check; includes HTTP upgrade)',
    },
    profiles: {},
  };
  for (const result of results) {
    const stages: BaselineReport['profiles'][string]['stages'] = {};
    const extensions = new Set<string>();
    for (const stage of REPORTED_STAGES) {
      const rows = result.rows.filter((row) => row.stage === stage && row.side === 'controller');
      if (rows.length === 0) continue;
      const totals = { controller_to_host: zero(), host_to_controller: zero() };
      const dataTotals = { controller_to_host: zeroCounts(), host_to_controller: zeroCounts() };
      for (const row of rows) {
        add(totals[row.direction], row);
        if (row.kind !== 'transport-ack' && row.kind !== 'control') add(dataTotals[row.direction], row);
      }
      for (const socket of result.sockets.filter((s) => s.stage === stage && s.side === 'controller')) {
        totals.controller_to_host.tcpBytes += socket.tcpBytesWritten;
        totals.host_to_controller.tcpBytes += socket.tcpBytesRead;
        socket.extensions.forEach((value) => extensions.add(value));
      }
      const reads = (channel: string) => rows.find((row) => row.kind === 'result' && row.channel === channel && row.direction === 'host_to_controller');
      const view = reads('local-db:messages:view');
      const details = reads('local-db:messages:work-details');
      stages[stage] = {
        totals,
        dataTotals,
        signature: {
          historyReads: view?.messages ?? 0, historyNotModified: view?.notModifiedMessages ?? 0,
          detailReads: details?.messages ?? 0, detailNotModified: details?.notModifiedMessages ?? 0,
          workPatches: rows.find((row) => row.kind === 'push' && row.channel === 'maker:history-work-patch')?.messages ?? 0,
          historyNotices: rows.find((row) => row.kind === 'push' && row.channel === 'maker:history-view-changed')?.messages ?? 0,
        },
        channels: rows
          .sort((a, b) => a.direction.localeCompare(b.direction) || b.wireBytes - a.wireBytes || a.channel.localeCompare(b.channel))
          .map((full) => {
            const row = { direction: full.direction, kind: full.kind, channel: full.channel,
              wireBytes: full.wireBytes, decodedBytes: full.decodedBytes, frames: full.frames, messages: full.messages,
              retransmitFrames: full.retransmitFrames, gzipMessages: full.gzipMessages,
              notModifiedMessages: full.notModifiedMessages, makerEvents: full.makerEvents,
              deflatedMessages: full.deflatedMessages, decodedUnknownMessages: full.decodedUnknownMessages,
              ...(Object.keys(full.breakdown).length ? { breakdown: full.breakdown } : {}) };
            return row.channel in STUB_CHANNELS ? { ...row, stub: true as const } : row;
          }),
      };
    }
    report.profiles[result.profile] = {
      stages, extensions: [...extensions], declared: result.declared, switches: result.switches,
      ...(result.trace.length ? { trace: result.trace } : {}),
    };
  }
  return report;
}

const kib = (bytes: number) => (bytes >= 10_240 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`);

export function renderMarkdown(report: BaselineReport): string {
  const lines: string[] = [];
  lines.push(`# Device Link transfer baseline`, '');
  lines.push(`Source: \`${report.source.commit ?? 'unknown'}\`${report.source.dirty ? ' (dirty worktree)' : ''}. Scenario v${report.scenario?.version ?? 1}. Measured on the controller socket; ↑ controller→host, ↓ host→controller.`, '');
  if (report.harness) lines.push(`Harness: ${Object.entries(report.harness).map(([key, value]) => `${key}=${value}`).join(', ')}.`, '');
  if (report.selfChecks) {
    const tally = (result: SelfCheck['result']) => report.selfChecks!.filter((check) => check.result === result).length;
    const notable = report.selfChecks.filter((check) => check.result !== 'pass').map((check) => `${check.profile} ${check.name} ${check.result} (${check.detail})`);
    lines.push(`Self-checks: ${tally('pass')} pass, ${tally('fail')} fail, ${tally('unknown')} unknown${notable.length ? `: ${notable.join('; ')}` : ''}.`, '');
  }
  for (const [profile, value] of Object.entries(report.profiles)) {
    lines.push(`## ${profile}`, '');
    lines.push(`WebSocket extensions: ${value.extensions.join(', ') || 'none'}. With permessage-deflate negotiated, frame wire bytes are pre-deflate and the TCP columns are the real wire.`, '');
    const switched = Object.entries(value.switches ?? {}).filter(([, names]) => names.length).map(([key, names]) => `${key}=${names.join(',')}`);
    lines.push(`Declared: link-open \`${(value.declared?.linkOpen ?? []).join(', ')}\`; hello \`${(value.declared?.hello ?? []).join(', ')}\`. Switches: ${switched.join('; ') || 'none'}.`, '');
    lines.push('| Stage | ↑ wire | ↑ TCP | ↑ msgs/frames | ↓ wire | ↓ TCP | ↓ decoded | ↓ msgs/frames | ↓ gzip / 304 | maker events | reads (view/304, details/304), work patches |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const [stage, data] of Object.entries(value.stages)) {
      const up = data.totals.controller_to_host;
      const down = data.totals.host_to_controller;
      const sig = data.signature;
      const unknown = down.decodedUnknownMessages ? ` (+${down.decodedUnknownMessages} unknown)` : '';
      lines.push(`| ${stage} | ${kib(up.wireBytes)} | ${kib(up.tcpBytes)} | ${up.messages}/${up.frames} | ${kib(down.wireBytes)} | ${kib(down.tcpBytes)} | ${kib(down.decodedBytes)}${unknown} | ${down.messages}/${down.frames} | ${down.gzipMessages} / ${down.notModifiedMessages} | ${down.makerEvents} | ${sig.historyReads}/${sig.historyNotModified}, ${sig.detailReads}/${sig.detailNotModified}, patches ${sig.workPatches} |`);
    }
    lines.push('');
    for (const [stage, data] of Object.entries(value.stages)) {
      if (SETUP_STAGES.includes(stage)) continue;
      lines.push(`<details><summary>${profile} · ${stage} by channel</summary>`, '');
      lines.push('| Dir | Kind | Channel | Wire | Decoded | Msgs | Frames | Decoded by content |');
      lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | --- |');
      for (const row of data.channels) {
        const content = Object.entries(row.breakdown ?? {}).sort((a, b) => b[1].bytes - a[1].bytes)
          .map(([key, value]) => `${key} ${value.count}× ${kib(value.bytes)}`).join('; ');
        lines.push(`| ${row.direction === 'controller_to_host' ? '↑' : '↓'} | ${row.kind} | \`${row.channel}\`${row.stub ? ' (stub)' : ''} | ${kib(row.wireBytes)} | ${kib(row.decodedBytes)} | ${row.messages} | ${row.frames} | ${content} |`);
      }
      lines.push('', '</details>', '');
    }
  }
  return lines.join('\n');
}

export { DIRECTIONS };
