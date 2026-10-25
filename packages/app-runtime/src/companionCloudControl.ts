import type { CompanionCloudFailureCode, CompanionMergeResult, CompanionSwitchOptions } from '@cindy/companion-core/contract';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
const COMPANION_FAILURE_CODES: ReadonlySet<CompanionCloudFailureCode> = new Set<CompanionCloudFailureCode>(
  ['HOME_CONFLICT', 'OFFLINE', 'NOT_ENABLED', 'FAILED', 'TARGET_UNAVAILABLE', 'BUSY', 'HOME_OUTDATED', 'PAUSED']);
/** Kept and merged Cindy ids from a request (local IPC or another computer). */
export function companionMergeIds(keepBotId: unknown, fromBotIds: unknown): { keep: string; from: string[] } {
  if (typeof keepBotId !== 'string' || !keepBotId || keepBotId.length > 200) throwIpcError('INVALID_PARAMS', 'keepBotId required');
  if (!Array.isArray(fromBotIds) || !fromBotIds.length || fromBotIds.length > 20
    || fromBotIds.some(id => typeof id !== 'string' || !id || id.length > 200)) throwIpcError('INVALID_PARAMS', 'fromBotIds required');
  return { keep: keepBotId, from: [...new Set(fromBotIds as string[])].filter(id => id !== keepBotId) };
}
/** A merge answered by another computer; anything malformed is a plain failure. */
export function companionMergeResult(value: unknown): CompanionMergeResult {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const count = (key: string) => typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] as number : 0;
  if (record.ok === true) return { ok: true, merged: count('merged'), messages: count('messages'), memories: count('memories'), skills: count('skills'),
    renamed: Array.isArray(record.renamed) ? record.renamed.filter((name): name is string => typeof name === 'string').slice(0, 200) : [] };
  return { ok: false, code: companionFailureCode(typeof record.code === 'string' ? record.code : 'FAILED') };
}
/** What a move does while the companion is still working; anything else is the default (fail as busy). */
export function companionSwitchOptions(value: unknown): CompanionSwitchOptions | undefined {
  const whenBusy = value && typeof value === 'object' ? (value as { whenBusy?: unknown }).whenBusy : undefined;
  return whenBusy === 'wait' || whenBusy === 'stop' ? { whenBusy } : undefined;
}
/** A failure code answered by another computer; unknown codes (newer versions) are plain failures. */
export function companionFailureCode(code: string): CompanionCloudFailureCode {
  return COMPANION_FAILURE_CODES.has(code as CompanionCloudFailureCode) ? code as CompanionCloudFailureCode : 'FAILED';
}

