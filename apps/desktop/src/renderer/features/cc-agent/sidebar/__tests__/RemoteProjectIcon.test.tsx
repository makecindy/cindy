// @vitest-environment jsdom
// Unit: #11626 — 收件箱里来自离线电脑的任务会收起「稍后处理 / 完成」,
// 行上只剩一个变暗的设备图标。图标必须能说明原因(悬停可读、读屏可读),
// 而不是一个纯装饰的 aria-hidden svg。
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { RemoteProjectIcon } from '../RemoteProjectIcon';

// 组件自己读 i18n(与 SessionStatusIcon 的 AgentDeviceVendorIcon 同范式),这里只把
// 用到的 key 翻成英文原文:断言的仍是「哪句话被念出来」,不是 key 字符串。
const { MESSAGES } = vi.hoisted(() => ({
  MESSAGES: {
    'ccAgent.remoteSession.actionsUnavailable':
      'The remote device is unavailable. Reconnect it before changing this session.',
  } as Record<string, string>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => MESSAGES[key] ?? key,
    i18n: { language: 'en' },
  }),
}));

const LABEL = MESSAGES['ccAgent.remoteSession.actionsUnavailable'];

const mounted: { root: ReturnType<typeof createRoot>; element: HTMLElement }[] = [];

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div');
  const root = createRoot(element);
  mounted.push({ root, element });
  await act(async () => {
    root.render(node);
  });
  return element;
}

afterEach(async () => {
  for (const { root } of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
});

it('explains a blocked remote row through the device icon instead of staying decorative', async () => {
  const element = await mount(<RemoteProjectIcon kind="device-link" connectionStatus="disconnected" />);

  const wrapper = element.querySelector('[role="img"]');
  expect(wrapper?.getAttribute('aria-label')).toBe(LABEL);
  // 原生 title:悬停可见;行本身拿到键盘焦点时,读屏读到的也是这条说明。
  expect(wrapper?.getAttribute('title')).toBe(LABEL);
  // 图标仍是装饰元素,文案只出现一次。
  expect(wrapper?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(element.textContent).toBe('');
});

it('keeps the connecting state on the plain device glyph while still explaining itself', async () => {
  const element = await mount(<RemoteProjectIcon kind="device-link" connectionStatus="connecting" />);

  const wrapper = element.querySelector('[role="img"]');
  expect(wrapper?.getAttribute('aria-label')).toBe(LABEL);
  // 检测中不画 MonitorOff(那是「确认离线」):仍用普通设备图标,只压低一档。
  expect(wrapper?.querySelector('.lucide-monitor-smartphone')).not.toBeNull();
  expect(wrapper?.querySelector('.lucide-monitor-off')).toBeNull();
});

it('stays a plain decorative icon once the device is connected', async () => {
  const element = await mount(<RemoteProjectIcon kind="device-link" connectionStatus="connected" />);

  // 连上后收件箱操作自己回来了,不需要再解释:DOM 与改动前一致。
  expect(element.querySelector('[role="img"]')).toBeNull();
  expect(element.querySelector('.lucide-monitor-smartphone')?.getAttribute('aria-hidden')).toBe('true');
});

it('stays a plain decorative icon for ssh hosts, which are never write-blocked', async () => {
  const element = await mount(<RemoteProjectIcon kind="ssh" connectionStatus="disconnected" />);

  expect(element.querySelector('[role="img"]')).toBeNull();
  expect(element.querySelector('.lucide-globe')?.getAttribute('aria-hidden')).toBe('true');
});
