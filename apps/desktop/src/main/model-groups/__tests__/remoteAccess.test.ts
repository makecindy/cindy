/**
 * 测试价值
 * - 生产入口与可观察结果：assertModelGroupsCaller(model-groups:get/resolve/commit/bind-session/route-note 的来源闸)
 *   放行谁、拒绝谁；acceptModelGroupRouteNote(model-groups:route-note 的实现)在任务里写下的那一行说明；
 *   sanitizeModelGroupRouteNote 对远程送来的说明的收法。
 * - 规则依据：docs/product-rules/model-groups.md §6.3(同账号本人控制的设备才能用这台电脑的模式，说明由这台代写)；
 *   docs/dev-rules/protocol-compatibility/model-groups-remote-pickers.md。
 * - 现有覆盖缺口：这些接口原先只接受本机界面，没有远程来源的权限分支，也没有代写说明的实现。
 * - 最小失败输入：分享来的任务(scoped 控制端)调用被放行；本机不可信页面绕过主界面闸；
 *   任务不存在仍写说明；说明排在首条消息之前；远程送来超长或缺字段的说明被原样落库。
 * - tier：unit，依赖全部注入(来源判定、任务读取、消息落库、等待)。
 * - 实测耗时：单独运行约 1 秒（pnpm --dir apps/desktop exec vitest run src/main/model-groups/__tests__/remoteAccess.test.ts）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

import { sanitizeModelGroupRouteNote, type ModelGroupRouteNote } from '../../../shared/modelGroups.js';
import { assertModelGroupsCaller } from '../remoteAccess.js';
import { acceptModelGroupRouteNote, type ModelGroupRouteNotePorts } from '../routeNote.js';

const event = {} as IpcMainInvokeEvent;

describe('assertModelGroupsCaller', () => {
  it.each([
    { name: 'local trusted renderer', isDeviceLink: false, origin: undefined, trusted: true, ok: true },
    { name: 'local untrusted page', isDeviceLink: false, origin: undefined, trusted: false, ok: false },
    { name: 'same-account owner controller', isDeviceLink: true, origin: 'owner' as const, trusted: false, ok: true },
    { name: 'shared task / scoped controller', isDeviceLink: true, origin: 'scoped' as const, trusted: true, ok: false },
    { name: 'device link without origin', isDeviceLink: true, origin: undefined, trusted: true, ok: false },
  ])('$name', ({ isDeviceLink, origin, trusted, ok }) => {
    const assertTrusted = vi.fn(() => { if (!trusted) throw new Error('untrusted'); });
    const call = () => assertModelGroupsCaller(event, { isDeviceLink: () => isDeviceLink, origin: () => origin, assertTrusted });
    if (ok) expect(call).not.toThrow();
    else expect(call).toThrow();
    // 远程调用不走主界面闸(那里没有窗口)，本机调用一定走。
    expect(assertTrusted).toHaveBeenCalledTimes(isDeviceLink ? 0 : 1);
  });
});

const note: ModelGroupRouteNote = { pluginName: 'Daily', outcome: 'routed', modelName: 'GPT · Work', reason: 'Expiring soonest', source: 'model-group' };

function ports(overrides: Partial<ModelGroupRouteNotePorts> = {}) {
  const created: Array<{ sessionId: string; clientId: string; createdAt?: number; note: ModelGroupRouteNote }> = [];
  let polls = 0;
  const value: ModelGroupRouteNotePorts = {
    sessionExists: async () => true,
    firstUserMessageAt: async () => (++polls >= 3 ? 1_000 : null),
    createNote: async (sessionId, row) => { created.push({ sessionId, ...row }); },
    sleep: async () => undefined,
    ...overrides,
  };
  return { value, created };
}

describe('acceptModelGroupRouteNote', () => {
  it('writes one note right after the first user message once it lands', async () => {
    const { value, created } = ports();
    await expect(acceptModelGroupRouteNote(value, 's1', note)).resolves.toBe(true);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    // 同一个 clientId：与本机界面写的说明合并成一行；排在首条消息下面、回复上面。
    expect(created[0]).toEqual({ sessionId: 's1', clientId: 'model-group-route:s1', createdAt: 1_001, note });
  });

  it('rejects a session that does not exist on this computer and writes nothing', async () => {
    const { value, created } = ports({ sessionExists: async () => false });
    await expect(acceptModelGroupRouteNote(value, 'missing', note)).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(created).toHaveLength(0);
  });

  it('still writes the note when the first message never shows up', async () => {
    const { value, created } = ports({ firstUserMessageAt: async () => null });
    await acceptModelGroupRouteNote(value, 's2', note);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]?.createdAt).toBeUndefined();
  });
});

describe('sanitizeModelGroupRouteNote', () => {
  it.each([
    { name: 'missing group name', raw: { outcome: 'routed', modelName: 'm' }, expected: null },
    { name: 'unknown outcome', raw: { pluginName: 'g', outcome: 'other', modelName: 'm' }, expected: null },
    {
      name: 'kept note forces the only kept reason and drops foreign fields',
      raw: { pluginName: 'g', outcome: 'kept', modelName: 'm', why: 'failed', extra: 'x', source: 'plugin' },
      expected: { pluginName: 'g', outcome: 'kept', modelName: 'm', why: 'unavailable-route', source: 'model-group' },
    },
  ])('$name', ({ raw, expected }) => {
    expect(sanitizeModelGroupRouteNote(raw)).toEqual(expected);
  });

  it('bounds text fields from the remote side', () => {
    const result = sanitizeModelGroupRouteNote({ pluginName: 'g'.repeat(100), outcome: 'routed', modelName: 'm', reason: 'r'.repeat(2_000) });
    expect(result?.pluginName).toHaveLength(40);
    expect(result?.reason).toHaveLength(512);
  });
});
