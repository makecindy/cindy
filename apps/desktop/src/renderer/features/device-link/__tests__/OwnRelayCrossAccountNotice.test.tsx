// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:`OwnRelayCrossAccountNotice` 渲染出的说明文字。
 * - Bug/规则依据:docs/self-hosted-relay-plan.md §7、§15.5:用自己的中转时入口必须说明内容仍经官方中转,
 *   官方线路下不能多出这句话。
 * - 现有覆盖缺口:新增组件;共享任务与供应商分享的弹窗测试都不提供中转状态。
 * - 最小失败输入:线路状态为 self-hosted、线路在弹窗打开期间切回官方。
 * - tier:unit,jsdom,preload 接口为进程内 fake。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { OwnRelayCrossAccountNotice } from '../OwnRelayCrossAccountNotice';

function withRelayMode(mode: 'official' | 'self-hosted') {
  let changed: (state: { mode: string }) => void = () => {};
  Object.assign(window, { electronAPI: { selfHostedRelay: {
    command: vi.fn(async () => ({ state: { mode } })),
    onChanged: (cb: typeof changed) => { changed = cb; return () => {}; },
  } } });
  return { switchTo: (next: string) => act(async () => changed({ mode: next })) };
}

describe('OwnRelayCrossAccountNotice', () => {
  afterEach(() => cleanup());

  it('stays silent on the official route', async () => {
    withRelayMode('official');
    await act(async () => { render(<OwnRelayCrossAccountNotice feature="sharedTask" />); });
    expect(screen.queryByText('sharedTask.officialRelayNote')).toBeNull();
  });

  it('names the feature while the own relay is in use and follows a route change', async () => {
    const relay = withRelayMode('self-hosted');
    await act(async () => { render(<OwnRelayCrossAccountNotice feature="providerShare" />); });
    expect(screen.getByText('providerShare.officialRelayNote')).toBeTruthy();
    await relay.switchTo('official');
    expect(screen.queryByText('providerShare.officialRelayNote')).toBeNull();
  });
});
