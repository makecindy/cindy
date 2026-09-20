import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { createLogger } from '../logger';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file';
import {
  BUILT_IN_LEARN_SKILL_NAME,
  builtInSkillDescriptors,
  canonicalBuiltInSkillActivationPath,
} from '../maker-host/built-in-skills';

/** Device/profile-local user intent; independent of cloud installs and account changes. */
interface SkillActivationPreferences {
  disabledPaths: string[];
  discoveryPaths?: Record<string, string[]>;
  revisions?: Record<string, string>;
}

export function skillActivationKey(source: string): string {
  let resolved = path.resolve(source);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* Allow cleanup after removal. */ }
  if (path.basename(resolved).toLowerCase() === 'skill.md') resolved = path.dirname(resolved);
  resolved = canonicalBuiltInSkillActivationPath(
    resolved,
    app.getPath('userData'),
    app.getPath('appData'),
  );
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const store = createOverrideSettingsFile<SkillActivationPreferences>({
  filePath: () => path.join(app.getPath('userData'), 'skillhub', 'activation-preferences.json'),
  defaults: { disabledPaths: [] },
  normalize: (raw) => {
    const values = (raw as Partial<SkillActivationPreferences> | null)?.disabledPaths;
    return { disabledPaths: Array.isArray(values)
      ? [...new Set(values.filter((v): v is string => typeof v === 'string' && path.isAbsolute(v)))].sort()
      : [],
      discoveryPaths: Object.fromEntries(Object.entries((raw as SkillActivationPreferences | null)?.discoveryPaths ?? {})
        .filter(([source, aliases]) => path.isAbsolute(source) && Array.isArray(aliases))
        .map(([source, aliases]) => [source, aliases.filter((alias): alias is string =>
          typeof alias === 'string' && path.isAbsolute(alias))])),
      revisions: Object.fromEntries(Object.entries((raw as SkillActivationPreferences | null)?.revisions ?? {})
        .filter(([source, revision]) => path.isAbsolute(source) && typeof revision === 'string')),
    };
  },
  log: createLogger('skillhub:activation'),
  label: 'skill activation',
  logLoadedValue: false,
  preserveUnreadableFile: true,
});

export function readDisabledSkillPaths(): readonly string[] {
  store.invalidateIfChanged();
  const value = store.read();
  const paths = value.disabledPaths.flatMap((source) => [source,
    ...(value.discoveryPaths?.[source] ?? []).filter((alias) => {
      try { return fs.existsSync(alias) && skillActivationKey(alias) === source; }
      catch { return false; }
    }),
  ]);
  // Cindy's bundled copy normally wins through ~/.agents/skills. Claude uses an
  // isolated config directory in Desktop dev, so mirror the same user preference
  // to that runtime projection. Codex's own /skill-creator remains independent.
  for (const descriptor of builtInSkillDescriptors(
    app.getPath('userData'),
    app.getPath('appData'),
  )) {
    if (value.disabledPaths.includes(skillActivationKey(descriptor.absolutePath))) {
      try {
        if (
          skillActivationKey(descriptor.nativeClaudePath) ===
          skillActivationKey(descriptor.absolutePath)
        ) paths.push(descriptor.nativeClaudePath);
      } catch {
        // A missing or user-owned projection must not disable a same-name user Skill.
      }
    }
  }
  return [...new Set(paths)];
}

export function isCindySkillEnabled(source: string): boolean {
  return !readDisabledSkillPaths().includes(skillActivationKey(source));
}

export function isCindyLearnSkillEnabled(): boolean {
  const descriptor = builtInSkillDescriptors(
    app.getPath('userData'),
    app.getPath('appData'),
  ).find((skill) => skill.name === BUILT_IN_LEARN_SKILL_NAME);
  return descriptor ? isCindySkillEnabled(descriptor.absolutePath) : false;
}

export interface SkillActivationSnapshot { key: string; revision?: string; aliases: string[] }

export function snapshotSkillActivation(source: string): SkillActivationSnapshot | null {
  store.invalidateIfChanged();
  const value = store.read();
  const key = skillActivationKey(source);
  return value.disabledPaths.includes(key)
    ? { key, revision: value.revisions?.[key], aliases: value.discoveryPaths?.[key] ?? [] } : null;
}

/** Compare the captured intent inside the settings lock; later toggles always win. */
export async function clearSkillActivationSnapshot(snapshot: SkillActivationSnapshot, canMutate: () => boolean): Promise<void> {
  await store.updateAtomic(({ value }) => {
    if (!canMutate()) throw new Error('Skill mutation context changed');
    const { key } = snapshot;
    if (value.revisions?.[key] !== snapshot.revision
      || JSON.stringify(value.discoveryPaths?.[key] ?? []) !== JSON.stringify(snapshot.aliases)) return value;
    const discoveryPaths = { ...value.discoveryPaths };
    const revisions = { ...value.revisions };
    delete discoveryPaths[key];
    delete revisions[key];
    return { disabledPaths: value.disabledPaths.filter((item) => item !== key), discoveryPaths, revisions };
  });
}

export async function setCindySkillEnabled(source: string, enabled: boolean, canMutate: () => boolean = () => true, discoveryPaths: readonly string[] = []): Promise<void> {
  const key = skillActivationKey(source);
  await store.updateAtomic(({ value }) => {
    if (!canMutate()) throw new Error('Skill mutation context changed');
    const aliases = { ...value.discoveryPaths };
    const revisions = { ...value.revisions };
    delete revisions[key];
    if (!enabled) revisions[key] = randomUUID();
    delete aliases[key];
    if (!enabled) aliases[key] = [...new Set([...(value.discoveryPaths?.[key] ?? []), ...discoveryPaths])]
      .filter((alias) => path.isAbsolute(alias) && skillActivationKey(alias) === key);
    return { revisions, discoveryPaths: aliases, disabledPaths: enabled
      ? value.disabledPaths.filter((item) => item !== key)
      : [...new Set([...value.disabledPaths, key])].sort(),
    };
  });
}

/** Run the filesystem rename and preference migration under the same settings lock. */
export async function renameSkillWithActivation(
  source: string,
  destination: string,
  renameFiles: () => void,
): Promise<void> {
  await store.updateAtomic(({ value }) => {
    const oldKey = skillActivationKey(source);
    renameFiles();
    const newKey = skillActivationKey(destination);
    const disabledPaths = value.disabledPaths.filter((key) => key !== oldKey && key !== newKey);
    if (value.disabledPaths.includes(oldKey)) disabledPaths.push(newKey);
    const discoveryPaths = { ...value.discoveryPaths };
    const revisions = { ...value.revisions };
    delete revisions[oldKey];
    delete revisions[newKey];
    if (value.disabledPaths.includes(oldKey)) revisions[newKey] = randomUUID();
    delete discoveryPaths[oldKey];
    delete discoveryPaths[newKey];
    if (value.disabledPaths.includes(oldKey)) discoveryPaths[newKey] = [destination];
    return { disabledPaths: [...new Set(disabledPaths)].sort(), discoveryPaths, revisions };
  });
}
