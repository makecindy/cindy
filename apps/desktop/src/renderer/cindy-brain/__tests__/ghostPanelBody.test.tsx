// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:GhostWebviewBody(右侧栏插件页签 / 插件页面板共用的 webview 内核)
 *   的挂载与卸载;可观察的是真实 renderer logger 转给 main 的日志行(logToMain)——每次
 *   webview 创建、销毁各一条,销毁行带原因类别 unmount / reload / crash。
 * - Bug / 规则依据:makecindy/cindy#8080 SC5——全局页签被重建时 main.log 里要能看出为什么;
 *   日志只含插件实例 id、存活毫秒和原因,不含 URL 查询串(任务页带 session=<id>)与页面内容。
 * - 现有覆盖缺口:面板 webview 的创建 / 销毁此前不写任何日志。
 * - 最小失败输入:挂载带 query 的面板,再换入口 html、触发 render-process-gone、最后卸载。
 * - tier:unit(jsdom,webview 是普通未知元素,只在 electronAPI.logToMain 边界断言)。
 */

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import { GhostWebviewBody } from '../ghostPanelBody';

const ghost = {
  manifest: { schemaVersion: 2, id: 'canvas', name: 'canvas', version: '1.0.0', kind: 'chip', entry: 'main.js' } as GhostManifest,
  dir: '/fake/canvas',
  enabled: true,
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
} as InstalledGhost;
const instanceId = installedGhostStoragePart(ghost);

let lines: Array<{ level: string; scope: string; message: string }>;

const webviewLogs = () =>
  lines
    .filter((line) => line.scope === 'GhostWebview')
    .map((line) => ({
      text: line.message.slice(0, line.message.indexOf(' {')),
      fields: JSON.parse(line.message.slice(line.message.indexOf(' {') + 1)) as Record<string, unknown>,
    }));

const body = (html: string) =>
  createElement(GhostWebviewBody, { ghost, html, query: 'session=secret-session-id' });

beforeEach(() => {
  lines = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    logToMain: (level: string, scope: string, message: string) => lines.push({ level, scope, message }),
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('GhostWebviewBody 创建 / 销毁日志', () => {
  it('writes one created and one destroyed line per webview, tagged with the close category', () => {
    const view = render(body('main-view.html'));
    expect(webviewLogs().map((entry) => entry.text)).toEqual(['webview created']);
    expect(webviewLogs()[0]?.fields).toEqual({ instanceId });

    // 入口页面变了 → effect 依赖变化,旧 webview 销毁后新建:reload。
    view.rerender(body('other-view.html'));
    // guest 进程崩溃 → 进入错误接管态,webview 销毁:crash。
    act(() => {
      const webview = view.container.querySelector('webview');
      webview?.dispatchEvent(new Event('render-process-gone'));
    });
    // 错误接管态里没有 webview,卸载不再写销毁行。
    view.unmount();

    const second = render(body('main-view.html'));
    second.unmount();

    const entries = webviewLogs();
    expect(entries.map((entry) => `${entry.text}${entry.fields.reason ? `:${entry.fields.reason}` : ''}`)).toEqual([
      'webview created',
      'webview destroyed:reload',
      'webview created',
      'webview destroyed:crash',
      'webview created',
      'webview destroyed:unmount',
    ]);
    for (const entry of entries) {
      expect(entry.fields.instanceId).toBe(instanceId);
      expect(Object.keys(entry.fields).sort()).toEqual(
        entry.text === 'webview created' ? ['instanceId'] : ['aliveMs', 'instanceId', 'reason'],
      );
      if (entry.text === 'webview destroyed') {
        expect(Number.isInteger(entry.fields.aliveMs) && (entry.fields.aliveMs as number) >= 0).toBe(true);
      }
    }
    // 查询串(任务页带的 session=<id>)与页面入口路径都不进日志。
    const raw = lines.map((line) => line.message).join('\n');
    expect(raw).not.toContain('secret-session-id');
    expect(raw).not.toContain('session=');
    expect(raw).not.toContain('.html');
  });
});
