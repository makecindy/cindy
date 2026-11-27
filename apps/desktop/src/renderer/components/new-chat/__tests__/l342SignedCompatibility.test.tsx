// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { ProviderView } from '@cindy/model-providers';
import { sshModel, sshProvider } from '@/features/cc-agent/__tests__/sshModelFixtures';
import { makerChatStore } from '@/lib/makerChatStore';
import { ChatInput } from '../ChatInput';
// The archived v0.1.25 handlers run with a busy synthetic session and a real SQLite row.
import v25 from './fixtures/l342-receiver-v25.cjs';
import v26 from './fixtures/l342-receiver-v26.cjs';

type PickerProps = ComponentProps<typeof import('../ModelSelector')['ModelSelector']>;
const ui = vi.hoisted(() => ({
  picker: null as PickerProps | null,
  providers: [] as ProviderView[],
  capabilities: null as { supportsSessionAgentSwitch: true; supportsSessionAgentSwitchCas?: true; hasFastMode: true; availableModels: unknown[] } | null,
}));
vi.mock('../ModelSelector', async (original) => ({
  ...await original<typeof import('../ModelSelector')>(),
  ModelSelector: (props: PickerProps) => {
    ui.picker = props;
    return <button data-testid="picker" data-provider={props.currentProviderId ?? 'default'}>{props.modelId}</button>;
  },
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: () => ({ providers: ui.providers, loading: false, unsupported: false }),
}));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: [], loading: false }) }));
vi.mock('@/hooks/useConnectedSource', () => ({ useConnectedSource: () => ({ hasConnectedSource: true, loading: false }) }));
vi.mock('@/hooks/useAvailableAgents', () => ({ useAvailableAgents: () => ({ loaded: false }) }));
vi.mock('@/hooks/useAgentCapabilities', async original => ({
  ...await original<typeof import('@/hooks/useAgentCapabilities')>(),
  useAgentCapabilities: (agent: string | null, device?: string) => ({
    capabilities: agent === 'codex' && device === 'legacy-host' ? ui.capabilities : null,
    loading: false,
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: async () => true }) }));
vi.mock('react-i18next', async original => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }));
vi.mock('../ExtraDirsButton', () => ({ ExtraDirsButton: () => null }));
vi.mock('../PermissionSelector', () => ({ PermissionSelector: () => null }));
vi.mock('../NewGoalDialog', () => ({ NewGoalDialog: () => null }));
vi.mock('../FolderPickerPopover', () => ({ FolderPickerPopover: () => null, addRecentFolder: () => {} }));
vi.mock('@/voice-input/VoiceInputPointerHintLayer', () => ({
  VoiceInputPointerHintLayer: ({ children }: { children: import('react').ReactNode }) => <>{children}</>,
}));
vi.mock('@/voice-input/VoiceInputStatusNotice', () => ({ VoiceInputStatusNotice: () => null }));
vi.mock('@/voice-input/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', isListening: false, isBusy: false, start() {}, stop() {}, cancel() {} }),
}));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => [], readInstalledGhostsSnapshot: () => [] }));

const noop = () => {};
const attachmentState: ComponentProps<typeof ChatInput>['attachmentState'] = {
  attachments: [], hasAttachments: false, addFiles: vi.fn(), addClipboardImage: vi.fn(),
  rejections: [], dismissRejection: noop, clearRejections: noop, addFolderPath: noop, addFileMention: noop,
  pendingFoldersVersion: 0, consumePendingFolders: () => [],
  pendingFileMentionsVersion: 0, consumePendingFileMentions: () => [],
  removeFile: noop, updateFile: noop, discardFiles: noop, clearFiles: noop, restoreFiles: files => [...files],
};
afterEach(() => {
  cleanup();
  localStorage.clear();
  ui.picker = null;
  ui.capabilities = null;
  vi.unstubAllGlobals();
});

