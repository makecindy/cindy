// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const scheduleFormDialogSource = readFileSync(
  new URL('../features/scheduler/components/ScheduleFormDialog.tsx', import.meta.url),
  'utf8',
);
const useScheduleFormSource = readFileSync(
  new URL('../features/scheduler/hooks/useScheduleForm.ts', import.meta.url),
  'utf8',
);
const packageJson = JSON.parse(
  readFileSync(
    new URL('../../../../../packages/maker-scheduler/package.json', import.meta.url),
    'utf8',
  ),
) as { exports: Record<string, string> };
const sessionTitleTemplateSource = readFileSync(
  new URL('../../../../../packages/maker-scheduler/src/session-title-template.ts', import.meta.url),
  'utf8',
);

describe('scheduler session title template renderer boundary', () => {
  it('exposes the pure template utilities through a renderer-safe package entry point', () => {
    expect(packageJson.exports['./session-title-template']).toBe('./src/session-title-template.ts');
    expect(sessionTitleTemplateSource).not.toMatch(/from ['"]node:/);
  });

  it.each([
    ['ScheduleFormDialog', scheduleFormDialogSource],
    ['useScheduleForm', useScheduleFormSource],
  ])(
    '%s imports template runtime values without loading the scheduler root barrel',
    (_name, source) => {
      expect(source).toContain("from '@cindy/maker-scheduler/session-title-template';");
      expect(source).toContain("from '@cindy/maker-scheduler/types';");
      expect(source).not.toContain("from '@cindy/maker-scheduler';");
    },
  );
});
