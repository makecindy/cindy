// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

import { BotGrowthNote } from '../BotGrowthNote';

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

describe('BotGrowthNote — 气泡末尾的成长注脚', () => {
  it('单条记忆显示标题', () => {
    render(
      <BotGrowthNote botId="bot-1" note={{ count: 1, title: '结论在前', target: 'memory' }} />,
    );
    expect(screen.getByText('bots.growth.rememberedOne:{"title":"结论在前"}')).toBeTruthy();
  });

  it('多条合并成计数,不逐条铺开', () => {
    render(<BotGrowthNote botId="bot-1" note={{ count: 2, title: null, target: 'memory' }} />);
    expect(screen.getByText('bots.growth.rememberedMany:{"count":2}')).toBeTruthy();
  });

  it('本事走「学会了」那套文案', () => {
    render(
      <BotGrowthNote botId="bot-1" note={{ count: 1, title: '缩成三行', target: 'learned' }} />,
    );
    expect(screen.getByText('bots.growth.learnedOne:{"title":"缩成三行"}')).toBeTruthy();
  });

  it('点它跳到该伙伴设置页并高亮对应列表', () => {
    render(<BotGrowthNote botId="bot-7" note={{ count: 1, title: 'A', target: 'learned' }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(navigate).toHaveBeenCalledWith('/bots/bot-7?settings=1&anchor=who&highlight=learned');
  });

  it('记忆尾注跳「TA 记得的」', () => {
    render(<BotGrowthNote botId="bot-7" note={{ count: 3, title: null, target: 'memory' }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(navigate).toHaveBeenCalledWith('/bots/bot-7?settings=1&anchor=who&highlight=memory');
  });

  it('保持"淡淡的":三级文字色 + 极淡分隔线,hover 才提亮,不加背景不加阴影', () => {
    render(<BotGrowthNote botId="bot-1" note={{ count: 1, title: 'A', target: 'memory' }} />);
    const className = screen.getByRole('button').className;
    expect(className).toContain('text-[var(--text-tertiary)]');
    expect(className).toContain('hover:text-[var(--text-secondary)]');
    expect(className).toContain('border-t');
    expect(className).not.toMatch(/(?:^|\s)bg-/);
    expect(className).not.toMatch(/shadow/);
  });
});
