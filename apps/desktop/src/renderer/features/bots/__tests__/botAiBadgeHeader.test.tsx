// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BotSessionContentHeader } from '../BotSessionContentHeader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/bots/b1', search: '' }),
}));
vi.mock('../feature-context', () => ({
  useRegisterContentHeader: () => undefined,
}));
vi.mock('@/features/right-sidebar/lib/openBotWorkbenchTab', () => ({
  openBotWorkbenchTab: vi.fn(),
}));
vi.mock('./BotAvatar', async (importOriginal) => {
  void importOriginal;
  return {
    BotAvatar: () => <span data-testid="bot-avatar" />,
  };
});
vi.mock('./CindyDevicePicker', () => ({
  CindyHeaderDevicePicker: () => null,
}));

describe('BotSessionContentHeader', () => {
  afterEach(cleanup);

  it('keeps a persistent AI badge next to the companion identity', () => {
    render(<BotSessionContentHeader bot={{ id: 'b1', name: 'Cindy', sessionId: 's1' }} />);
    // 标识固定在内容头:不随消息滚动消失,也不依赖皮肤或任务状态。
    expect(screen.getByTestId('bot-ai-badge')).toBeTruthy();
    expect(screen.getByTestId('bot-session-content-header').textContent).toContain(
      'bots.aiBadge.label',
    );
  });
});
