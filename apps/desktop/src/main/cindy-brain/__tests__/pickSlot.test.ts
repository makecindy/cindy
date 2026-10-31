/** pickSlot.test — 目录选择槽(pick)的假 deps 单测。 */

import { describe, expect, it, vi } from 'vitest';

import { GHOST_PIPE_CALL_MAX_TOTAL_MS, type InstalledGhost } from '../../../shared/ghost';
import { installedGhostMutationTargetToken } from '../../../shared/pluginIdentity';
import { GhostPipeDispatcher } from '../pipeDispatcher';
import { GhostPickSlot, type PickSlotDeps } from '../pickSlot';

function pickGhost(options: { pick?: boolean; node?: boolean; enabled?: boolean } = {}): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'pick-ghost',
      name: 'Pick Ghost',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      ...(options.pick === false ? {} : { pick: true }),
      ...(options.node !== false
        ? { node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' } }
        : {}),
    },
    dir: '/fake/pick-ghost',
    enabled: options.enabled ?? true,
  } as InstalledGhost;
}

function makeSlot(overrides: Partial<PickSlotDeps> = {}) {
  let clock = 0;
  const deps: PickSlotDeps = {
    getGhost: () => pickGhost(),
    getMutationTarget: () => 'installed-target',
    showDirectoryDialog: vi.fn(async () => '/Users/me/projects'),
    depositDir: vi.fn(() => ({
      ok: true as const,
      receipt: { token: 't', file_count: 1, total_bytes: 10, rel_paths: ['a.txt'] },
    })),
    now: () => (clock += 60_000),
    ...overrides,
  };
  return { slot: new GhostPickSlot(deps), deps };
}

