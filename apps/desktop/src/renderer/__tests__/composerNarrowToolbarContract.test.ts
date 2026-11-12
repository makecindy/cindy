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
    expect(chatInputSource).toContain('iconOnly={useUltraCompactToolbar}');
  });

  it('reserves fixed action space and makes permission/model chrome compact by container state', () => {
    expect(chatInputSource).toContain("'flex shrink-0 items-center gap-1'");
    expect(modelSelectorSource).toContain(
      'const isCompactToolbar = compactToolbar && !isFieldTrigger;',
    );
    expect(modelSelectorSource).not.toContain('w-[148px]');
    expect(modelSelectorSource).not.toContain('max-w-[108px]');
    expect(chatInputSource).toContain('<div className="min-w-0 flex-1" aria-hidden="true" />');
    expect(chatInputSource).toContain("allowToolbarWrap ? 'flex-[1_1_72px]' : 'shrink'");
    expect(modelSelectorSource).not.toContain('ultraCompactToolbar');
    expect(modelSelectorSource).toContain('effortLabel && !isCompactToolbar');
    expect(permissionSelectorSource).toContain(
      'const isIconOnly = iconOnly && !isFieldTrigger;',
    );
    expect(permissionSelectorSource).toContain(
      "'h-[30px] w-[34px] min-w-[34px] justify-center px-0'",
    );
    expect(permissionSelectorSource).toContain("isIconOnly ? 'min-w-[34px]' : 'min-w-[72px]'");
  });
});