// Integration fixture for the L342 review. Both signed renderer sources run the same picker events.
// A transport shim delivers real invocation arguments to the archived callbacks plus the archived
// post-handler persistence function. The old receiver never sends a new pending intent projection.
it.each([
  ['v0.1.25', 'model'], ['v0.1.25', 'source'],
  ['v0.1.26', 'model'], ['v0.1.26', 'source'],
] as const)('%s receiver deferred success via %s', async (version, choice) => {
  const cas = version === 'v0.1.26';
  const receiver = cas ? v26 : v25;
  const sessionId = 'legacy-' + choice;
  const model = 'fixture-codex';
  const targetModel = choice === 'model' ? 'chatgpt/fixture-next' : model;
  const providerId = choice === 'model' ? null : 'openai';
  const targetProvider = choice === 'model' ? (cas ? 'openai' : null) : 'fixture-provider-b';
  const fastMode = choice === 'model';
  const targetFast = !fastMode;
  const models = [
    sshModel(model, { supportsFastMode: true }),
    sshModel('chatgpt/fixture-next', { efforts: ['high'], defaultEffort: 'high', supportsFastMode: true }),
  ];
  ui.providers = [sshProvider('openai', models), sshProvider('fixture-provider-b', [models[0]])];
  const old = receiver.createLegacyReceiver({ id: sessionId, model, providerId, effort: 'low', fastMode, models });
  ui.capabilities = old.capabilities('codex');
  expect(ui.capabilities?.supportsSessionAgentSwitch).toBe(true);
  expect(ui.capabilities?.supportsSessionAgentSwitchCas).toBe(cas ? true : undefined);
  const settingsChannels = ['maker:switch-session-agent', 'maker:set-model', 'maker:set-effort', 'maker:set-fast-mode'];
  const calls: { deviceId: string; channel: string; args: unknown[]; result: unknown }[] = [];
  const invoke = async (deviceId: string, channel: string, args: unknown[]) => {
    const wireArgs = JSON.parse(JSON.stringify(args));
    const result = await old.invoke(channel, wireArgs);
    if (settingsChannels.includes(channel)) calls.push({ deviceId, channel, args: wireArgs, result: result ?? null });
    return result;
  };
  const api: typeof window.electronAPI = new Proxy({} as typeof window.electronAPI, {
    get: (_target, key) => {
      if (key === 'invoke') return invoke;
      if (key === 'platform') return 'darwin';
      if (key === 'then') return undefined;
      if (key === 'listSync') return () => ({ ghosts: [] });
      if (key === 'getDataSnapshot') return () => { throw new Error('fixture bridge unavailable'); };
      if (key === 'setGlobalShortcut') return async () => ({ ok: true });
      if (String(key).startsWith('on')) return () => noop;
      return new Proxy(() => Promise.resolve(undefined), { get: (_fn, name) => Reflect.get(api, name) });
    },
  });
  window.electronAPI = api;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  try {
    render(<ChatInput sessionId={sessionId} deviceLinkDeviceId="legacy-host" initialWorkingDir="/fixture"
      sessionOrcaRole={cas ? null : undefined} runtimeAgentKind="codex" vendorKey="codex" initialModel={model} initialProviderId={providerId} initialEffort="low"
      fastMode={fastMode} attachmentState={attachmentState} showFolderPicker={false} disableAutofocus
      onSend={() => false} onFastModeChange={(value, deviceId) => makerChatStore.setFastMode(sessionId, value, deviceId)} />);
    const displayed = () => ({
      model: screen.getByTestId('picker').textContent, providerId: ui.picker?.currentProviderId ?? null,
      effort: ui.picker?.effort, fastMode: ui.picker?.fastMode,
    });
    await act(async () => {
      if (choice === 'model') await ui.picker!.onModelChange(targetModel);
      else await ui.picker!.onProviderChange!(targetProvider, targetModel, 'high', targetFast);
    });
    const after = displayed();
    const legacy = old.evidence();
    const index = cas ? 1 : 0;
    const setModel = calls[index];
    if (cas) {
      expect(calls[0]).toMatchObject({ channel: 'maker:switch-session-agent', result: { sameEngineRevision: expect.any(Number) } });
      expect(setModel).toEqual({ deviceId: 'legacy-host', channel: 'maker:set-model',
        args: [sessionId, targetModel, targetProvider, (calls[0].result as { sameEngineRevision: number }).sameEngineRevision,
          { effort: 'high', fastMode: targetFast, thinking: true }],
        result: { deferred: true, superseded: false },
      });
      expect(calls.slice(2)).toEqual([]);
      expect(legacy.writes).toEqual([{ model: targetModel, providerId: targetProvider, effort: 'high', fastMode: targetFast }]);
    } else {
      expect(setModel).toEqual({ deviceId: 'legacy-host', channel: 'maker:set-model',
        args: [sessionId, targetModel, targetProvider], result: { deferred: true } });
      expect(legacy.intentPushes).toEqual([[sessionId, { agentSwitchIntent: null, agentSwitchIntentCanceled: true }]]);
      expect.soft(calls.slice(1)).toEqual([
        { deviceId: 'legacy-host', channel: 'maker:set-effort', args: [sessionId, 'high'], result: null },
        { deviceId: 'legacy-host', channel: 'maker:set-fast-mode', args: [sessionId, targetFast], result: null },
      ]);
      expect.soft(legacy.writes).toEqual([
        { model: targetModel, providerId: targetProvider }, { effort: 'high' }, { fastMode: targetFast },
      ]);
    }
    expect(legacy.routePending).toEqual({ model: targetModel, providerId: targetProvider });
    expect(legacy.live).toEqual({ model, providerId });
    expect.soft(legacy.prefs).toEqual({ effort: 'high', fastMode: targetFast });
    expect.soft(legacy.row).toEqual({ model: targetModel, providerId: targetProvider, effort: 'high', fastMode: targetFast });
    expect.soft(after).toEqual({ model: targetModel, providerId: targetProvider, effort: 'high', fastMode: targetFast });
  } finally {
    old.close();
  }
});


