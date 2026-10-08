import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 「恢复默认」入口的接线约束。行为链路(提交 null 删 override)由
 * `useVoiceInputSettings.overrideReset.test.ts` 与 main 侧
 * `composerLongPressSetting.test.ts`(「传 null 恢复默认」)覆盖;这里锁住
 * VoiceInputSection 的行级接线,防止入口被静默摘掉又只剩布尔开关。
 */
describe('VoiceInputSection restore default entries', () => {
  it('shows restore controls only for override-backed switches and restores via null submitters', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    // 长按输入框开关:override 存在时才出现「已自定义/恢复默认」,恢复走提交 null 的动作。
    expect(source).toContain('isCustomized={settings.composerLongPressEnabledOverride != null}');
    expect(source).toContain('void resetComposerLongPressEnabled()');
    // 词典同步开关与长按开关同一套 override 约定,入口必须成对存在。
    expect(source).toContain('isCustomized={settings.dictionarySyncEnabledOverride != null}');
    expect(source).toContain('void resetDictionarySyncEnabled()');
  });

  it('restore helpers submit null instead of writing a static default snapshot', () => {
    const source = readFileSync(
      new URL('../../hooks/useVoiceInputSettings.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('runOverrideReset({ composerLongPressEnabled: null })');
    expect(source).toContain('runOverrideReset({ dictionarySyncEnabled: null })');
  });
});
