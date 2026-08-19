import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const rendererRoot = join(__dirname, '..');
const read = (relativePath: string) =>
  readFileSync(join(rendererRoot, 'components/new-chat', relativePath), 'utf8');

const chatInputSource = read('ChatInput.tsx');
const modelSelectorSource = read('ModelSelector.tsx');
const permissionSelectorSource = read('PermissionSelector.tsx');

describe('composer narrow toolbar contract', () => {
  it('uses measured card width for both default-session and create-agent composers', () => {
    expect(chatInputSource).toContain(
      'const useNarrowToolbar = narrowToolbar || (toolbarWidth != null && toolbarWidth < 600);',
    );
    expect(chatInputSource).not.toContain(
      'isCreateAgentVariant &&\n    (narrowToolbar || (toolbarWidth != null && toolbarWidth < 600))',
    );
    expect(chatInputSource).toContain('compactToolbar={useNarrowToolbar}');
    expect(chatInputSource).toContain('ultraCompactToolbar={useUltraCompactToolbar}');
    expect(chatInputSource).toContain('iconOnly={useUltraCompactToolbar}');
  });

  it('reserves fixed action space and makes permission/model chrome compact by container state', () => {
    expect(chatInputSource).toContain("'flex shrink-0 items-center gap-1'");
    expect(modelSelectorSource).toContain(
      'const isCompactToolbar = compactToolbar && !isFieldTrigger;',
    );
    expect(modelSelectorSource).toContain("'w-[148px] min-w-[72px]'");
    expect(modelSelectorSource).toContain("'w-[64px] min-w-[64px]'");
    // 2026-08-12 Chris 裁决(bug7):composer pill 换成「模型名 + 引擎小标 + 深度」后,
    // 窄工具条下**先截模型名**,小标与档字保留 —— 它们是定宽身份位,截掉等于把
    // 「现在用哪个引擎、多深」藏起来。只有 ultra-compact(整段文字都收起、只剩图标)
    // 才一并隐藏。没有引擎小标的旧形态(其余 7 个入口)维持原来的 compact 即隐藏。
    expect(modelSelectorSource).toContain(
      'const showTriggerTail = engineMarkOption ? !isUltraCompactToolbar : !isCompactToolbar;',
    );
    expect(modelSelectorSource).toContain('{effortLabel && showTriggerTail && (');
    expect(permissionSelectorSource).toContain(
      'const isIconOnly = iconOnly && !isFieldTrigger;',
    );
    expect(permissionSelectorSource).toContain(
      "'h-[30px] w-[34px] min-w-[34px] justify-center px-0'",
    );
  });
});
