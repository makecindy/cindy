export const WORKSPACE_CHANNELS = {
  SCAN_AT_RESOURCES: "workspace:scan-at-resources",
  SCAN_SLASH_COMMANDS: "workspace:scan-slash-commands",
} as const;

export type WORKSPACEChannel = typeof WORKSPACE_CHANNELS[keyof typeof WORKSPACE_CHANNELS];
