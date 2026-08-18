import { describe, expect, it, vi } from 'vitest';

import {
  renderSessionTitleTemplate,
  SESSION_TITLE_MAX_CODE_POINTS,
  SESSION_TITLE_TEMPLATE_MAX_CODE_POINTS,
  SESSION_TITLE_TEMPLATE_TOKENS,
  sessionTitleProjectName,
  validateSessionTitleTemplate,
} from '../session-title-template.js';

const context = {
  scheduleName: 'Morning review',
  timezone: 'Asia/Shanghai',
  scheduledFor: Date.UTC(2025, 11, 31, 16, 5),
  source: 'automatic' as const,
  workspaceKind: 'project' as const,
  workingDir: 'C:\\work\\project-alpha',
  runId: 'abcdefgh-1234',
  locale: 'en-US',
};

describe('session title templates', () => {
  it('exports exactly the same token whitelist accepted by validation', () => {
    for (const { token } of SESSION_TITLE_TEMPLATE_TOKENS) {
      expect(validateSessionTitleTemplate(token)).toEqual({
        valid: true,
        template: token,
      });
    }
  });

  it('renders every token in the schedule timezone and the planned ISO week-year', () => {
    const expected = new Map<string, string>([
      ['{scheduleName}', 'Morning review'],
      ['{date}', '2026-01-01'],
      ['{date:yyyy-MM-dd}', '2026-01-01'],
      ['{date:yyyyMMdd}', '20260101'],
      ['{date:yyyy年MM月dd日}', '2026年01月01日'],
      ['{date:MM-dd}', '01-01'],
      ['{date:MM月dd日}', '01月01日'],
      ['{time}', '00:05'],
      ['{time:HH:mm}', '00:05'],
      ['{time:HHmm}', '0005'],
      ['{weekday}', 'Thu'],
      ['{isoWeek}', '2026-W01'],
      ['{month}', '2026-01'],
      ['{quarter}', '2026-Q1'],
      ['{trigger}', 'scheduled'],
      ['{projectName}', 'project-alpha'],
      ['{runId:short}', 'abcdefgh'],
    ]);
    for (const [token, value] of expected) {
      expect(renderSessionTitleTemplate(token, context)).toBe(value);
    }
  });

  it('normalizes Intl midnight hour 24 to 00', () => {
    const formatToParts = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
      .mockReturnValue([
        { type: 'year', value: '2026' },
        { type: 'month', value: '01' },
        { type: 'day', value: '01' },
        { type: 'hour', value: '24' },
        { type: 'minute', value: '05' },
        { type: 'second', value: '00' },
      ]);

    try {
      expect(renderSessionTitleTemplate('{time:HH:mm}', context)).toBe('00:05');
    } finally {
      formatToParts.mockRestore();
    }
  });

  it('renders run-now as manual and dialogue as a stable project name', () => {
    expect(
      renderSessionTitleTemplate('{trigger} {projectName}', {
        ...context,
        source: 'run-now',
        workspaceKind: 'dialogue',
        workingDir: undefined,
      }),
    ).toBe('manual dialogue');
  });

  it('handles Windows, macOS/POSIX, and trailing path separators', () => {
    expect(sessionTitleProjectName('project', 'C:\\work\\alpha\\')).toBe('alpha');
    expect(sessionTitleProjectName('project', '/Users/me/beta/')).toBe('beta');
    expect(sessionTitleProjectName('dialogue', '/ignored/worktree-123')).toBe('dialogue');
  });

  it('escapes literal braces and rejects malformed or unknown syntax', () => {
    expect(renderSessionTitleTemplate('{{{scheduleName}}}', context)).toBe('{Morning review}');
    expect(validateSessionTitleTemplate('{scheduleName')).toMatchObject({
      valid: false,
      error: { code: 'unclosed-token' },
    });
    expect(validateSessionTitleTemplate('scheduleName}')).toMatchObject({
      valid: false,
      error: { code: 'unexpected-brace' },
    });
    expect(validateSessionTitleTemplate('{date:dd/MM/yyyy}')).toMatchObject({
      valid: false,
      error: { code: 'unknown-token', token: 'date:dd/MM/yyyy' },
    });
    expect(validateSessionTitleTemplate('{unknown}')).toMatchObject({
      valid: false,
      error: { code: 'unknown-token', token: 'unknown' },
    });
  });

  it('counts and truncates Unicode code points without splitting surrogate pairs', () => {
    const atLimit = '😀'.repeat(SESSION_TITLE_TEMPLATE_MAX_CODE_POINTS);
    expect(validateSessionTitleTemplate(atLimit).valid).toBe(true);
    expect(validateSessionTitleTemplate(`${atLimit}😀`)).toMatchObject({
      valid: false,
      error: { code: 'too-long' },
    });
    const rendered = renderSessionTitleTemplate(atLimit, context);
    expect(Array.from(rendered)).toHaveLength(SESSION_TITLE_MAX_CODE_POINTS);
    expect(rendered).toBe(`${'😀'.repeat(SESSION_TITLE_MAX_CODE_POINTS - 1)}…`);
  });

  it('trims stored and rendered values, and treats whitespace-only as clear', () => {
    expect(validateSessionTitleTemplate('  {scheduleName}  ')).toEqual({
      valid: true,
      template: '{scheduleName}',
    });
    expect(validateSessionTitleTemplate('   ')).toEqual({
      valid: true,
      template: undefined,
    });
    expect(renderSessionTitleTemplate('  {scheduleName}  ', context)).toBe('Morning review');
  });
});
