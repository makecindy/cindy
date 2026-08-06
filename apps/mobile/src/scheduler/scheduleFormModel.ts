import type { MobileScheduleModelDefaults } from '@cindy/maker-shared/schedule-form';

export * from '@cindy/maker-shared/schedule-form';

/** Mobile is only a controller: blank defaults let the controlled Desktop resolve its active catalog. */
export const MOBILE_SCHEDULE_MODEL_DEFAULTS: MobileScheduleModelDefaults = {
  'claude-code': '',
  codex: '',
};
