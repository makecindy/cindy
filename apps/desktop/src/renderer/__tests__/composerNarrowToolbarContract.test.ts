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
    expect(modelSelectorSource).toContain('triggerPromotionLabel && !isCompactToolbar');
    expect(modelSelectorSource).toContain('effortLabel && !isCompactToolbar');
    expect(permissionSelectorSource).toContain(
      'const isIconOnly = iconOnly && !isFieldTrigger;',
    );
    expect(permissionSelectorSource).toContain(
      "'h-[30px] w-[34px] min-w-[34px] justify-center px-0'",
    );
  });
});
