// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { PendingAskUser } from '@/lib/makerChatStore';
import { AskUserQuestionPrompt } from '../components/new-chat/AskUserQuestionPrompt';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
});

function renderAskUser(pending: PendingAskUser, onAnswer = vi.fn()) {
  const view = render(
    createElement(AskUserQuestionPrompt, {
      sessionId: 'ask-other',
      pending,
      onAnswer,
      viewerState: 'expanded',
      onViewerStateChange: () => {},
      draft: null,
      onDraftChange: () => {},
    }),
  );
  return { view, onAnswer };
}

describe('AskUserQuestionPrompt model-authored "Other" options', () => {
  it('replaces the "其他（回复说明）" option with the host free-text entry', () => {
    const { view, onAnswer } = renderAskUser({
      requestId: 'req-other',
      questions: [
        {
          question: 'Which approach?',
          options: [{ label: 'Approach A' }, { label: '其他（回复说明）' }],
        },
      ],
    });

    // The model-authored entry and the host's own entry mean the same thing,
    // so the option disappears and the host row is the single way to type.
    expect(view.queryByText('其他（回复说明）')).toBeNull();
    expect(view.getAllByText('Type something else…')).toHaveLength(1);
    // The escape entry must stay outside the scroll region: a long option list
    // previously pushed it below the fold, so the card showed no input at all.
    const scrollRegion = view.getByTestId('interaction-prompt-scroll-region');
    expect(within(scrollRegion).queryByText('Type something else…')).toBeNull();

    fireEvent.click(view.getByText('Type something else…'));
    const input = view.getByPlaceholderText('Type your answer…') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Use approach C first' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onAnswer).toHaveBeenCalledWith('req-other', {
      'Which approach?': 'Use approach C first',
    });
  });

  it('keeps the normal options around the replaced entry', () => {
    const { view, onAnswer } = renderAskUser({
      requestId: 'req-other-middle',
      questions: [
        {
          question: 'Which approach?',
          options: [
            { label: 'Approach A' },
            { label: '其他（回复说明）' },
            { label: 'Approach B' },
          ],
        },
      ],
    });

    expect(view.queryByText('其他（回复说明）')).toBeNull();
    expect(view.getByText('Approach A')).not.toBeNull();
    expect(view.getByText('Approach B')).not.toBeNull();
    expect(view.getAllByText('Type something else…')).toHaveLength(1);

    fireEvent.click(view.getByText('Approach A'));
    expect(onAnswer).toHaveBeenCalledWith('req-other-middle', {
      'Which approach?': 'Approach A',
    });
  });

  it('dedupes several "Other" entries into the single host entry', () => {
    const { view, onAnswer } = renderAskUser({
      requestId: 'req-two-others',
      questions: [
        {
          question: 'Which approach?',
          options: [
            { label: 'Approach A' },
            { label: '其他（回复说明）' },
            { label: 'Other (please specify)' },
          ],
        },
      ],
    });

    expect(view.queryByText('其他（回复说明）')).toBeNull();
    expect(view.queryByText('Other (please specify)')).toBeNull();
    expect(view.getAllByText('Type something else…')).toHaveLength(1);

    // The freed number key still opens the host entry.
    fireEvent.keyDown(window, { key: '2' });
    expect(onAnswer).not.toHaveBeenCalled();
    expect(view.getByPlaceholderText('Type your answer…')).not.toBeNull();
  });

  it('shows the free-text input directly when every option is an "Other" entry', () => {
    const { view, onAnswer } = renderAskUser({
      requestId: 'req-only-others',
      questions: [
        {
          question: 'Which approach?',
          options: [{ label: '其他（回复说明）' }, { label: 'Other (please specify)' }],
        },
      ],
    });

    // Nothing is left to choose: the replaced entries collapse into the input.
    expect(view.queryByText('其他（回复说明）')).toBeNull();
    expect(view.queryByText('Other (please specify)')).toBeNull();
    expect(view.queryByText('Type something else…')).toBeNull();

    const input = view.getByPlaceholderText('Type your answer…') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Something specific' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onAnswer).toHaveBeenCalledWith('req-only-others', {
      'Which approach?': 'Something specific',
    });
  });

  it('keeps a substantive option that merely mentions explaining, and pins the escape entry', () => {
    const { view } = renderAskUser({
      requestId: 'req-real-card',
      questions: [
        {
          question: '三件事怎么定？',
          options: [
            { label: '三件全通过（N 台账追认 + sensor_height 照原值 + 三文档定案）' },
            { label: 'N 台账我先逐条看，其余先过' },
            { label: 'sensor_height 要改（回复说明数值）' },
            { label: '先不定案，先开批次 3' },
            { label: '其他（回复说明）' },
          ],
        },
      ],
    });

    // 实质选项（哪怕提到「回复说明」）保持可选；只有「其他」入口被替换。
    expect(view.getByText('sensor_height 要改（回复说明数值）')).not.toBeNull();
    expect(view.queryByText('其他（回复说明）')).toBeNull();
    expect(view.getAllByText('Type something else…')).toHaveLength(1);
    const scrollRegion = view.getByTestId('interaction-prompt-scroll-region');
    expect(scrollRegion.contains(view.getByText('Type something else…'))).toBe(false);
  });

  it('keeps the JSON array encoding for a multi-select question whose options were all replaced', () => {
    const { view, onAnswer } = renderAskUser({
      requestId: 'req-only-others-multi',
      questions: [
        {
          question: 'Which approaches?',
          multiSelect: true,
          options: [{ label: '其他（回复说明）' }, { label: 'Other (please specify)' }],
        },
      ],
    });

    const input = view.getByPlaceholderText('Type your answer…') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Approach C' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 多选题必须继续使用 JSON 数组编码，否则返回编辑时恢复逻辑解析不到答案。
    expect(onAnswer).toHaveBeenCalledWith('req-only-others-multi', {
      'Which approaches?': JSON.stringify(['Approach C']),
    });
  });

  it('keeps ordinary labels on the click-to-submit path', () => {
    const { view, onAnswer } = renderAskUser({
      requestId: 'req-normal',
      questions: [
        {
          question: 'Which approach?',
          options: [{ label: 'Approach A' }, { label: '其他任务' }],
        },
      ],
    });

    fireEvent.click(view.getByText('其他任务'));

    expect(onAnswer).toHaveBeenCalledWith('req-normal', {
      'Which approach?': '其他任务',
    });
  });

  it('adds the typed explanation as the custom part of a multi-select answer', () => {
    const { view, onAnswer } = renderAskUser({
      requestId: 'req-other-multi',
      questions: [
        {
          question: 'Which approaches?',
          multiSelect: true,
          options: [{ label: 'Approach A' }, { label: '其他（回复说明）' }],
        },
      ],
    });

    expect(view.queryByText('其他（回复说明）')).toBeNull();
    fireEvent.click(view.getByText('Approach A'));
    fireEvent.click(view.getByText('Type something else…'));
    fireEvent.change(view.getByPlaceholderText('Type your answer…'), {
      target: { value: 'Approach C' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Submit' }));

    expect(onAnswer).toHaveBeenCalledWith('req-other-multi', {
      'Which approaches?': JSON.stringify(['Approach A', 'Approach C']),
    });
  });
});
