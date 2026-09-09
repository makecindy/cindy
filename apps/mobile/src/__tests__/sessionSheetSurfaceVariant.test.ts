import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

describe('mobile session sheet styling variants', () => {
  it('scopes M3 tasksheet styling to the session task sheet only', () => {
    const sheetSurface = readTextLf(resolve(process.cwd(), 'src/session/SheetSurface.tsx'), 'utf8');
    const sessionMenu = readTextLf(resolve(process.cwd(), 'src/session/SessionMenuSheet.tsx'), 'utf8');
    const contextSheet = readTextLf(resolve(process.cwd(), 'src/session/ContextSheet.tsx'), 'utf8');
    const modelPicker = readTextLf(resolve(process.cwd(), 'src/session/ModelPickerSheet.tsx'), 'utf8');
    const actionSheet = readTextLf(resolve(process.cwd(), 'src/session/SessionActionSheet.tsx'), 'utf8');

    expect(sheetSurface).toContain("export type SheetSurfaceVariant = 'default' | 'tasksheet';");
    expect(sheetSurface).toContain('variant?: SheetSurfaceVariant;');
    expect(sheetSurface).toContain("variant = 'default'");
    expect(sheetSurface).toContain("variant === 'tasksheet' && styles.sheetTasksheet");
    expect(sheetSurface).toContain('<BlurBackdrop');
    expect(sheetSurface).toContain('overlayColor={variant === \'tasksheet\' ? colors.sheetSurface : colors.surfaceGlassPanel}');
    expect(sheetSurface).toContain("backgroundColor: 'transparent'");
    expect(sheetSurface).toContain('backgroundColor: colors.sheetGrabber');

    const primarySheetStart = sessionMenu.indexOf('testID="session.menuSheet"');
    const primarySheetEnd = sessionMenu.indexOf('>', primarySheetStart);
    const primarySheetSource = sessionMenu.slice(primarySheetStart, primarySheetEnd);
    expect(primarySheetSource).toContain('variant="tasksheet"');

    const infoSheetStart = sessionMenu.indexOf('testID="session.infoSheet"');
    const infoSheetEnd = sessionMenu.indexOf('>', infoSheetStart);
    const infoSheetSource = sessionMenu.slice(infoSheetStart, infoSheetEnd);
    expect(infoSheetSource).not.toContain('variant="tasksheet"');
    expect(contextSheet).not.toContain('variant="tasksheet"');
    expect(modelPicker).not.toContain('variant="tasksheet"');

    expect(sessionMenu).toContain('backgroundColor: colors.sheetActionSurface');
    expect(sessionMenu).toContain('borderColor: colors.sheetActionBorder');
    expect(sessionMenu).toContain('color: colors.sheetActionText');
    expect(sessionMenu).toContain('color: colors.destructive');
    expect(actionSheet).toContain('colors.sheetActionSurface');
    expect(actionSheet).toContain('colors.sheetActionBorder');
    expect(actionSheet).toContain('colors.destructive');
    expect(actionSheet).not.toContain('colors.statusError');
    expect(actionSheet).toContain('intensity={32}');
    expect(actionSheet).toContain('overlayColor={colors.sheetActionSurface}');
  });

  it('keeps the session menu status chips left aligned inside the sheet body', () => {
    const sessionMenu = readTextLf(resolve(process.cwd(), 'src/session/SessionMenuSheet.tsx'), 'utf8');
    const headerBlockStart = sessionMenu.indexOf('headerBlock: {');
    const headerBlockEnd = sessionMenu.indexOf('chipRow: {', headerBlockStart);
    const headerBlockSource = sessionMenu.slice(headerBlockStart, headerBlockEnd);
    const chipRowStart = sessionMenu.indexOf('chipRow: {');
    const chipRowEnd = sessionMenu.indexOf('chip: {', chipRowStart);
    const chipRowSource = sessionMenu.slice(chipRowStart, chipRowEnd);

    expect(headerBlockSource).toContain("alignSelf: 'stretch'");
    expect(chipRowSource).toContain("alignSelf: 'stretch'");
    expect(chipRowSource).toContain("justifyContent: 'flex-start'");
  });
});
