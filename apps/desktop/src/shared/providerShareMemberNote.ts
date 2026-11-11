/** 备注为单行、最多 80 个 UTF-16 单元，与输入框的 maxLength 一致。空串表示清除。 */
export const PROVIDER_SHARE_MEMBER_NOTE_MAX_LENGTH = 80;

export function normalizeProviderShareMemberNote(value: string): string {
  return value.replace(/[\p{Cc}\u2028\u2029]/gu, ' ').trim();
}

export function providerShareMemberName(member: {
  displayName: string;
  note?: string | null;
}): string {
  return member.note?.trim() || member.displayName;
}
