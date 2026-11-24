/*
 * 测试价值
 * - 生产入口与可观察结果：GhostFileOpenerSlot.open / handleResult。用户「用默认应用打开」时，
 *   文件是交给插件（handled）还是回落系统默认应用（未处理的各原因），以及发给插件的 open-file 事件。
 * - 规则依据：plugin-security-and-authoring.md §1.2 fileOpener、§2「身份由主机反查而非信任自报」；
 *   插件不可用时不能让文件打不开（回落默认应用）。
 * - 现有覆盖缺口：新能力。
 * - 最小失败输入：别的插件冒名回执；插件不回执；用户关掉了开关；插件没声明 node。
 * - tier：unit（注入假插件列表、运行时与投递，假时钟；无真实进程）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { GHOST_FILE_OPEN_TIMEOUT_MS, GhostFileOpenerSlot, type GhostFileOpenerDeps } from '../fileOpenerSlot';

const FILE = 'C:\\work\\季度报告.docx';

function plugin(id: string, opts: { enabled?: boolean; node?: boolean; extensions?: string[] } = {}): InstalledGhost {
  return {
    enabled: opts.enabled ?? true,
    manifest: {
      id,
      name: `Plugin ${id}`,
      ...(opts.node === false ? {} : { node: { entry: 'node/worker.cjs', protocol: 'json-rpc-stdio' } }),
      fileOpener: { extensions: opts.extensions ?? ['.docx'] },
    },
  } as unknown as InstalledGhost;
}

function setup(ghosts: InstalledGhost[], overrides: Partial<GhostFileOpenerDeps> = {}) {
  const sent: Array<{ instanceId: string; payload: Record<string, unknown> }> = [];
  const deps: GhostFileOpenerDeps = {
    listGhosts: () => ghosts,
    instanceId: (ghost) => ghost.manifest.id,
    isEnabledByUser: () => true,
    isRunning: () => true,
    wake: vi.fn(async () => undefined),
    send: (instanceId, payload) => {
      sent.push({ instanceId, payload: payload as Record<string, unknown> });
      return true;
    },
    now: () => 1_000,
    newRequestId: () => 'req-1',
    log: { warn: vi.fn() },
    ...overrides,
  };
  return { slot: new GhostFileOpenerSlot(deps), deps, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GhostFileOpenerSlot', () => {
  it('hands the file to the first eligible plugin, waking it, and reports handled on its ok reply', async () => {
    const { slot, deps, sent } = setup(
      [plugin('off'), plugin('pdf', { extensions: ['.pdf'] }), plugin('office'), plugin('later')],
      { isEnabledByUser: (id) => id !== 'off', isRunning: () => false },
    );
    const pending = slot.open(FILE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(deps.wake).toHaveBeenCalledTimes(1);
    expect(sent[0]).toEqual({
      instanceId: 'office',
      payload: {
        type: 'event', name: 'open-file', requestId: 'req-1', ts: 1_000,
        deadline: 1_000 + GHOST_FILE_OPEN_TIMEOUT_MS, data: { path: FILE },
      },
    });
    slot.handleResult('office', { type: 'file-open-result', requestId: 'req-1', ok: true });
    await expect(pending).resolves.toEqual({ handled: true, instanceId: 'office', name: 'Plugin office' });
  });

  it('ignores a reply from another plugin and falls back when the asked plugin never answers', async () => {
    vi.useFakeTimers();
    const { slot } = setup([plugin('office')]);
    const pending = slot.open(FILE);
    await vi.advanceTimersByTimeAsync(0);
    slot.handleResult('impostor', { requestId: 'req-1', ok: true });
    await vi.advanceTimersByTimeAsync(GHOST_FILE_OPEN_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ handled: false, reason: 'timeout' });
  });

  it.each([
    ['no plugin declares the extension', [plugin('pdf', { extensions: ['.pdf'] })], 'no-plugin'],
    ['the plugin is disabled', [plugin('office', { enabled: false })], 'no-plugin'],
    ['the plugin has no node worker', [plugin('office', { node: false })], 'no-plugin'],
  ] as const)('does not offer the file when %s', async (_label, ghosts, reason) => {
    const { slot, sent } = setup([...ghosts]);
    await expect(slot.open(FILE)).resolves.toEqual({ handled: false, reason });
    expect(sent).toHaveLength(0);
  });

  it('falls back when the plugin declines or its logic page is offline', async () => {
    const declined = setup([plugin('office')]);
    const pending = declined.slot.open(FILE);
    await vi.waitFor(() => expect(declined.sent).toHaveLength(1));
    declined.slot.handleResult('office', { requestId: 'req-1', ok: false });
    await expect(pending).resolves.toEqual({ handled: false, reason: 'declined' });

    const offline = setup([plugin('office')], { send: () => false });
    await expect(offline.slot.open(FILE)).resolves.toEqual({ handled: false, reason: 'unavailable' });
  });
});
