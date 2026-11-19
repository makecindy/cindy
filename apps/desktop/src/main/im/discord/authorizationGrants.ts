/** Host-local grant generations. Stored atomically with the existing access settings, never on the wire. */
import { createHash, randomBytes } from 'node:crypto';
import { decodeDiscordLaneUserId, isDiscordLaneAdmitted, type DiscordChannelAccessConfig } from '@cindy/im';

export interface DiscordFinalTextGrants {
  seed: string;
  targets: Record<string, { value: string; revision: string }>;
}
const MAX_GRANTS = 1024;
export const discordGrantHash = (value: string) => createHash('sha256').update(value).digest('hex');
const revision = (seed: string, key: string, value: string) => discordGrantHash(`${seed}:${key}:${value}`).slice(0, 24);

export function discordGrantTarget(access: DiscordChannelAccessConfig, lane: string): string {
  const decoded = decodeDiscordLaneUserId(lane);
  if (!decoded) return 'dm';
  const guild = access.guilds?.find(g => g.guildId === decoded.guildId);
  return `g/${decoded.guildId}/${guild?.enabled && guild.mode === 'all' ? '*' : decoded.channelId}`;
}

export function discordGrantTargets(access: DiscordChannelAccessConfig): string[] {
  return ['dm', ...access.channels.map(c => `g/${c.guildId}/${c.channelId}`), ...(access.guilds ?? []).map(g => `g/${g.guildId}/*`)];
}

export function discordGrantValue(access: DiscordChannelAccessConfig, target: string, binding: string): string {
  const guildId = target.split('/')[1];
  const guild = access.guilds?.find(g => g.guildId === guildId);
  const via = guild?.enabled && guild.mode === 'all' ? 'all' : 'selected';
  const lane = decodeDiscordLaneUserId(target);
  const wildcard = target.endsWith('/*');
  return discordGrantHash(JSON.stringify([binding, via,
    wildcard ? via === 'all' : lane ? isDiscordLaneAdmitted(access, lane, true) : true,
    wildcard ? via === 'all' && guild?.allowMembers === true : lane ? isDiscordLaneAdmitted(access, lane, false) : false]));
}

/** Reconcile on every settings write: unrelated grants stay stable, revoke/regrant advances the target. */
export function reconcileDiscordFinalTextGrants(raw: DiscordFinalTextGrants | undefined, keys: string[], valueFor: (key: string) => string): DiscordFinalTextGrants {
  let seed = typeof raw?.seed === 'string' && /^[a-f0-9]{24}$/.test(raw.seed) ? raw.seed : '0'.repeat(24);
  const targets: DiscordFinalTextGrants['targets'] = {};
  const previous = raw?.targets && typeof raw.targets === 'object' ? raw.targets : {};
  // Keep active grants before retired generations. A new seed makes capacity-evicted generations unusable.
  const allKeys = [...new Set([...keys, ...Object.keys(previous).reverse()])];
  if (allKeys.length > MAX_GRANTS) seed = randomBytes(12).toString('hex');
  for (const key of allKeys.slice(0, MAX_GRANTS)) {
    if (!/^(personal|[a-f0-9]{12}):(dm|g\/\d{1,25}\/(\d{1,25}|\*))$/.test(key)) continue;
    const old = previous[key];
    const value = valueFor(key);
    const valid = old && typeof old.revision === 'string' && /^[a-f0-9]{24}$/.test(old.revision);
    targets[key] = { value, revision: valid && old.value === value ? old.revision : revision(valid ? old.revision : seed, key, value) };
  }
  return { seed, targets };
}

export function discordFinalTextGrantStamp(grants: DiscordFinalTextGrants, key: string, value: string): string {
  return grants.targets[key]?.revision ?? revision(grants.seed, key, value);
}
