import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetPromptRecommendationPreferenceForTests,
  getPromptRecommendationPreference,
  subscribePromptRecommendationPreference,
  syncPromptRecommendationPreferenceFromStorageValue,
} from '../usePromptRecommendationPreference';

beforeEach(() => {
  _resetPromptRecommendationPreferenceForTests();
});

describe('prompt recommendation preference runtime sync', () => {
  it('storage push 会先更新模块级真值，首次 ChatInput render 不会读到旧值', () => {
    syncPromptRecommendationPreferenceFromStorageValue('true');
    expect(getPromptRecommendationPreference()).toBe(true);

    syncPromptRecommendationPreferenceFromStorageValue('false');
    expect(getPromptRecommendationPreference()).toBe(false);
  });

  it('通知运行期 Store 清理已缓存的推荐', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePromptRecommendationPreference(listener);

    syncPromptRecommendationPreferenceFromStorageValue('false');

    expect(listener).toHaveBeenCalledWith(false);
    unsubscribe();
  });
});
