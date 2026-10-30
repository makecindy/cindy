import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

describe('mobile top-level back buttons', () => {
  it('uses one shared page-header back button treatment across top-level screens', () => {
    const primitives = readTextLf(resolve(process.cwd(), 'src/components/MobilePrimitives.tsx'), 'utf8');
    const session = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const newSession = readTextLf(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');
    const files = readTextLf(resolve(process.cwd(), 'app/files/[sessionId].tsx'), 'utf8');

    const backButtonStart = primitives.indexOf('backButton: {');
    const backButtonEnd = primitives.indexOf('backButtonCompact:', backButtonStart);
    const backButtonStyle = primitives.slice(backButtonStart, backButtonEnd);

    expect(primitives).toContain('export function ScreenBackButton');
    // 原档口径(8a3f43f9 考古):无底无边裸 chevron,44×44,marginLeft 贴边
    expect(backButtonStyle).not.toContain('backgroundColor');
    expect(backButtonStyle).not.toContain('borderColor');
    expect(backButtonStyle).not.toContain('borderWidth');
    expect(backButtonStyle).toContain('borderRadius: radius.pill');
    // 尺寸收拢为具名常量 BACK_BUTTON_SIZE,仍是 44×44。
    expect(primitives).toContain('const BACK_BUTTON_SIZE = 44;');
    expect(backButtonStyle).toContain('height: BACK_BUTTON_SIZE');
    expect(backButtonStyle).toContain('width: BACK_BUTTON_SIZE');
    expect(backButtonStyle).toContain('marginLeft: -spacing.sm');
    // chevron 与头部右侧 action 图标同档 20(用户定稿 2026-07-21,取代换肤期 md/medium)。
    expect(primitives).toContain('<ChevronLeft color={colors.textPrimary} size={iconSize.action} strokeWidth={iconStroke.regular} />');

    expect(session).toContain("import { ScreenBackButton } from '@/components/MobilePrimitives';");
    expect(session).toContain('testID="session.backButton"');
    expect(newSession).toContain("import { ScreenBackButton } from '@/components/MobilePrimitives';");
    expect(newSession).toContain('testID="newSession.backButton"');
    expect(files).toContain("import { ScreenBackButton } from '@/components/MobilePrimitives';");
    expect(files).toContain('testID="files.backButton"');

    expect(session).not.toContain('<ChevronLeft color={colors.textPrimary} size={iconSize.md}');
    expect(newSession).not.toContain('<ChevronLeft color={colors.textPrimary}');
    expect(files).not.toContain('<ChevronLeft color={colors.textPrimary}');
  });
});
