// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotGroupRuntimeFailureNotice } from '../BotGroupRuntimeFailureNotice';
import zhCN from '../../../i18n/locales/zh-CN/common.json';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, { name }: { name: string }) => {
  const code = key.split('.').at(-1)!;
  return zhCN.bots.groupChat.notice.runtimeFailure[code as keyof typeof zhCN.bots.groupChat.notice.runtimeFailure].replace('{{name}}', name);
} }) }));
afterEach(cleanup);

describe('group failure notice', () => {
  it('shows the image failure and the actual recovery settings', () => {
    render(<BotGroupRuntimeFailureNotice name="m" code="IMAGE_INPUT_UNSUPPORTED" />);
    expect(screen.getByText(/当前模型不支持图片/).textContent).toContain('设置 → 个性化 → 视觉桥');
    expect(screen.getByText(/当前模型不支持图片/).textContent).toContain('重新发送');
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
