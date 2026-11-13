/**
 * The fixed baseline session. One run per controller profile, four measured stages
 * (plus `connect` stages that are reported separately):
 *
 *  1. open_long_task  — cold open of a 10-turn task (no local cache on the controller).
 *  2. live_turn       — the host runs one turn on that open task: text stream, five
 *                       tool calls and one 1.05 MiB tool result.
 *  3. reconnect       — the controller loses its network, the host finishes a short
 *                       turn meanwhile, the controller reconnects and catches up.
 *  4. sidebar_refresh — a freshly started controller loads the task list and reads
 *                       ahead the five most recent histories.
 *
 * Controller request sequences are scripted from the cited controller code; history
 * reads, debouncing and work patches run through the real shared HistoryViewController,
 * and Mobile reconnect uses the real Mobile recovery core.
 */
import {
  MAKER_EVENT_BATCH_CHANNEL,
  PeerRecoveryScheduler,
  PROTOCOL_VERSION,
  type Envelope,
  type LinkOpenPayload,
  type PushPayload,
} from '@cindy/device-link';
import {
  historyPrefetchVersion,
  historyViewLeaves,
  selectHistoryPrefetchSessions,
  type HistoryMessageSource,
  type HistoryViewController,
  type HistoryWorkPatch,
} from '@cindy/maker-shared/message-window';
import path from 'node:path';
import { capToolResultTextForPersist } from '../../shared/toolResultPersistCap';
import { readHarnessSwitches } from './switches';
import type { BaselineController } from './controllerHarness';
import { startBaselineController } from './controllerHarness';
import { FIXTURE_EPOCH, LONG_SESSION_ID, codeText, createRandom, fixtureId, turnTools, zhProse, LONG_TURN, SHORT_TURN, type TurnShape } from './fixture';
import type { BaselineHost } from './hostHarness';
import type { ControllerProfile } from './profiles';
import type { WireMeter } from './wireMeter';

export const STAGES = ['open_long_task', 'live_turn', 'reconnect', 'sidebar_refresh'] as const;
/**
 * Added in scenario v2, after the v1 stages so v1 numbers stay comparable:
 *  5. live_turn_tool_results  — a turn whose ordinary-size tool results are not
 *                               deferred (Edit / Write / TodoWrite / Agent / plugin call /
 *                               a failed command), i.e. they ride maker:event and
 *                               messages:created, including Mobile's 8 KB preview.
 *  6. expand_work_groups      — expand a folded history group, collapse it, then expand
 *                               the live turn's group holding the 1.05 MiB result.
 *  7. live_turn_with_expanded — another live turn while that completed group stays expanded.
 */
export const EXTRA_STAGES = ['live_turn_tool_results', 'expand_work_groups', 'live_turn_with_expanded'] as const;
/**
 * Added in scenario v3 (sidebar repeat reads; earlier stages unchanged). Each runs on a
 * controller that has already read the list once in the same process, so list deltas,
 * notModified and read-ahead skipping can show up:
 *  - phone:   backgrounded past the stop grace (client.stop() keeping the result cache, as in
 *             production; TRANSFER_BASELINE_PHONE_STOP_RETAIN=0 for a plain stop), foregrounded,
 *             list re-read, with the list unchanged and with one task changed meanwhile;
 *  - desktop: periodic reconcile with the list unchanged and with one task changed.
 * Each also runs against a 200-task list, with LIST_SCALE_SUFFIX appended to its name.
 */
export const LIST_REPEAT_STAGES = {
  phone: ['foreground_list_unchanged', 'foreground_list_changed'],
  desktop: ['reconcile_list_unchanged', 'reconcile_list_changed'],
} as const;
export const LIST_REPEAT_SETUP_STAGES = ['v3_connect', 'v3_list_first', 'v3_tick_first'] as const;
export const LIST_SCALE_SUFFIX = '.rows200';

/** Stage names with their list-scale variants, in report order. */
export function withListScale(names: readonly string[]): string[] {
  return names.flatMap((name) => [name, `${name}${LIST_SCALE_SUFFIX}`]);
}
/**
 * Added in scenario v4 (earlier stages unchanged), on their own host, in this order on one
 * controller that started on Home (list + read-ahead) and then opened the long task:
 *  - reconnect_after_prefetch:        reconnect with the read-ahead record kept, as the real
 *                                     App does in one process (unchanged tasks are skipped);
 *  - reconnect_after_prefetch_noskip: the same again with the record ignored, i.e. what those
 *                                     five pages cost when re-read (see session:<id> breakdown);
 *  - reconnect_after_long_turn:       while offline the host finishes a whole long turn with
 *                                     ordinary-size tool results, then the controller catches up;
 *  - live_turn_expanded_running:      the controller expands the running work group, then the
 *                                     host publishes a 1.05 MiB result (production shape).
 */
// v4 also paces every watched live turn in steps (HostTurnHooks.step): live_turn,
// live_turn_tool_results, live_turn_with_expanded and live_turn_expanded_running change
// numbers from v3 and become deterministic; all other earlier stages are unchanged.
export const V4_STAGES = ['reconnect_after_prefetch', 'reconnect_after_prefetch_noskip', 'reconnect_after_long_turn', 'live_turn_expanded_running'] as const;
export const V4_SETUP_STAGES = ['v4_connect', 'v4_home', 'v4_open'] as const;
export const SCENARIO_VERSION = 4;

/** Longest quiet gap inside a stage: host notice (500 ms) / Desktop repair debounce (1.5 s). */
const SETTLE_IDLE_MS = 2_200;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ScenarioEnv {
  host: BaselineHost;
  meter: WireMeter;
  wsUrl: string;
  credentials: Map<string, string>;
  /** Per-request transfer fields stripped from controller invokes (switches.ts). */
  dropTransfer?: readonly string[];
}

