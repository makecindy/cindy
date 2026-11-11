// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotGroupCapabilityNotice } from '../BotGroupCapabilityNotice';
import { BotGroupRuntimeFailureNotice } from '../BotGroupRuntimeFailureNotice';
import zhCN from '../../../i18n/locales/zh-CN/common.json';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, { name }: { name: string }) => {
  const code = key.split('.').at(-1)!;
  const values = key.includes('.capability.') ? zhCN.bots.groupChat.notice.capability
    : key.includes('.runtimeFailureReason.') ? zhCN.bots.groupChat.notice.runtimeFailureReason
    : zhCN.bots.groupChat.notice.runtimeFailure;
  return (values[code as keyof typeof values] as string).replace('{{name}}', name);
} }) }));
afterEach(cleanup);

describe('group failure notice', () => {
  it('explains an unclaimed attempt without claiming the computer is offline or suggesting another model', () => {
    const { container } = render(<BotGroupRuntimeFailureNotice name="A" code="RUNTIME_TIMEOUT" reason="unclaimed_timeout" />);
    expect(container.textContent).toContain('未能在等待期限内开始处理');
    expect(container.textContent).toContain('本次请求已结束');
    expect(container.textContent).toContain('伙伴的主人');
    expect(container.textContent).toContain('网络是否连接');
    expect(container.textContent).not.toMatch(/已离线|已关机|其他可用模型/);
  });
  it.each([undefined, 'future-reason'])('keeps the generic timeout for older or unknown reasons: %s', reason => {
    const { container } = render(<BotGroupRuntimeFailureNotice name="A" code="RUNTIME_TIMEOUT" reason={reason} />);
    expect(container.textContent).toContain('本次回复超时');
  });
  it('does not override another error with an inapplicable timeout reason', () => {
    const { container } = render(<BotGroupRuntimeFailureNotice name="A" code="AUTH_REQUIRED" reason="unclaimed_timeout" />);
    expect(container.textContent).toContain('重新认证');
  });
  it('shows the image failure and the actual recovery settings', () => {
    render(<BotGroupRuntimeFailureNotice name="m" code="IMAGE_INPUT_UNSUPPORTED" />);
    expect(screen.getByText(/当前模型不支持图片/).textContent).toContain('设置 → 个性化 → 视觉桥');
    expect(screen.getByText(/当前模型不支持图片/).textContent).toContain('重新发送');
  });
  // #6835: unit render entry must show the limit and recovery, not an unavailable notice.
  it.each([
    ['REMOTE_DEVICE_LIMIT', '设备'],
    ['REMOTE_TOTAL_LIMIT', '任务总数'],
  ])('explains %s with a recovery action', (code, reason) => {
    render(<BotGroupRuntimeFailureNotice name="Bot" code={code} />);
    const text = screen.getByText(/已达上限/).textContent;
    expect(text).toContain('Bot');
    expect(text).toContain(reason);
    expect(text).toContain('远程与分享');
  });
  it('does not render an unknown or private diagnostic as group content', () => {
    const { container } = render(<BotGroupRuntimeFailureNotice name="m" code="private-token-and-path" />);
    expect(container.textContent).toBe('');
  });
  it('explains upstream capacity and offers a retry without attributing it to request frequency', () => {
    render(<BotGroupRuntimeFailureNotice name="m" code="UPSTREAM_OVERLOADED" />);
    expect(screen.getByText(/模型服务暂时繁忙/).textContent).toContain('稍后重新发送');
    expect(screen.getByText(/模型服务暂时繁忙/).textContent).toContain('其他可用模型');
  });
});

// Unit: operation failures must be visible without claiming the whole reply failed.
describe('group operation capability notice', () => {
  it.each([
    ['GROUP_AUTHORIZATION_REQUIRED', '群内授权已失效'],
    ['GROUP_AUTHORIZATION_UNAVAILABLE', '暂时无法核验'],
    ['ATTACHMENTS_UNAVAILABLE', '部分附件未交给'],
  ])('shows the actual reason %s with a next action', (code, reason) => {
    const { container } = render(<BotGroupCapabilityNotice name="Writer" code={code} />);
    expect(container.textContent).toContain('Writer');
    expect(container.textContent).toContain(reason);
    expect(container.textContent).not.toContain('回复失败');
  });
  it('does not expose an unknown diagnostic', () => {
    const { container } = render(<BotGroupCapabilityNotice name="Writer" code="private diagnostic" />);
    expect(container.textContent).toBe('');
  });
});
