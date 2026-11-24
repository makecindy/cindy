import { describe, expect, it, vi } from 'vitest';

import { handleGhostHarnessesRequest } from '../ghostHarnessesEndpoint.js';

/*
 * 测试价值
 * - 生产入口与可观察结果：handleGhostHarnessesRequest（cindy-ghost:// 的 /harnesses 与远程设置页共用）的
 *   状态码、读回内容、落盘与通知次数。
 * - Bug／规则依据：docs/plans/acp-plugin-bridge.md「可用状态」（整体覆盖、内容不变无副作用、未声明 403、
 *   格式错误 400 且不改原状态、只收元数据）；plugin-security-and-authoring.md §3（自主能力按声明守门）。
 * - 现有覆盖缺口：新端点；/models 的测试不覆盖未声明 id、额外字段与旧记录过滤。
 * - 最小失败输入：PUT 未声明的 id；同内容重复 PUT；带 command 字段的条目。
 * - tier：unit（内存 store）。实测耗时：< 1s。
 */
const declared = [{ id: 'dsh', name: 'DeepSeek Harness', protocol: 'acp', entry: 'engine.js' }];
const available = { id: 'dsh', available: true, version: '0.2.2' };

function setup(harnesses: typeof declared | undefined | null, initial: Record<string, unknown> = {}) {
  let stored = initial;
  const store = { read: () => stored, write: vi.fn((_id: string, value: Record<string, unknown>) => { stored = value; }) };
  const onChanged = vi.fn();
  const call = async (method: string, body = '', current = true) => {
    const result = await handleGhostHarnessesRequest({
      ghostId: 'dsh-plugin', method, readBodyText: async () => body, isCurrent: () => current,
      declared: () => harnesses, store, onChanged,
    });
    return { status: result.status, body: result.body ? JSON.parse(result.body) : undefined };
  };
  return { store, onChanged, call };
}