function openCurrentReceiver(unknown: boolean) {
  const child = spawn(process.execPath, [
    '--import', './src/loaders/test-region.mjs', '--import', 'tsx', '--import', './src/loaders/register-raw.mjs',
    '--test', '--experimental-test-isolation=none', '--test-name-pattern=L342 controller bridge fixture', 'src/agent/input-queue.test.mjs',
  ], { cwd: resolve(__dirname, '../../../../../../host'), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CINDY_L342_TEST_BRIDGE: '1', L342_FIXTURE_UNKNOWN: unknown ? '1' : '0' } });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const ended = Promise.withResolvers<number | null>();
  let tail: string[] = [];
  let seq = 0;
  const ready = Promise.withResolvers<unknown>();
  pending.set(0, ready);
  lines.on('line', line => {
    const index = line.indexOf('L342_REPLY ');
    if (index < 0) { tail = [...tail, line].slice(-25); return; }
    const reply = JSON.parse(line.slice(index + 'L342_REPLY '.length));
    const waiter = pending.get(reply.seq);
    pending.delete(reply.seq);
    if (reply.error) waiter?.reject(new Error(reply.error));
    else waiter?.resolve(reply.result);
  });
  child.stderr.on('data', data => { tail = [...tail, String(data)].slice(-25); });
  child.once('exit', code => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Host fixture exit ${code}\n${tail.join('\n')}`));
    ended.resolve(code);
  });
  const call = (channel: string, args: unknown[] = []) => {
    const next = ++seq;
    const reply = Promise.withResolvers<unknown>();
    pending.set(next, reply);
    child.stdin.write(JSON.stringify({ seq: next, channel, args }) + '\n');
    return reply.promise;
  };
  return { ready: ready.promise, call, ended: ended.promise, kill: () => child.kill() };
}

it.each([['unknown', 'failure'], ['known', 'failure'], ['known', 'success']] as const)(
  'new receiver %s capability through real picker and Host SQLite settlement (%s)',
  async (capability, expected) => {
    const unknown = capability === 'unknown';
    const bridge = openCurrentReceiver(unknown);
    const initial = { model: 'big', providerId: 'prov-a', effort: 'high', fastMode: unknown };
    const target = { model: 'big-alternate', providerId: 'prov-b', effort: 'medium', fastMode: !unknown };
    const sessionId = 'bridge-task';
    const models = [sshModel('big', { efforts: ['high'], defaultEffort: 'high', supportsFastMode: true }),
      sshModel('big-alternate', { efforts: ['medium'], defaultEffort: 'medium', supportsFastMode: true })];
    ui.providers = [sshProvider('prov-a', models), sshProvider('prov-b', models)];
    try {
      expect(await bridge.ready).toMatchObject({ row: initial, sent: ['work initial'] });
      const caps = await bridge.call('maker:get-capabilities', ['codex']) as NonNullable<typeof ui.capabilities>;
      expect(caps.supportsSessionAgentSwitchCas).toBe(true);
      ui.capabilities = unknown ? null : caps;
      const calls: [string, unknown[]][] = [];
      const invoke = async (_deviceId: string, channel: string, args: unknown[]) => {
        if (channel === 'maker:get-session-agent-switch-intent') return bridge.call(channel, args);
        if (!['maker:set-model', 'maker:set-effort', 'maker:set-fast-mode'].includes(channel)) return undefined;
        const wire = JSON.parse(JSON.stringify(args));
        calls.push([channel, wire]);
        return bridge.call(channel, wire);
      };
      const api: typeof window.electronAPI = new Proxy({} as typeof window.electronAPI, {
        get: (_target, key) => {
          if (key === 'invoke') return invoke;
          if (key === 'platform') return 'darwin';
          if (key === 'then') return undefined;
          if (key === 'listSync') return () => ({ ghosts: [] });
          if (key === 'getDataSnapshot') return () => { throw new Error('fixture bridge unavailable'); };
          if (key === 'setGlobalShortcut') return async () => ({ ok: true });
          if (String(key).startsWith('on')) return () => noop;
          return new Proxy(() => Promise.resolve(undefined), { get: (_fn, name) => Reflect.get(api, name) });
        },
      });
      window.electronAPI = api;
      vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
      render(<ChatInput sessionId={sessionId} deviceLinkDeviceId="legacy-host" initialWorkingDir="/fixture"
        runtimeAgentKind="codex" vendorKey="codex" initialModel="big" initialProviderId="prov-a" initialEffort="high"
        fastMode={initial.fastMode} attachmentState={attachmentState} showFolderPicker={false} disableAutofocus
        onSend={() => false} onFastModeChange={(value, device) => makerChatStore.setFastMode(sessionId, value, device)} />);
      await act(async () => { await ui.picker!.onProviderChange!('prov-b', 'big-alternate', 'medium', target.fastMode); });
      expect(screen.getByTestId('picker').textContent).toBe('big-alternate');
      if (unknown) {
        expect(calls).toEqual([['maker:set-model', [sessionId, 'big-alternate', 'prov-b']],
          ['maker:set-effort', [sessionId, 'medium']], ['maker:set-fast-mode', [sessionId, false]]]);
      } else {
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('maker:set-model');
        expect(calls[0][1]).toEqual([sessionId, 'big-alternate', 'prov-b', null, expect.objectContaining({ effort: 'medium', fastMode: true })]);
      }
      const before = unknown ? { ...initial, effort: 'medium', fastMode: false } : initial;
      expect(await bridge.call('inspect')).toMatchObject({ row: before, provider: 'prov-a', pending: true,
        intent: { targetAgentKind: 'codex', model: 'big-alternate', providerId: 'prov-b' }, events: [] });
      const after = await bridge.call('settle', [expected === 'failure']);
      if (expected === 'failure') {
        expect(after).toMatchObject({ row: before, pending: false, intent: null, sent: expect.arrayContaining(['next']) });
        const result = after as { events: { payload: object }[] };
        expect(result.events.map(event => event.payload)).toEqual([{ sessionId, reason: 'apply-failed',
          ...(unknown ? {} : { previousSettingsRetained: true }) }]);
      } else {
        expect(after).toMatchObject({ row: target, provider: 'prov-b', pending: false, intent: null, sent: ['next'] });
      }
      await bridge.call('stop');
      expect(await bridge.ended).toBe(0);
    } finally { bridge.kill(); }
  }, 40000,
);