async function settle(env: ScenarioEnv, controller: BaselineController | null, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const queued = controller
      ? env.host.client.getReliableSendQueueDepth(controller.profile.deviceId)
        + controller.client.getReliableSendQueueDepth(env.host.deviceId)
      : 0;
    if (queued === 0 && env.meter.idleMs() >= SETTLE_IDLE_MS) return;
    if (Date.now() > deadline) throw new Error(`stage ${env.meter.currentStage} did not settle`);
    await sleep(100);
  }
}

async function until(check: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

// ─── host turn generator ────────────────────────────────────────────────────

let liveRow = 0;
const liveId = (kind: string) => fixtureId(`live${kind}`, ++liveRow);
let liveClock = FIXTURE_EPOCH + 60_000;
const nextAt = () => (liveClock += 1_000);

/** The large live tool result: T3's 1.05 MiB fresh-turn result. */
export const LIVE_LARGE_RESULT_BYTES = Math.round(1.05 * 1024 * 1024);

/**
 * One Agent turn as the main process publishes it: maker:event for every streamed
 * piece (register.ts:26153 payload shape), rows persisted through createMessage.
 */
/** Turn start as the main process publishes it (register.ts:6094 status, maker:event, user row). */
async function beginTurn(host: BaselineHost, sessionId: string, userText: string): Promise<void> {
  host.setRunning(sessionId, true);
  host.broadcast('maker:status-changed', { sessionId, status: 'running' });
  host.makerEvent(sessionId, { type: 'status', data: { status: 'running' } });
  await host.persist(sessionId, { clientId: liveId('u'), role: 'user', content: { text: userText, images: [], files: [] }, toolUseId: null, createdAt: nextAt() });
}

/** Streamed answer, final text, completed assistant row, done, idle, list patch. */
async function finishTurn(host: BaselineHost, sessionId: string, answer: string, textDeltas: number): Promise<void> {
  const answerId = liveId('a');
  const step = Math.ceil(answer.length / textDeltas);
  for (let i = 0; i < textDeltas; i++) {
    host.makerEvent(sessionId, { type: 'text', data: { text: answer.slice(i * step, (i + 1) * step), isFinal: false } }, answerId);
    await sleep(25);
  }
  host.makerEvent(sessionId, { type: 'text', data: { text: answer, isFinal: true } }, answerId);
  await host.persist(sessionId, { clientId: answerId, role: 'assistant', content: answer, toolUseId: null, agentMeta: { turnCompleted: true }, createdAt: nextAt() });
  host.makerEvent(sessionId, { type: 'done', data: {} });
  host.setRunning(sessionId, false);
  host.broadcast('maker:status-changed', { sessionId, status: 'idle' });
  host.patchSession(sessionId, { lastTurnEndedAt: liveClock, updatedAt: liveClock });
}

/**
 * One Agent turn as the main process publishes it: maker:event for every streamed
 * piece (register.ts:26153 payload shape), rows persisted through createMessage.
 * v1 stages publish tool_result_full without resolvedContent. Returns the createdAt of
 * the large result row when the shape has one.
 */
interface HostTurnHooks {
  /** Publish tool results in the production shape (with resolvedContent); v1/v2 turns omit it. */
  resolvedContent?: boolean;
  /** Runs after the large tool has started and before its result is published. */
  beforeLargeResult?: () => Promise<void>;
  /**
   * Scenario v4 pacing for a watched turn: after each step (user message, thinking, each tool,
   * the answer) wait until the controller's debounced reads have run and the link is quiet.
   * Every read then sees a whole step, so the run no longer depends on millisecond races
   * between host writes and controller timers. Offline turns pass none.
   */
  step?: () => Promise<void>;
}

async function runHostTurn(host: BaselineHost, sessionId: string, seed: number, shape: TurnShape & { textDeltas: number },
  hooks: HostTurnHooks = {}): Promise<number | null> {
  const random = createRandom(seed);
  await beginTurn(host, sessionId, zhProse(random, shape.userChars));
  await hooks.step?.();
  const thinking = zhProse(random, shape.thinkingChars);
  for (let i = 0; i * 100 < thinking.length; i++) {
    host.makerEvent(sessionId, { type: 'thinking', data: { text: thinking.slice(i * 100, (i + 1) * 100), isFinal: false } });
    await sleep(30);
  }
  await host.persist(sessionId, { clientId: liveId('t'), role: 'thinking', content: { kind: 'thinking', text: thinking, durationMs: 1_500, isRedacted: false }, toolUseId: null, createdAt: nextAt() });
  await hooks.step?.();
  const tools = turnTools(random, shape);
  const largeIndex = shape.largeResultBytes > 0 ? tools.length - 1 : -1;
  if (largeIndex >= 0) tools[largeIndex].result = codeText(random, LIVE_LARGE_RESULT_BYTES);
  let largeAt: number | null = null;
  for (const [index, tool] of tools.entries()) {
    const toolUseId = liveId('tool');
    host.noteToolName(toolUseId, tool.toolName);
    host.makerEvent(sessionId, { type: 'tool_use', data: { toolUseId, toolName: tool.toolName, input: tool.input } });
    await host.persist(sessionId, { clientId: liveId('tu'), role: 'tool_use', content: { toolUseId, toolName: tool.toolName, input: tool.input }, toolUseId, createdAt: nextAt() });
    await sleep(150);
    const resultId = liveId('tr');
    if (index === largeIndex) await hooks.beforeLargeResult?.();
    if (hooks.resolvedContent) {
      host.broadcast('maker:event', { sessionId, event: { type: 'tool_result_full', data: { toolUseId, fullText: tool.result } }, persistId: resultId, resolvedContent: tool.result });
    } else host.makerEvent(sessionId, { type: 'tool_result_full', data: { toolUseId, fullText: tool.result } }, resultId);
    const resultAt = nextAt();
    if (index === largeIndex) largeAt = resultAt;
    await host.persist(sessionId, { clientId: resultId, role: 'tool_result', content: capToolResultTextForPersist(tool.result), toolUseId, createdAt: resultAt });
    await sleep(100);
    await hooks.step?.();
  }
  await finishTurn(host, sessionId, zhProse(random, shape.answerChars), shape.textDeltas);
  return largeAt;
}

const LIVE_TURN = { ...LONG_TURN, largeResultBytes: 1, textDeltas: 40 };
const CATCH_UP_TURN = { ...SHORT_TURN, textDeltas: 12 };
const EXPANDED_TURN = { ...LONG_TURN, largeResultBytes: 0, textDeltas: 40 };

interface VisibleTool { toolName: string; input: Record<string, unknown>; result: string; isError?: boolean }

/**
 * Ordinary-size results that history-view controllers still receive live: tools that
 * isHistoryDetailTool excludes (packages/maker-shared/src/historyViewProjection.ts:29)
 * and a failed command (isError bypasses deferral, historyViewPush.ts isDeferredHistoryPush).
 * Sizes span a few hundred bytes to 12 KB, so the 8 KB Mobile preview cut is exercised.
 */
function visibleTools(random: () => number): VisibleTool[] {
  const editSnippet = codeText(random, 1_536);
  return [
    { toolName: 'Edit', input: { file_path: '/workspace/demo/src/lib/cache.ts', old_string: codeText(random, 600), new_string: codeText(random, 800) },
      result: `The file /workspace/demo/src/lib/cache.ts has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:\n${editSnippet}` },
    { toolName: 'Write', input: { file_path: '/workspace/demo/src/lib/http.ts', content: codeText(random, 3_072) },
      result: 'File created successfully at: /workspace/demo/src/lib/http.ts' },
    { toolName: 'TodoWrite', input: { todos: Array.from({ length: 5 }, (_, i) => ({ content: zhProse(random, 24), status: i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending', activeForm: zhProse(random, 20) })) },
      result: 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable' },
    { toolName: 'mcp__cindy__ghost_call', input: { ghost_id: 'demo-plugin', tool: 'search', args: { query: zhProse(random, 12) } },
      result: JSON.stringify({ ok: true, items: Array.from({ length: 24 }, (_, i) => ({ id: `item-${i}`, title: zhProse(random, 18), snippet: zhProse(random, 60) })) }) },
    { toolName: 'Bash', input: { command: 'pnpm vitest run test/http.test.ts', description: zhProse(random, 12) },
      result: codeText(random, 1_536), isError: true },
    { toolName: 'Agent', input: { description: zhProse(random, 10), prompt: zhProse(random, 400), subagent_type: 'general-purpose' },
      result: zhProse(random, 4_096) },
  ];
}

/** A turn with ordinary-size visible results, published with the production payload: event + persistId + resolvedContent. */
async function runToolResultsTurn(host: BaselineHost, sessionId: string, seed: number, step?: () => Promise<void>): Promise<void> {
  const random = createRandom(seed);
  await beginTurn(host, sessionId, zhProse(random, 120));
  await step?.();
  for (const tool of visibleTools(random)) {
    const toolUseId = liveId('tool');
    host.noteToolName(toolUseId, tool.toolName);
    host.makerEvent(sessionId, { type: 'tool_use', data: { toolUseId, toolName: tool.toolName, input: tool.input } });
    await host.persist(sessionId, { clientId: liveId('tu'), role: 'tool_use', content: { toolUseId, toolName: tool.toolName, input: tool.input }, toolUseId, createdAt: nextAt() });
    await sleep(150);
    const resultId = liveId('tr');
    // messagePersistBroadcaster.ts markFailedToolResultText + onToolResultFullEvent: resolvedContent is the full text.
    const fullText = tool.isError ? `<tool_use_error>${tool.result}</tool_use_error>` : tool.result;
    host.broadcast('maker:event', {
      sessionId,
      event: { type: 'tool_result_full', data: { toolUseId, fullText: tool.result, ...(tool.isError ? { isError: true } : {}) } },
      persistId: resultId,
      resolvedContent: fullText,
    });
    await host.persist(sessionId, { clientId: resultId, role: 'tool_result', content: capToolResultTextForPersist(fullText), toolUseId, createdAt: nextAt() });
    await sleep(100);
    await step?.();
  }
  await finishTurn(host, sessionId, zhProse(random, 600), 20);
}

// ─── controller behavior ────────────────────────────────────────────────────

/**
 * The Mobile recovery core (apps/mobile/src/device-link/rehydrate.ts, topicRegistry.ts)
 * is loaded at run time: Mobile's `@/` path alias cannot share one TypeScript program
 * with Desktop's, so only the surface used here is typed.
 */
interface MobileRehydrateStep { capturedPresenceEpoch: number; capturedResponseEvidenceEpoch: number; request: Promise<unknown> }
interface MobileRecoveryCore {
  rehydrateDeviceLinkPeer(plan: unknown, deps: {
    createDeviceSendCohort(deviceId: string): number;
    capturePresenceEpoch(deviceId: string): number;
    captureResponseEvidenceEpoch(deviceId: string): number;
    isPresenceEpochCurrent(deviceId: string, epoch: number): boolean;
    isResponseEvidenceEpochCurrent(deviceId: string, epoch: number): boolean;
    openLink(deviceId: string): MobileRehydrateStep;
    subscribe(deviceId: string, topics: readonly string[]): Promise<unknown>;
    requestSessionsReseed(deviceId: string): void;
    rebuildSessionSnapshot(deviceId: string, sessionId: string): Promise<unknown>;
  }): Promise<{ transientFailures: number }>;
  DeviceLinkTopicRegistry: new () => {
    trackOpenLink(deviceId: string): void;
    trackSubscribe(owner: string, deviceId: string, topics: readonly string[]): void;
    snapshotDevice(deviceId: string): unknown;
  };
}

const MOBILE_DEVICE_LINK = path.resolve(__dirname, '../../../../mobile/src/device-link');

async function loadMobileRecoveryCore(): Promise<MobileRecoveryCore> {
  const [rehydrate, registry] = await Promise.all([
    import(/* @vite-ignore */ path.join(MOBILE_DEVICE_LINK, 'rehydrate.ts')),
    import(/* @vite-ignore */ path.join(MOBILE_DEVICE_LINK, 'topicRegistry.ts')),
  ]);
  return { rehydrateDeviceLinkPeer: rehydrate.rehydrateDeviceLinkPeer, DeviceLinkTopicRegistry: registry.DeviceLinkTopicRegistry };
}

interface OpenTask {
  view: HistoryViewController<HistoryMessageSource>;
  off(): void;
}

function pushes(controller: BaselineController, handler: (channel: string, payload: unknown) => void): () => void {
  return controller.client.onFrame((env: Envelope) => {
    if (env.kind !== 'push') return;
    const push = env.payload as PushPayload;
    if (push.channel === MAKER_EVENT_BATCH_CHANNEL) {
      for (const event of (push.payload as { events?: unknown[] }).events ?? []) handler('maker:event', event);
    } else handler(push.channel, push.payload);
  });
}

/** Mobile task screen push reactions: DeviceLinkContext.tsx:2296-2317. */
function wirePhoneTask(controller: BaselineController, view: HistoryViewController<HistoryMessageSource>, sessionId: string): () => void {
  return pushes(controller, (channel, payload) => {
    if ((payload as { sessionId?: unknown } | null)?.sessionId !== sessionId) return;
    if (channel === 'maker:history-view-changed') view.invalidate();
    else if (channel === 'maker:history-work-patch') view.applyWorkPatch(payload as HistoryWorkPatch);
    else if ((channel === 'local-db:messages:created' || channel === 'maker:status-changed') && view.getSnapshot().ready) view.invalidate();
  });
}

/** Desktop task push reactions: makerChatStore.ts:9468-9476, 7793-7813, 13360-13394; useRemoteSessionSync.ts:131-140. */
function wireDesktopTask(controller: BaselineController, view: HistoryViewController<HistoryMessageSource>, sessionId: string): () => void {
  let repairTimer: ReturnType<typeof setTimeout> | null = null;
  let lastNoticeAt = 0;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  const reconcile = () => {
    void view.refresh(false, true);
    void controller.invoke('maker:get-pending-interactions', [sessionId]).catch(() => undefined);
  };
  const armRepair = () => {
    lastNoticeAt = Date.now();
    if (repairTimer) return;
    repairTimer = setTimeout(() => {
      repairTimer = null;
      if (view.latestReadOkStartedAt() > lastNoticeAt) return;
      reconcile();
    }, 1_500);
  };
  const off = pushes(controller, (channel, payload) => {
    const value = payload as { sessionId?: unknown; status?: unknown; persistId?: unknown; listMessage?: unknown; event?: { type?: unknown; data?: { isFinal?: unknown } } } | null;
    if (value?.sessionId !== sessionId) return;
    if (channel === 'maker:history-view-changed' || channel === 'maker:status-changed' || channel === 'usage:message-turn-cost') view.invalidate();
    if (channel === 'maker:history-work-patch') view.applyWorkPatch(payload as HistoryWorkPatch);
    if (channel === 'local-db:messages:created') {
      view.invalidate();
      if (value.listMessage !== true) armRepair();
    }
    if (channel === 'maker:event' && typeof value.persistId === 'string') {
      const plainDelta = value.event?.type === 'text' && value.event.data?.isFinal === false;
      if (!plainDelta) armRepair();
    }
    if (channel === 'maker:status-changed') {
      const nowRunning = value.status === 'running';
      if (running && !nowRunning) {
        if (reconcileTimer) clearTimeout(reconcileTimer);
        reconcileTimer = setTimeout(reconcile, 200);
      }
      running = nowRunning;
    }
  });
  return () => {
    off();
    if (repairTimer) clearTimeout(repairTimer);
    if (reconcileTimer) clearTimeout(reconcileTimer);
  };
}

/** Mobile `syncSession` reads on open: [sessionId].tsx:4096-4118 plus goal status on focus (:8944-8961). */
async function openPhoneTask(controller: BaselineController, sessionId: string): Promise<OpenTask> {
  await controller.subscribe([`session:${sessionId}`]);
  const view = controller.createHistoryView(sessionId);
  const off = wirePhoneTask(controller, view, sessionId);
  await Promise.all([
    controller.invoke('local-db:sessions:get', [sessionId]),
    view.refresh(),
    controller.invoke('maker:get-pending-interactions', [sessionId]),
    controller.invoke('maker:input:get-projection', [sessionId]),
    controller.invoke('maker:list-active', [{ summary: true, snapshotVersion: 2 }]),
    controller.invoke('maker:goal:get-status', [sessionId]),
  ]);
  return { view, off };
}

/** Desktop `ensureInitialMessages` + content recovery: makerChatStore.ts:12504+, useRemoteSessionSync.ts:389-391, older page :12972. */
async function openDesktopTask(controller: BaselineController, sessionId: string): Promise<OpenTask> {
  const view = controller.createHistoryView(sessionId);
  const off = wireDesktopTask(controller, view, sessionId);
  const subscribed = controller.subscribe([`session:${sessionId}`]);
  await Promise.all([
    controller.invoke('local-db:sessions:get', [sessionId]),
    controller.invoke('maker:input:get-projection', [sessionId]),
    view.refresh(),
    controller.invoke('maker:get-pending-interactions', [sessionId]),
  ]);
  await subscribed;
  await Promise.all([view.refresh(false, true), controller.invoke('maker:get-pending-interactions', [sessionId])]);
  await sleep(200);
  if (view.getSnapshot().hasMore) await view.refresh(true);
  return { view, off };
}

type WorkLeaf = Extract<ReturnType<typeof historyViewLeaves<HistoryMessageSource>>[number], { type: 'work' }>;

function workLeaves(view: HistoryViewController<HistoryMessageSource>): WorkLeaf[] {
  return historyViewLeaves(view.getSnapshot().items).filter((item): item is WorkLeaf => item.type === 'work');
}

async function expandAndLoad(view: HistoryViewController<HistoryMessageSource>, key: string): Promise<void> {
  view.setExpanded(key, true);
  await until(() => {
    const detail = view.getSnapshot().details.get(key);
    return !!detail && !detail.loading && (detail.complete || detail.error !== null);
  }, `details of ${key}`);
}

/**
 * The user expands an older folded group (historyViewRender.ts:178 toggle → setExpanded),
 * collapses it again, then expands the group holding the 1.05 MiB result. Both
 * controllers drive the same HistoryViewController for this (view-intent + work-details).
 */
async function expandWorkGroups(task: OpenTask, largeResultAt: number): Promise<string> {
  const leaves = workLeaves(task.view);
  const expanded = task.view.getSnapshot().expanded;
  const large = leaves.find((item) => item.summary.startedAtMs <= largeResultAt && largeResultAt <= item.summary.endedAtMs);
  if (!large) throw new Error('large result work group is not on the latest page');
  // setExpanded is a no-op for an already expanded key, which would measure nothing.
  const older = leaves.find((item) => item.key !== large.key && !item.summary.isStreaming && !expanded.has(item.key));
  if (!older) throw new Error('no folded history work group on the latest page');
  if (expanded.has(large.key)) throw new Error('large result work group is already expanded');
  await expandAndLoad(task.view, older.key);
  task.view.setExpanded(older.key, false);
  await expandAndLoad(task.view, large.key);
  return large.key;
}

interface ListedSession { id: string; updatedAt: string; status?: string; source?: string; activeTurnStartedAt?: number | null; lastTurnEndedAt?: number | null }

/** Sidebar list refresh + read ahead. Mobile: HomeSurface.tsx:1052-1098, remoteHistoryPrefetch.ts; Desktop: refreshRemoteSessions.ts:51, 411-510, makerChatStore.ts:12431-12499. */
async function refreshSidebar(controller: BaselineController, options: {
  openSessionId?: string;
  cached?: ReadonlySet<string>;
  /** Same-process read-ahead record (session id → prefetch version); v1/v2 stages pass none. */
  prefetched?: Map<string, string>;
}): Promise<void> {
  const profile = controller.profile;
  const listArgs = [200, 'active', { includePinned: true, fresh: true }];
  let listed: ListedSession[];
  if (profile.id === 'phone') {
    const [list] = await Promise.all([
      controller.invoke<ListedSession[]>('local-db:sessions:list', listArgs),
      controller.invoke('maker:list-active', [{ summary: true, snapshotVersion: 2 }]),
    ]);
    listed = list;
    await controller.invoke('sidebar-settings:get-project-aliases', []);
  } else {
    await controller.invoke('sidebar-settings:get-project-aliases', []);
    listed = await controller.invoke<ListedSession[]>('local-db:sessions:list', listArgs);
    await controller.invoke('local-db:history:query', [{ tool: 'list_sessions', args: { source: 'bot', time_field: 'activity', limit: 200 } }]);
    await Promise.all([
      controller.invoke('maker:schedule:list-sidebar-index-runs', []),
      controller.invoke('maker:schedule:list', [null, { sessionBindings: true }]),
    ]);
  }
  // Mobile coalesces read-ahead for 1.5 s (RemoteHistoryPrefetchBridge.tsx:10); Desktop runs it after bootstrap.
  if (profile.id === 'phone') await sleep(1_500);
  const targets = selectHistoryPrefetchSessions(listed, {
    eligible: (session) => session.status !== 'archived' && session.source !== 'scheduler' && session.id !== options.openSessionId,
    prefetchedAt: (id) => options.prefetched?.get(id),
  }).filter((session) => !options.cached?.has(session.id));
  for (const session of targets) {
    await controller.invoke('local-db:messages:view', [session.id, profile.prefetchViewOptions()]);
    const version = historyPrefetchVersion(session);
    if (version !== undefined) options.prefetched?.set(session.id, version);
  }
}

async function connect(env: ScenarioEnv, profile: ControllerProfile): Promise<BaselineController> {
  const controller = startBaselineController({
    profile,
    wsUrl: env.wsUrl,
    credential: env.credentials.get(profile.deviceId)!,
    hostDeviceId: env.host.deviceId,
    meter: env.meter,
    dropTransfer: env.dropTransfer,
  });
  await until(() => controller.client.getStatus() === 'online', `${profile.id} online`);
  await controller.openLink();
  await controller.subscribe(['sessions']);
  await settle(env, controller);
  return controller;
}

type TopicRegistry = InstanceType<MobileRecoveryCore['DeviceLinkTopicRegistry']>;

/**
 * Mobile recovery wiring shared by reconnect and foreground: PeerRecoveryScheduler →
 * rehydrateDeviceLinkPeer over a DeviceLinkTopicRegistry plan (DeviceLinkContext.tsx:1083-1099,
 * 907-919). `rebuild` is rebuildSessionSnapshot for each held `session:<id>` topic.
 */
function createPhoneRecovery(core: MobileRecoveryCore, controller: BaselineController, hostId: string,
  openSessionId: string | null, rebuild: (sessionId: string) => Promise<unknown>) {
  const registry: TopicRegistry = new core.DeviceLinkTopicRegistry();
  // The Home screen holds `sessions`; an open task screen adds its own topic.
  registry.trackOpenLink(hostId);
  registry.trackSubscribe('home', hostId, ['sessions']);
  if (openSessionId) registry.trackSubscribe(`session:${openSessionId}`, hostId, ['sessions', `session:${openSessionId}`]);
  const state = { reseeds: 0, done: false };
  const scheduler = new PeerRecoveryScheduler(async (deviceId) => {
    const result = await core.rehydrateDeviceLinkPeer(registry.snapshotDevice(deviceId), {
      createDeviceSendCohort: () => 0,
      capturePresenceEpoch: () => 0,
      captureResponseEvidenceEpoch: () => 0,
      isPresenceEpochCurrent: () => true,
      isResponseEvidenceEpochCurrent: () => true,
      openLink: (id) => ({
        capturedPresenceEpoch: 0,
        capturedResponseEvidenceEpoch: 0,
        request: controller.client.openLink(id, {
          controllerName: controller.profile.deviceName,
          protocolVersion: PROTOCOL_VERSION,
          appVersion: '0.0.0-baseline',
          capabilities: controller.profile.controllerCapabilities,
        } satisfies LinkOpenPayload),
      }),
      subscribe: (_id, topics) => controller.subscribe([...topics]),
      requestSessionsReseed: () => { state.reseeds++; },
      rebuildSessionSnapshot: (_id, sid) => rebuild(sid),
    });
    const retry = result.transientFailures > 0;
    // A transient failure is retried by the scheduler; the stage waits for a complete pass.
    if (!retry) state.done = true;
    return { retry };
  }, { retryBaseMs: 200, retryMaxMs: 1_000 });
  return { state, scheduler };
}

/** Mobile reconnect: DeviceLinkContext.tsx:1470-1477, rehydrate.ts:80-199, rebuildSessionSnapshot DLC:2320-2509, re-run syncSession SCR:4531-4537. */
interface ReconnectOptions {
  /** What the host does while the controller is away (v1: the short catch-up turn). */
  offlineWork?: () => Promise<unknown>;
  /** Same-process read-ahead record for the sidebar refresh after recovery (v1: none). */
  prefetched?: Map<string, string>;
  /** Fail when Mobile recovery does not reseed the list (v4 stages are named after that read). */
  requireReseed?: boolean;
}

async function reconnectPhone(env: ScenarioEnv, controller: BaselineController, task: OpenTask, sessionId: string,
  options: ReconnectOptions = {}): Promise<void> {
  const core = await loadMobileRecoveryCore();
  const { state, scheduler } = createPhoneRecovery(core, controller, env.host.deviceId, sessionId, async (sid) => {
    await Promise.all([
      task.view.refresh(false, true),
      controller.invoke('maker:get-pending-interactions', [sid]),
      controller.invoke('maker:input:get-projection', [sid]),
      controller.invoke('maker:goal:get-status', [sid]),
    ]);
  });
  controller.dropNetwork();
  await until(() => controller.client.getStatus() !== 'online', 'phone offline');
  await (options.offlineWork ?? (() => runHostTurn(env.host, sessionId, 901, CATCH_UP_TURN)))();
  await sleep(500);
  controller.restoreNetwork();
  await until(() => controller.client.getStatus() === 'online', 'phone back online');
  scheduler.request(env.host.deviceId);
  // The open screen re-runs syncSession on the new connection epoch; single-flight
  // merges pending/projection/history, the rest are sent again.
  const rerun = Promise.all([
    controller.invoke('local-db:sessions:get', [sessionId]),
    controller.invoke('maker:list-active', [{ summary: true, snapshotVersion: 2 }]),
  ]);
  await until(() => state.done, 'phone recovery');
  await rerun;
  scheduler.pause();
  if (options.requireReseed && state.reseeds === 0) throw new Error('reconnect recovery did not reseed the task list');
  if (state.reseeds > 0) await refreshSidebar(controller, { openSessionId: sessionId, prefetched: options.prefetched });
}

/** Desktop reconnect: index.ts:1189 subscription replay, useDeviceLinkRemoteProjects.ts:616-687 sidebar bootstrap, useRemoteSessionSync.ts:450-459. */
async function reconnectDesktop(env: ScenarioEnv, controller: BaselineController, task: OpenTask, sessionId: string,
  options: ReconnectOptions = {}): Promise<void> {
  controller.dropNetwork();
  await until(() => controller.client.getStatus() !== 'online', 'desktop offline');
  await (options.offlineWork ?? (() => runHostTurn(env.host, sessionId, 902, CATCH_UP_TURN)))();
  await sleep(500);
  controller.restoreNetwork();
  await until(() => controller.client.getStatus() === 'online', 'desktop back online');
  if (controller.client.needsLinkRecovery(env.host.deviceId)) await controller.openLink();
  await controller.subscribe(['sessions', `session:${sessionId}`]);
  await Promise.all([
    (async () => {
      await controller.subscribe(['sessions']);
      await refreshSidebar(controller, { openSessionId: sessionId, prefetched: options.prefetched });
    })(),
    (async () => {
      await controller.subscribe([`session:${sessionId}`]);
      await Promise.all([task.view.refresh(false, true), controller.invoke('maker:get-pending-interactions', [sessionId])]);
    })(),
  ]);
}

export async function runProfile(env: ScenarioEnv, profile: ControllerProfile, options: { v1Only?: boolean } = {}): Promise<void> {
  liveRow = 0;
  liveClock = FIXTURE_EPOCH + 60_000;
  env.meter.setStage('connect');
  let controller = await connect(env, profile);

  env.meter.setStage('open_long_task');
  const task = profile.id === 'phone'
    ? await openPhoneTask(controller, LONG_SESSION_ID)
    : await openDesktopTask(controller, LONG_SESSION_ID);
  await settle(env, controller);

  env.meter.setStage('live_turn');
  const largeResultAt = await runHostTurn(env.host, LONG_SESSION_ID, 900, LIVE_TURN, { step: () => settle(env, controller) });
  if (largeResultAt === null) throw new Error('live turn did not publish its large result');
  await settle(env, controller);

  env.meter.setStage('reconnect');
  if (profile.id === 'phone') await reconnectPhone(env, controller, task, LONG_SESSION_ID);
  else await reconnectDesktop(env, controller, task, LONG_SESSION_ID);
  await settle(env, controller);

  // A new controller process: empty invoke cache, no known message bodies, no disk snapshot.
  env.meter.setStage('teardown');
  task.off();
  controller.close();
  await settle(env, null);


  env.meter.setStage('connect_cold');
  controller = await connect(env, profile);
  env.meter.setStage('sidebar_refresh');
  await refreshSidebar(controller, {});
  await settle(env, controller);
  if (options.v1Only) {
    // Debug scope (TRANSFER_BASELINE_SCOPE=v1): stop after the v1 stages.
    env.meter.setStage('teardown');
    controller.close();
    await settle(env, null);
    return;
  }

  // ── scenario v2 stages: same controller, task opened again (setup is reported separately) ──
  env.meter.setStage('extra_open');
  const extra = profile.id === 'phone'
    ? await openPhoneTask(controller, LONG_SESSION_ID)
    : await openDesktopTask(controller, LONG_SESSION_ID);
  await settle(env, controller);

  env.meter.setStage('live_turn_tool_results');
  await runToolResultsTurn(env.host, LONG_SESSION_ID, 903, () => settle(env, controller));
  await settle(env, controller);

  env.meter.setStage('expand_work_groups');
  await expandWorkGroups(extra, largeResultAt);
  await settle(env, controller);

  env.meter.setStage('live_turn_with_expanded');
  await runHostTurn(env.host, LONG_SESSION_ID, 904, EXPANDED_TURN, { step: () => settle(env, controller) });
  await settle(env, controller);

  env.meter.setStage('teardown');
  extra.off();
  controller.close();
  await settle(env, null);
}

// ─── scenario v3: repeated list reads ───────────────────────────────────────

/** The task whose list row changes between two reads (inside the five read-ahead targets). */
const CHANGED_SESSION_ID = fixtureId('tbside', 3);

/** One task writes a message, as a running task would; its list row (count / preview) changes. */
async function touchSession(host: BaselineHost, sessionId: string, at: number, seed: number): Promise<void> {
  const random = createRandom(seed);
  await host.persist(sessionId, { clientId: fixtureId('v3touch', at % 100_000), role: 'assistant', content: zhProse(random, 300), toolUseId: null, agentMeta: { turnCompleted: true }, createdAt: at });
}

/**
 * Mobile back from background after the stop grace: DeviceLinkContext.tsx:1799-1810
 * (stop after BACKGROUND_STOP_GRACE_MS, connectAllNow on active), :1818-1844 (rehydrate,
 * one explicit aliases refresh), rehydrate.ts reseed → Home list refresh + read ahead,
 * skipping tasks this process already read ahead.
 */
async function phoneBackgroundForeground(env: ScenarioEnv, controller: BaselineController, prefetched: Map<string, string>,
  change: (() => Promise<void>) | null): Promise<void> {
  const core = await loadMobileRecoveryCore();
  const { state, scheduler } = createPhoneRecovery(core, controller, env.host.deviceId, null, async () => undefined);
  const departures = env.host.peerOfflineCount(controller.profile.deviceId);
  if (readHarnessSwitches().phoneStopRetainResultCache) {
    // Mobile's background stop with the result cache kept: stop({ retainResultCache: true }).
    // Clients whose stop() takes no argument ignore it, so the switch type-checks and runs on them too.
    (controller.client.stop as (options?: { retainResultCache?: boolean }) => void).call(controller.client, { retainResultCache: true });
  } else controller.client.stop();
  // Past the stop grace the host has seen this stop (a new presence offline) before anything changes.
  await until(() => env.host.peerOfflineCount(controller.profile.deviceId) > departures, 'host sees phone offline');
  if (change) await change();
  controller.client.connectAllNow('appstate-active', { overrideCongestionCooldown: true, keepInFlightAttempt: true });
  await until(() => controller.client.getStatus() === 'online', 'phone foreground online');
  scheduler.request(env.host.deviceId);
  await until(() => state.done, 'phone foreground recovery');
  scheduler.pause();
  if (state.reseeds === 0) throw new Error('foreground recovery did not reseed the task list');
  // DeviceLinkContext.tsx:1838-1843 refreshes aliases once on return; Home's list refresh sends its own (:2051).
  await controller.invoke('sidebar-settings:get-project-aliases', []);
  await refreshSidebar(controller, { prefetched });
}

/** Desktop periodic reconcile tick: useDeviceLinkRemoteProjects.ts:922-961, refreshRemoteSessions.ts:411-424 (no `fresh`). */
async function desktopReconcileTick(controller: BaselineController): Promise<void> {
  await controller.invoke('sidebar-settings:get-project-aliases', []);
  await controller.invoke('local-db:sessions:list', [200, 'active', { includePinned: true }]);
  await controller.invoke('local-db:history:query', [{ tool: 'list_sessions', args: { source: 'bot', time_field: 'activity', limit: 200 } }]);
}

/** Scenario v3 for one profile on one host; `suffix` names the list-scale variant. */
export async function runListRepeat(env: ScenarioEnv, profile: ControllerProfile, suffix = ''): Promise<void> {
  const at = FIXTURE_EPOCH + 3_600_000;
  const prefetched = new Map<string, string>();
  env.meter.setStage(`v3_connect${suffix}`);
  const controller = await connect(env, profile);
  env.meter.setStage(`v3_list_first${suffix}`);
  await refreshSidebar(controller, { prefetched });
  await settle(env, controller);
  if (profile.id === 'phone') {
    env.meter.setStage(`foreground_list_unchanged${suffix}`);
    await phoneBackgroundForeground(env, controller, prefetched, null);
    await settle(env, controller);
    env.meter.setStage(`foreground_list_changed${suffix}`);
    await phoneBackgroundForeground(env, controller, prefetched, () => touchSession(env.host, CHANGED_SESSION_ID, at, 905));
    await settle(env, controller);
  } else {
    env.meter.setStage(`v3_tick_first${suffix}`);
    await desktopReconcileTick(controller);
    await settle(env, controller);
    env.meter.setStage(`reconcile_list_unchanged${suffix}`);
    await desktopReconcileTick(controller);
    await settle(env, controller);
    env.meter.setStage(`reconcile_list_changed${suffix}`);
    await touchSession(env.host, CHANGED_SESSION_ID, at, 905);
    await desktopReconcileTick(controller);
    await settle(env, controller);
  }
  env.meter.setStage('teardown');
  controller.close();
  await settle(env, null);
}

// ─── scenario v4: reconnect variants and an expanded running group ──────────

const EXPANDED_RUNNING_TURN = { ...LONG_TURN, largeResultBytes: 1, textDeltas: 40 };

/**
 * The user expands the running work group (historyViewRender.ts toggle → setExpanded) once it
 * shows up on the open view, and its details have loaded before the host continues.
 */
async function expandRunningGroup(env: ScenarioEnv, task: OpenTask): Promise<void> {
  let key: string | undefined;
  await until(() => {
    key = workLeaves(task.view).find((item) => item.summary.isStreaming)?.key;
    return key !== undefined;
  }, 'running work group on the open view');
  // setExpanded is a no-op for an already expanded key, which would measure nothing.
  if (task.view.getSnapshot().expanded.has(key!)) throw new Error('running work group is already expanded');
  await expandAndLoad(task.view, key!);
  // Let the view-intent and detail reads land on the host before the result is published.
  await until(() => env.meter.idleMs() >= 300, 'expand requests delivered');
}

/** Scenario v4 for one profile on a fresh host. */
export async function runV4(env: ScenarioEnv, profile: ControllerProfile): Promise<void> {
  liveRow = 500;
  liveClock = FIXTURE_EPOCH + 7_200_000;
  const prefetched = new Map<string, string>();
  env.meter.setStage('v4_connect');
  const controller = await connect(env, profile);
  // The App starts on Home: list + read-ahead, then the user opens the long task.
  env.meter.setStage('v4_home');
  await refreshSidebar(controller, { prefetched });
  await settle(env, controller);
  env.meter.setStage('v4_open');
  const task = profile.id === 'phone'
    ? await openPhoneTask(controller, LONG_SESSION_ID)
    : await openDesktopTask(controller, LONG_SESSION_ID);
  await settle(env, controller);
  const reconnect = profile.id === 'phone' ? reconnectPhone : reconnectDesktop;

  env.meter.setStage('reconnect_after_prefetch');
  await reconnect(env, controller, task, LONG_SESSION_ID, {
    offlineWork: () => runHostTurn(env.host, LONG_SESSION_ID, 911, CATCH_UP_TURN), prefetched, requireReseed: true,
  });
  await settle(env, controller);

  env.meter.setStage('reconnect_after_prefetch_noskip');
  await reconnect(env, controller, task, LONG_SESSION_ID, {
    offlineWork: () => runHostTurn(env.host, LONG_SESSION_ID, 912, CATCH_UP_TURN), requireReseed: true,
  });
  await settle(env, controller);

  env.meter.setStage('reconnect_after_long_turn');
  await reconnect(env, controller, task, LONG_SESSION_ID, {
    offlineWork: () => runToolResultsTurn(env.host, LONG_SESSION_ID, 913), prefetched, requireReseed: true,
  });
  await settle(env, controller);

  env.meter.setStage('live_turn_expanded_running');
  await runHostTurn(env.host, LONG_SESSION_ID, 914, EXPANDED_RUNNING_TURN, {
    resolvedContent: true,
    beforeLargeResult: () => expandRunningGroup(env, task),
    step: () => settle(env, controller),
  });
  await settle(env, controller);

  env.meter.setStage('teardown');
  task.off();
  controller.close();
  await settle(env, null);
}
