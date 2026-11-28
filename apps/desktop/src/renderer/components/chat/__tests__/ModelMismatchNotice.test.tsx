// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：渲染真实 `ModelMismatchNotice` 组件，验证有外部供应商名时点名展示、
 *   缺省时回退通用「模型供应商」文案，且点击「了解原因」后展开说明浮层（成因 + 处理方式）。
 * - Bug／规则依据：产品要求区分具体供应商与通用保底，并提供内联 info 说明避免误会 Cindy 改派模型。
 * - 现有覆盖缺口：此前 AssistantMessage 的模型改派提示没有独立组件测试，也未覆盖供应商点名与浮层交互。
 * - 最小失败输入：传入 `{ selected: 'claude-fable-5-2', actual: 'claude-opus-4-8', providerName: 'Anthropic' }`
 *   与无 `providerName` 两种输入，点击触发按钮检查 Popover 内容。
 * - tier：unit（jsdom，纯组件与本地 i18n，无 I/O）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { ModelMismatchNotice } from '../ModelMismatchNotice';

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('ModelMismatchNotice', () => {
  it('点名已知外部供应商，点击了解原因后展示成因与处理说明', async () => {
    await i18n.changeLanguage('zh-CN');
    render(
      <ModelMismatchNotice
        mismatch={{
          selected: 'claude-fable-5-2',
          actual: 'claude-opus-4-8',
          providerName: 'Anthropic',
        }}
      />,
    );

    expect(
      screen.getByText('Anthropic 将本轮改由 Opus 4.8 响应（原选 Fable 5.2）'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '了解原因' }));

    expect(screen.getByText('为什么实际响应的模型不同')).toBeTruthy();
    expect(
      screen.getByText('Cindy 已按你选择的 Fable 5.2 发送本轮请求，但 Anthropic 实际由 Opus 4.8 返回了结果。'),
    ).toBeTruthy();
    expect(
      screen.getByText('无需重新设置：这只影响本轮，后续消息仍会继续请求 Fable 5.2。'),
    ).toBeTruthy();
  });

  it('未提供供应商名时回退通用模型供应商文案', async () => {
    await i18n.changeLanguage('en');
    render(
      <ModelMismatchNotice
        mismatch={{
          selected: 'claude-fable-5-2',
          actual: 'claude-opus-4-8',
        }}
      />,
    );

    expect(
      screen.getByText('The model provider answered this turn with Opus 4.8 instead of Fable 5.2'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Why this happened' }));

    expect(screen.getByText('Why a different model answered')).toBeTruthy();
    expect(
      screen.getByText(
        'Cindy sent this turn to Fable 5.2 as you selected, and the model provider returned the reply using Opus 4.8.',
      ),
    ).toBeTruthy();
  });
});
