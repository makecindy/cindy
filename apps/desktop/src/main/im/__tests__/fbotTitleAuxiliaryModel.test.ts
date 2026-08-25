import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  generatedTitle: null as string | null,
  selection: null as null | { pin: string },
  onGenerate: null as null | (() => void),
  requestUtilityText: vi.fn(),
}));

vi.mock('../../maker-host/session-storage.js', () => ({
  desktopSessionStorage: { update: vi.fn() },
}));

vi.mock('../../maker-ipc/title.js', () => ({
  generateMakerSessionTitle: vi.fn(async () => {
    h.onGenerate?.();
    return h.generatedTitle;
  }),
}));

vi.mock('../../utility-model/auxiliary-model-settings-store.js', () => ({
  readAuxiliaryModelSelection: () => h.selection,
}));

vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  requestUtilityText: (...args: unknown[]) => h.requestUtilityText(...args),
}));

vi.mock('../../maker-host/index.js', () => ({
  getMaker: () => ({}),
}));

vi.mock('../shared/sessionBroadcast.js', () => ({
  broadcastSessionPatched: vi.fn(),
}));

import { generateImSessionTitleText } from '../shared/fbotTitle.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.generatedTitle = null;
  h.selection = null;
  h.onGenerate = null;
  h.requestUtilityText.mockResolvedValue({
    ok: true,
    text: '旧 utility 兜底标题',
    providerId: 'xd',
    model: 'fallback',
    transport: 'litellm-chat-completions',
  });
});

describe('IM task title auxiliary model boundary', () => {
  it('keeps the historical utility fallback in automatic mode', async () => {
    await expect(generateImSessionTitleText('task-1', '第一条消息')).resolves.toBe(
      '旧 utility 兜底标题',
    );
    expect(h.requestUtilityText).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an explicit global title model was selected', async () => {
    h.selection = { pin: 'cat:openrouter:codex:openai/gpt-5-mini' };

    await expect(generateImSessionTitleText('task-1', '第一条消息')).resolves.toBeNull();
    expect(h.requestUtilityText).not.toHaveBeenCalled();
  });

  it('preserves the initially selected exact route when settings change in flight', async () => {
    h.selection = { pin: 'cat:openrouter:codex:openai/gpt-5-mini' };
    h.onGenerate = () => {
      h.selection = null;
    };

    await expect(generateImSessionTitleText('task-1', '第一条消息')).resolves.toBeNull();
    expect(h.requestUtilityText).not.toHaveBeenCalled();
  });
});