describe('handleGhostHarnessesRequest', () => {
  it('replaces the whole list, reads it back and notifies only when the content changes', async () => {
    const { call, onChanged, store } = setup(declared);
    expect(await call('GET')).toEqual({ status: 200, body: { harnesses: [] } });
    // Extra fields are metadata the Host does not keep; a command can never be published.
    const put = await call('PUT', JSON.stringify({ harnesses: [{ ...available, command: 'rm -rf /' }] }));
    expect(put).toEqual({ status: 200, body: { harnesses: [available] } });
    expect(store.write).toHaveBeenCalledWith('dsh-plugin', { harnesses: [available] });
    expect(await call('GET')).toEqual({ status: 200, body: { harnesses: [available] } });
    await call('PUT', JSON.stringify({ harnesses: [available] }));
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    const missing = { id: 'dsh', available: false, reason: 'not-installed', message: 'Run npm i -g @deepseek-ai/dsh' };
    expect((await call('PUT', JSON.stringify({ harnesses: [missing] }))).status).toBe(200);
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect((await call('PUT', JSON.stringify({ harnesses: [] }))).body).toEqual({ harnesses: [] });
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  // 插件自己列出引擎的模型(2026-11-18 用户决定：模型由插件提供，获取与展示同普通供应商)。
  it('keeps the model list a plugin publishes, dropping fields other than id, name, description and group', async () => {
    const { call, store } = setup(declared);
    const models = [
      { id: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash', group: 'DeepSeek', price: 1 },
      { id: 'v4-pro', name: 'DeepSeek-V4-Pro', description: 'Stronger agentic coding' },
    ];
    const put = await call('PUT', JSON.stringify({ harnesses: [{ ...available, models }] }));
    const kept = {
      ...available,
      models: [
        { id: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash', group: 'DeepSeek' },
        { id: 'v4-pro', name: 'DeepSeek-V4-Pro', description: 'Stronger agentic coding' },
      ],
    };
    expect(put).toEqual({ status: 200, body: { harnesses: [kept] } });
    expect(store.write).toHaveBeenCalledWith('dsh-plugin', { harnesses: [kept] });
  });

  // 插件引擎的思考深度(2026-11-19 用户决定：插件基座通用支持，展示与普通模型一致)。DSH 的
  // reasoning_effort 选项是 off / low / high / max:Cindy 没有 off,只收它认得的档位。
  it('keeps the reasoning levels a model offers in low-to-high order and skips level ids Cindy does not know', async () => {
    const { call } = setup(declared);
    const models = [
      { id: 'pro', name: 'Pro', efforts: ['max', 'off', 'low', 'high', 'low'], defaultEffort: 'high' },
      { id: 'flash', name: 'Flash', efforts: ['off'], defaultEffort: 'off' },
      { id: 'lite', name: 'Lite', efforts: ['low', 'high'], defaultEffort: 'max' },
    ];
    const put = await call('PUT', JSON.stringify({ harnesses: [{ ...available, models }] }));
    expect(put.status).toBe(200);
    expect(put.body.harnesses[0].models).toEqual([
      { id: 'pro', name: 'Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      { id: 'flash', name: 'Flash' },
      { id: 'lite', name: 'Lite', efforts: ['low', 'high'] },
    ]);
  });

  // Antigravity(agy)公布 default / accept-edits / auto / plan，插件按 Cindy 权限档 id 上报(2026-11-19)。
  it('keeps the working modes an engine offers in its own order, skipping mode ids Cindy does not know', async () => {
    const { call } = setup(declared);
    const put = await call('PUT', JSON.stringify({ harnesses: [{
      ...available, modes: ['default', 'acceptEdits', 'yolo', 'auto', 'plan', 'auto'], defaultMode: 'default',
    }] }));
    expect(put.status).toBe(200);
    expect(put.body.harnesses[0]).toEqual({ ...available, modes: ['default', 'acceptEdits', 'auto', 'plan'], defaultMode: 'default' });
    const unknownDefault = await call('PUT', JSON.stringify({ harnesses: [{ ...available, modes: ['plan'], defaultMode: 'yolo' }] }));
    expect(unknownDefault.body.harnesses[0]).toEqual({ ...available, modes: ['plan'] });
  });

  it.each([
    ['not JSON', 'nope'],
    ['no list', JSON.stringify({ dsh: true })],
    ['undeclared id', JSON.stringify({ harnesses: [{ id: 'other', available: true }] })],
    ['duplicate id', JSON.stringify({ harnesses: [available, available] })],
    ['non-boolean availability', JSON.stringify({ harnesses: [{ id: 'dsh', available: 'yes' }] })],
    ['reason that is not a slug', JSON.stringify({ harnesses: [{ id: 'dsh', available: false, reason: 'Not Installed' }] })],
    ['long message', JSON.stringify({ harnesses: [{ id: 'dsh', available: false, message: 'x'.repeat(201) }] })],
    ['long version', JSON.stringify({ harnesses: [{ id: 'dsh', available: true, version: '1'.repeat(65) }] })],
    ['models that are not a list', JSON.stringify({ harnesses: [{ ...available, models: { id: 'a' } }] })],
    ['a model without a name', JSON.stringify({ harnesses: [{ ...available, models: [{ id: 'a' }] }] })],
    ['duplicate model ids', JSON.stringify({ harnesses: [{ ...available, models: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] }] })],
    ['too many models', JSON.stringify({ harnesses: [{ ...available, models: Array.from({ length: 201 }, (_, i) => ({ id: `m${i}`, name: `M${i}` })) }] })],
    ['efforts that are not a list', JSON.stringify({ harnesses: [{ ...available, models: [{ id: 'a', name: 'A', efforts: 'high' }] }] })],
    ['an effort that is not text', JSON.stringify({ harnesses: [{ ...available, models: [{ id: 'a', name: 'A', efforts: ['high', 3] }] }] })],
    ['modes that are not a list', JSON.stringify({ harnesses: [{ ...available, modes: 'plan' }] })],
    ['a default mode without modes', JSON.stringify({ harnesses: [{ ...available, defaultMode: 'plan' }] })],
    ['a default without efforts', JSON.stringify({ harnesses: [{ ...available, models: [{ id: 'a', name: 'A', defaultEffort: 'high' }] }] })],
  ])('rejects %s with 400 and keeps the previous list', async (_label, body) => {
    const { call, store, onChanged } = setup(declared, { harnesses: [available] });
    expect((await call('PUT', body)).status).toBe(400);
    expect(store.write).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect((await call('GET')).body).toEqual({ harnesses: [available] });
  });

  it('answers 403 without a declaration, 404 when not installed, 405 for other methods and 403 for a stale page', async () => {
    expect((await setup(undefined).call('GET')).status).toBe(403);
    expect((await setup(undefined).call('PUT', JSON.stringify({ harnesses: [] }))).status).toBe(403);
    expect((await setup(null).call('GET')).status).toBe(404);
    const { call, store } = setup(declared);
    expect((await call('DELETE')).status).toBe(405);
    expect((await call('PUT', JSON.stringify({ harnesses: [available] }), false)).status).toBe(403);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('does not return a stored entry for an engine the current manifest no longer declares', async () => {
    const { call } = setup(declared, { harnesses: [available, { id: 'removed', available: true }] });
    expect((await call('GET')).body).toEqual({ harnesses: [available] });
  });
});