describe('pickSlot · 资格审与载荷校验', () => {
  it('未声明 pick 能力 / 未启用 一律 PERMISSION_DENIED', async () => {
    const noSlot = makeSlot({ getGhost: () => pickGhost({ pick: false }) });
    expect(await noSlot.slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    const disabled = makeSlot({ getGhost: () => pickGhost({ enabled: false }) });
    expect(await disabled.slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
  });

  it('mode 只认 directory;title/deposit 类型不对整单拒', async () => {
    const { slot } = makeSlot();
    expect(await slot.handleRequest('pick-ghost', { mode: 'file' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(await slot.handleRequest('pick-ghost', { mode: 'directory', title: 1 })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(
      await slot.handleRequest('pick-ghost', { mode: 'directory', deposit: 'yes' }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
  });

  it('未声明 node 能力的插件必须 deposit:true,否则选完什么都拿不到 = 拒单', async () => {
    const { slot } = makeSlot({ getGhost: () => pickGhost({ node: false }) });
    expect(await slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
  });
});

describe('pickSlot · 授权 = 用户亲选', () => {
  it('用户选中:node 槽插件拿到 path;deposit:true 再拿票据', async () => {
    const { slot, deps } = makeSlot();
    const result = await slot.handleRequest('pick-ghost', {
      mode: 'directory',
      title: '选择项目父目录',
      deposit: true,
    });
    expect(result).toMatchObject({
      ok: true,
      name: 'projects',
      path: '/Users/me/projects',
      dir_deposit: { token: 't' },
    });
    expect(deps.showDirectoryDialog).toHaveBeenCalledWith({
      ghostId: 'pick-ghost',
      ghostName: 'Pick Ghost',
      purpose: '选择项目父目录',
    });
  });

  it('不带 deposit 时只有 path,没有票据;非 node 插件带 deposit 只有票据没有 path', async () => {
    const { slot } = makeSlot();
    const nodeOnly = await slot.handleRequest('pick-ghost', { mode: 'directory' });
    expect(nodeOnly).toMatchObject({ ok: true, path: '/Users/me/projects' });
    expect((nodeOnly as { dir_deposit?: unknown }).dir_deposit).toBeUndefined();

    const depositOnly = makeSlot({ getGhost: () => pickGhost({ node: false }) });
    const r = await depositOnly.slot.handleRequest('pick-ghost', {
      mode: 'directory',
      deposit: true,
    });
    expect(r).toMatchObject({ ok: true, dir_deposit: { token: 't' } });
    expect((r as { path?: unknown }).path).toBeUndefined();
  });

  it('用户取消 = CANCELLED,插件拿不到任何路径信息', async () => {
    const { slot } = makeSlot({ showDirectoryDialog: vi.fn(async () => null) });
    const result = await slot.handleRequest('pick-ghost', { mode: 'directory' });
    expect(result).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
    expect(JSON.stringify(result)).not.toContain('/Users');
  });

  it('票据签发失败(如超收集上限)如实报 INTERNAL,不发半成品', async () => {
    const { slot } = makeSlot({
      depositDir: () => ({ ok: false as const, message: '超过收集上限' }),
    });
    expect(
      await slot.handleRequest('pick-ghost', { mode: 'directory', deposit: true }),
    ).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
  });

  it('亲选成功记台账(recordPickedDir);取消不记', async () => {
    const recordPickedDir = vi.fn();
    const { slot } = makeSlot({ recordPickedDir });
    await slot.handleRequest('pick-ghost', { mode: 'directory' });
    expect(recordPickedDir).toHaveBeenCalledWith('pick-ghost', '/Users/me/projects');

    const cancelled = makeSlot({
      showDirectoryDialog: vi.fn(async () => null),
      recordPickedDir,
    });
    recordPickedDir.mockClear();
    await cancelled.slot.handleRequest('pick-ghost', { mode: 'directory' });
    expect(recordPickedDir).not.toHaveBeenCalled();
  });

  it('票据签发失败也已记台账(用户确实亲选过,授权事实不随票据丢)', async () => {
    const recordPickedDir = vi.fn();
    const { slot } = makeSlot({
      depositDir: () => ({ ok: false as const, message: '超过收集上限' }),
      recordPickedDir,
    });
    await slot.handleRequest('pick-ghost', { mode: 'directory', deposit: true });
    expect(recordPickedDir).toHaveBeenCalledWith('pick-ghost', '/Users/me/projects');
  });
});

describe('pickSlot · 晚到的选择结果', () => {
  it.each(['root-reuse', 'source-switch', 'owner-switch', 'disabled', 'unchanged'])(
    '%s 不把旧授权交给新目标',
    async (change) => {
      let current = {
        ...pickGhost(),
        namespace: 'acme' as string | null,
        approval: { state: 'approved' as const, revision: 'receipt-1' },
      };
      let owner = 'owner-1';
      let release!: (value: string | null) => void;
      const dialog = new Promise<string | null>((resolve) => { release = resolve; });
      const recordPickedDir = vi.fn();
      const { slot, deps } = makeSlot({
        getGhost: () => current,
        getMutationTarget: () => installedGhostMutationTargetToken(current, owner),
        showDirectoryDialog: () => dialog,
        recordPickedDir,
      });
      const pending = slot.handleRequest('pick-ghost', { mode: 'directory', deposit: true });
      if (change === 'root-reuse') current = { ...current, namespace: null };
      if (change === 'source-switch') {
        current = { ...current, approval: { state: 'approved', revision: 'receipt-2' } };
      }
      if (change === 'owner-switch') owner = 'owner-2';
      if (change === 'disabled') current = { ...current, enabled: false };
      release('/Users/me/projects');
      if (change === 'unchanged') {
        expect(await pending).toMatchObject({ ok: true });
        expect(recordPickedDir).toHaveBeenCalledOnce();
        expect(deps.depositDir).toHaveBeenCalledOnce();
      } else {
        expect(await pending).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
        expect(recordPickedDir).not.toHaveBeenCalled();
        expect(deps.depositDir).not.toHaveBeenCalled();
      }
    },
  );

  it('无法绑定目标时不打开选择框', async () => {
    const { slot, deps } = makeSlot({ getMutationTarget: () => null });
    expect(await slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({
      ok: false, errorCode: 'PERMISSION_DENIED',
    });
    expect(deps.showDirectoryDialog).not.toHaveBeenCalled();
  });
});

describe('pickSlot · 骚扰钳制', () => {
  it('同插件两次请求间隔不足 = RATE_LIMITED(按尝试记账)', async () => {
    let clock = 0;
    const { slot } = makeSlot({ now: () => (clock += 1000) });
    expect((await slot.handleRequest('pick-ghost', { mode: 'directory' })).ok).toBe(true);
    expect(await slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({
      ok: false,
      errorCode: 'RATE_LIMITED',
    });
  });

  it('已有选择框在场 = BUSY,不排队', async () => {
    let release: (value: string | null) => void = () => {};
    const gate = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const { slot } = makeSlot({ showDirectoryDialog: vi.fn(() => gate) });
    const first = slot.handleRequest('pick-ghost', { mode: 'directory' });
    const second = await slot.handleRequest('pick-ghost', { mode: 'directory' });
    expect(second).toMatchObject({ ok: false, errorCode: 'BUSY' });
    release('/tmp/dir');
    expect((await first).ok).toBe(true);
  });

  it('对话框打不开(无宿主窗口)= INTERNAL,失败关闭', async () => {
    const { slot } = makeSlot({
      showDirectoryDialog: vi.fn(async () => {
        throw new Error('no window');
      }),
    });
    expect(await slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
    });
  });
});

// B2: real pick entry must retain directory consent/owner rules for file selection.
// tier: unit; minimum failure input is a selected file followed by a changed install target.
describe('file selection', () => {
  // PR #7924: a valid directory can leave no generated-file budget. Unit through
  // the real pick request entry; earlier tests only selected short media paths.
  // Reject before native UI or import rather than reporting INTERNAL after selection.
  it('rejects an exhausted Library path budget before opening the file selector', async () => {
    const ghost = pickGhost({ node: false }); ghost.manifest.library = true;
    const showFileDialog = vi.fn(async () => ['/selected/file.txt']);
    const importFiles = vi.fn(async () => ({ ok: true as const, name: 'file.txt' }));
    const { slot } = makeSlot({ getGhost: () => ghost, showFileDialog, importFiles });
    const directory = [...Array(3).fill('a'.repeat(64)), 'b'.repeat(18)].join('/');
    expect(await slot.handleRequest('pick-ghost', { mode: 'file', into: 'library', path: directory }))
      .toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(showFileDialog).not.toHaveBeenCalled();
    expect(importFiles).not.toHaveBeenCalled();
  });

  it('imports selected files without paths for non-Node plugins and can issue a single-file deposit', async () => {
    const { slot } = makeSlot({ getGhost: () => pickGhost({ node: false }),
      showFileDialog: async () => ['/selected/image.png'],
      importFiles: async (_id, _paths, input) => { input.assertCurrent(); return { ok: true, name: 'image.png', files: [{ name: 'image.png', size: 3, mimeType: 'image/png', ref: 'cindy-media://blobs/image.png' }] }; },
    });
    const result = await slot.handleRequest('pick-ghost', { mode: 'file', into: 'media', deposit: true });
    expect(result).toMatchObject({ ok: true, files: [{ deposit: { token: 't' } }] });
    if (result.ok) expect(result.files![0]).not.toHaveProperty('path');
  });
  it('rejects the selected file when the plugin changes while the dialog is open', async () => {
    let target = 'A';
    const importFiles = vi.fn();
    const { slot } = makeSlot({ getMutationTarget: () => target, importFiles,
      showFileDialog: async () => { target = 'B'; return ['/selected/a']; },
    });
    expect(await slot.handleRequest('pick-ghost', { mode: 'file', into: 'media' })).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(importFiles).not.toHaveBeenCalled();
  });

  // #4423417275, unit: real pick entry must report committed Library refs even
  // when a later deposit cannot be issued. Existing coverage only issued tickets
  // successfully; minimum input is an imported file above the ticket size limit.
  it('retains every imported file when ticket issuance fails midway through the batch', async () => {
    const ghost = pickGhost({ node: false }); ghost.manifest.library = true;
    const imported = [
      { name: 'first.txt', size: 1, mimeType: 'text/plain', ref: 'library://first' },
      { name: 'large.txt', size: 51 * 1024 * 1024, mimeType: 'text/plain', ref: 'library://large' },
      { name: 'last.txt', size: 1, mimeType: 'text/plain', ref: 'library://last' },
    ];
    const receipt = { token: 'first-ticket', file_count: 1, total_bytes: 1, rel_paths: ['first.txt'] };
    const depositDir = vi.fn<PickSlotDeps['depositDir']>()
      .mockReturnValueOnce({ ok: true, receipt })
      .mockReturnValue({ ok: false, message: '文件超过 50 MiB 上限' });
    const { slot } = makeSlot({
      getGhost: () => ghost,
      showFileDialog: async () => imported.map(file => `/selected/${file.name}`),
      importFiles: async () => ({ ok: true, name: imported[0]!.name, files: imported.map(file => ({ ...file })) }),
      depositDir,
    });
    const result = await slot.handleRequest('pick-ghost', { mode: 'file', into: 'library', deposit: true, multiple: true });
    expect(result).toMatchObject({ ok: false, errorCode: 'INTERNAL', files: [
      { ...imported[0], deposit: receipt }, imported[1], imported[2],
    ] });
    expect(depositDir).toHaveBeenCalledTimes(2);
    expect(result.files?.every(file => file.path === undefined)).toBe(true);
  });
});

// Regression: native pick had no call hold or cancellation binding. Tier: unit.
// Real dispatcher + slot; minimal input is one open panel past 330s, or a late
// selection after caller cancellation. Only native UI and import/deposit sinks are fakes.
describe('call-bound pick lifetime', () => {
  it.each(['directory', 'file'] as const)('holds %s selection past 330s and releases after delivery', async mode => {
    vi.useFakeTimers();
    try {
      const h = lifecycleHarness();
      const call = h.dispatcher.callGhostTool({ ghostId: 'pick-ghost', tool: 'pick', args: {}, callId: 'active' });
      await vi.advanceTimersByTimeAsync(0);
      const picked = h.slot.handleRequest('pick-ghost', { mode, into: 'media', callId: 'active', deposit: true });
      await vi.advanceTimersByTimeAsync(331_000);
      expect(h.dispatcher.getPendingCallSignal('pick-ghost', 'active')?.aborted).toBe(false);
      h.select(['/selected/file.png']);
      expect(await picked).toMatchObject({ ok: true });
      h.dispatcher.handleToolResult('pick-ghost', { callId: 'active', ok: true, result: 'done' });
      expect(await call).toMatchObject({ ok: true });
    } finally { vi.useRealTimers(); }
  });

  it.each(['cancel', 'hard-limit', 'owner', 'version'] as const)('rejects late selections after %s without importing or issuing tickets', async reason => {
    vi.useFakeTimers();
    try {
      const h = lifecycleHarness();
      const caller = new AbortController();
      const call = h.dispatcher.callGhostTool({ ghostId: 'pick-ghost', tool: 'pick', args: {}, callId: 'active', signal: caller.signal });
      await vi.advanceTimersByTimeAsync(0);
      const picked = h.slot.handleRequest('pick-ghost', { mode: 'file', into: 'media', deposit: true, callId: 'active' });
      if (reason === 'cancel') caller.abort();
      if (reason === 'hard-limit') await vi.advanceTimersByTimeAsync(GHOST_PIPE_CALL_MAX_TOTAL_MS);
      if (reason === 'owner' || reason === 'version') h.invalidate(reason);
      if (reason === 'cancel' || reason === 'hard-limit') {
        expect(await picked).toMatchObject({ ok: false, errorCode: 'CANCELLED' });
        expect(await call).toMatchObject({ ok: false, errorCode: reason === 'cancel' ? 'CANCELLED' : 'TIMEOUT' });
      }
      expect(await h.slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({ errorCode: 'BUSY' });
      h.select(['/selected/file.png']);
      expect(await picked).toMatchObject({ ok: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.deps.importFiles).not.toHaveBeenCalled();
      expect(h.deps.depositDir).not.toHaveBeenCalled();
      expect(await h.slot.handleRequest('pick-ghost', { mode: 'directory' })).toMatchObject({ ok: true });
      h.dispatcher.handleToolResult('pick-ghost', { callId: 'active', ok: true, result: 'late' });
      if (reason === 'version') await call;
      if (reason === 'owner') { await vi.advanceTimersByTimeAsync(GHOST_PIPE_CALL_MAX_TOTAL_MS); await call; }
    } finally { vi.useRealTimers(); }
  });

  it('rejects a foreign or expired call before opening a native panel', async () => {
    const h = lifecycleHarness();
    expect(await h.slot.handleRequest('pick-ghost', { mode: 'directory', callId: 'missing' })).toMatchObject({ errorCode: 'CANCELLED' });
    expect(h.deps.showDirectoryDialog).not.toHaveBeenCalled();
  });
});

function lifecycleHarness() {
  let select!: (files: string[]) => void;
  const panel = new Promise<string[]>(resolve => { select = resolve; });
  const ghost = pickGhost();
  ghost.manifest.tools = [{ name: 'pick', description: 'Select' }];
  let owner = 'A', version = '1';
  const dispatcher = new GhostPipeDispatcher({ getGhost: () => ghost, runtimeStateOf: () => 'running',
    spawn: async () => ({ ok: true }), sendToGhost: () => true,
    ownerScope: { capture: () => owner, isCurrent: snapshot => snapshot === owner, isStable: () => true },
  });
  const h = makeSlot({ getGhost: () => ghost, getMutationTarget: () => `${owner}/${version}`,
    getPendingCallSignal: (id, call) => dispatcher.getPendingCallSignal(id, call),
    holdCall: (id, call, budget) => dispatcher.holdCall(id, call, budget),
    releaseCall: (id, call) => dispatcher.releaseCall(id, call),
    showDirectoryDialog: vi.fn(async () => (await panel)[0]), showFileDialog: vi.fn(() => panel),
    importFiles: vi.fn(async (_id, _paths, input) => { input.assertCurrent(); return { ok: true as const, name: 'file.png', files: [{ name: 'file.png', size: 1, mimeType: 'image/png' }] }; }),
  });
  return { ...h, dispatcher, select, invalidate: (kind: 'owner' | 'version') => { if (kind === 'owner') owner = 'B'; else version = '2'; } };
}
