import type { CompanionProfileRepairField } from '../../shared/companionCloud.js';
import { BotProfileSourceTooLong, readBotProfileSource, validateCompanionProfileSources } from '../../shared/botProfileSources.js';
import type { CompanionRow } from './store.js';
import { isCompanionProfileSnapshot, valueHash } from './uploader.js';

export class CompanionProfileRepairError extends Error {
  constructor(readonly reason: 'changed' | 'invalid' | 'backup') { super(`PROFILE_REPAIR_${reason.toUpperCase()}`); }
}

const sources = { identitySource: 'soul', userContextSource: 'user' } as const;
export type ProfileCorrection = { version: string; values: Partial<Record<keyof typeof sources, string>> };

/** Include the storage revision: replacing a value with identical text still invalidates the editor. */
export const profileRepairVersion = (row: CompanionRow) => valueHash(row);

export function profileRepairFields(row: CompanionRow): CompanionProfileRepairField[] {
  if (!isCompanionProfileSnapshot(row.value)) throw new CompanionProfileRepairError('changed');
  const profile = row.value as Record<string, unknown>;
  return (Object.keys(sources) as Array<keyof typeof sources>).flatMap(field => {
    try { readBotProfileSource(profile[sources[field]], field); return []; }
    catch (error) {
      if (!(error instanceof BotProfileSourceTooLong)) throw error;
      return [{ field, source: profile[sources[field]] as string, maxLength: error.failure.maxLength }];
    }
  });
}

/** A recovery edit can only replace the rejected sources in exactly the snapshot the owner saw. */
export function correctedProfile(row: CompanionRow, correction?: ProfileCorrection) {
  if (!isCompanionProfileSnapshot(row.value)) throw new CompanionProfileRepairError('changed');
  if (!correction) { validateCompanionProfileSources(row.value); return row.value; }
  if (profileRepairVersion(row) !== correction.version) throw new CompanionProfileRepairError('changed');
  const fields = profileRepairFields(row);
  const values = correction.values;
  if (!values || typeof values !== 'object' || Array.isArray(values) || !fields.length
    || Object.keys(values).length !== fields.length || fields.some(f => typeof values[f.field] !== 'string')
    || Object.keys(values).some(key => !fields.some(f => f.field === key))) throw new CompanionProfileRepairError('invalid');
  const profile = { ...row.value };
  for (const { field } of fields) profile[sources[field]] = readBotProfileSource(values[field], field) ?? '';
  validateCompanionProfileSources(profile);
  return profile;
}
