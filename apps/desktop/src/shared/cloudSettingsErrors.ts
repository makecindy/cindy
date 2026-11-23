/** CIS refusals the owner can act on, each with its own message instead of a generic failure. */
export const CLOUD_REFUSALS = {
  MANAGEMENT_ACCESS_DENIED: 'CLOUD_SETTINGS_ACCESS_DENIED',
  CLOUD_MEMBER_SUSPENDED: 'CLOUD_SETTINGS_MEMBER_SUSPENDED',
  CLOUD_ADMISSION_CLOSED: 'CLOUD_SETTINGS_ADMISSION_CLOSED',
  CLOUD_ADMISSION_NOT_LISTED: 'CLOUD_SETTINGS_ADMISSION_NOT_LISTED',
  CLOUD_ADMISSION_FULL: 'CLOUD_SETTINGS_ADMISSION_FULL',
  INSTANCE_QUOTA_EXCEEDED: 'CLOUD_SETTINGS_QUOTA_EXCEEDED',
  CLOUD_INSTANCE_TRANSFERRED: 'CLOUD_SETTINGS_INSTANCE_TRANSFERRED',
  CLOUD_INSTANCE_HANDOVER_IN_PROGRESS: 'CLOUD_SETTINGS_TRANSFER_IN_PROGRESS',
} as const;
export type CloudRefusalCode = (typeof CLOUD_REFUSALS)[keyof typeof CLOUD_REFUSALS];
const REFUSAL_CODES: readonly string[] = Object.values(CLOUD_REFUSALS);

export const CLOUD_CLIENT_ERRORS = [
  'CLOUD_SETTINGS_UNSUPPORTED',
  'CLOUD_SETTINGS_SCOPE_CHANGED',
  'CLOUD_SETTINGS_NOT_READY',
  'CLOUD_SETTINGS_UNAVAILABLE',
  'CLOUD_SETTINGS_INVALID_RESPONSE',
  'CLOUD_SETTINGS_SAVE_UNCONFIRMED',
  'CLOUD_SETTINGS_BUSY',
  'CLOUD_SETTINGS_CONFLICT',
  ...(Object.values(CLOUD_REFUSALS) as CloudRefusalCode[]),
] as const;
export type CloudClientErrorCode = (typeof CLOUD_CLIENT_ERRORS)[number];

/** The client code for a CIS error code that refuses the request, or null for anything else. */
export function cloudRefusal(serverCode: unknown): CloudRefusalCode | null {
  return typeof serverCode === 'string' && Object.hasOwn(CLOUD_REFUSALS, serverCode)
    ? CLOUD_REFUSALS[serverCode as keyof typeof CLOUD_REFUSALS]
    : null;
}

/** Whether a client error code (or an error carrying one as its message) is a CIS refusal. */
export function isCloudRefusal(value: unknown): value is CloudRefusalCode {
  const code = value instanceof Error ? value.message : value;
  return typeof code === 'string' && REFUSAL_CODES.includes(code);
}
