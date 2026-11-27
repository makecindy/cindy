import { describe, expect, it, vi } from 'vitest';

import { handleGhostEngineSettingsRequest } from '../ghostEngineSettingsEndpoint.js';

/*
 * 测试价值
 * - 生产入口与可观察结果：handleGhostEngineSettingsRequest（cindy-ghost:// 的 POST /harnesses/open-settings）的
 *   状态码、是否真的打开了设置页、以及用户的那一次点击有没有被用掉。
 * - Bug／规则依据：plugin-security-and-authoring.md「插件页面打开自己引擎的供应商设置」（只认本插件声明的引擎、
 *   必须紧跟宿主看到的点击、只导航）；§3（自主能力按声明守门）。
 * - 现有覆盖缺口：新端点；/harnesses 的测试不涉及用户手势，也没有「打开界面」这一类结果。
 * - 最小失败输入：没有点击就调用；点名别的插件或内置供应商的 id；格式错误的请求把点击白白用掉。
 * - tier：unit（依赖全部注入）。实测耗时：< 1s。
 */
const declared = [{ id: 'agy', name: 'Antigravity', protocol: 'acp', entry: 'agy-acp.js' }];

function setup(options: { harnesses?: typeof declared | undefined | null; gesture?: boolean; window?: boolean } = {}) {
  let gesture = options.gesture ?? true;
  const consumeUserGesture = vi.fn(() => { const had = gesture; gesture = false; return had; });
  const open = vi.fn(() => options.window ?? true);
  const call = async (method: string, body = '', current = true) => {
    const result = await handleGhostEngineSettingsRequest({
      method, readBodyText: async () => body, isCurrent: () => current,
      declared: () => ('harnesses' in options ? options.harnesses : declared),
      consumeUserGesture, open,
    });
    return result.status;
  };
  return { call, consumeUserGesture, open };
}

describe('handleGhostEngineSettingsRequest', () => {
  it('opens the settings of a declared engine once per click', async () => {
    const { call, open } = setup();
    expect(await call('POST', '{"id":"agy"}')).toBe(200);
    expect(open).toHaveBeenCalledExactlyOnceWith('agy');
    // The same click cannot open it again: a page cannot keep pulling the user back to the settings.
    expect(await call('POST', '{"id":"agy"}')).toBe(403);
    expect(open).toHaveBeenCalledOnce();
  });

  it('does nothing without a click Cindy saw in the page', async () => {
    const { call, open } = setup({ gesture: false });
    expect(await call('POST', '{"id":"agy"}')).toBe(403);
    expect(open).not.toHaveBeenCalled();
  });

  // Another plugin's engine or a built-in provider is never the page's to choose; a malformed request
  // must not use up the click the user made for a valid one.
  it.each([
    ['an engine the plugin does not declare', '{"id":"codex"}', 403],
    ['an engine key of another plugin', '{"id":"other-plugin:agy"}', 403],
    ['a body that is not JSON', 'agy', 400],
    ['a missing id', '{}', 400],
    ['an id that is not text', '{"id":7}', 400],
    ['an extra field', '{"id":"agy","tab":"billing"}', 400],
    ['an oversized body', JSON.stringify({ id: 'a'.repeat(400) }), 400],
  ])('refuses %s and keeps the click', async (_name, body, status) => {
    const { call, consumeUserGesture, open } = setup();
    expect(await call('POST', body)).toBe(status);
    expect(open).not.toHaveBeenCalled();
    expect(consumeUserGesture).not.toHaveBeenCalled();
  });

  it.each([
    ['another method', { method: 'GET' }, 405],
    ['a plugin that declares no engine', { harnesses: undefined }, 403],
    ['a plugin that is not installed', { harnesses: null }, 404],
    ['a page of a previous account or install', { current: false }, 403],
  ] as const)('refuses %s', async (_name, input, status) => {
    const { call, open } = setup('harnesses' in input ? { harnesses: input.harnesses } : {});
    expect(await call('method' in input ? input.method : 'POST', '{"id":"agy"}', 'current' in input ? input.current : true)).toBe(status);
    expect(open).not.toHaveBeenCalled();
  });

  it('reports that nothing was opened when no window can show the settings', async () => {
    const { call } = setup({ window: false });
    expect(await call('POST', '{"id":"agy"}')).toBe(503);
  });
});
