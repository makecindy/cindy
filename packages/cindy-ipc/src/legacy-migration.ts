export const LEGACY_MIGRATION_CHANNELS = {
  CONFIRM: "legacy-migration:confirm",
  GET_STATE: "legacy-migration:get-state",
  STATE: "legacy-migration:state",
} as const;

export type LEGACY_MIGRATIONChannel = typeof LEGACY_MIGRATION_CHANNELS[keyof typeof LEGACY_MIGRATION_CHANNELS];
