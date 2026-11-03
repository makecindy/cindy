import { onQuit } from '../lifecycle';
import type { ScanResult } from './scanner';
import type { SkillListProjectionInput } from './skillListProjection';
import type { SkillScanGrantInput, SkillScanGrants } from './skillScanGrants';
import os from 'node:os';
import path from 'node:path';
import { utilityProcess } from 'electron';
import type { AgentCustomization, ListCustomizationsOptions, ListCustomizationsResult } from '@cindy/maker-core';
import { createLogger } from '../logger';
import { CustomizationScanClient } from './customizationScanClient';

const log = createLogger('skillhub:discovery');
const client = new CustomizationScanClient({
  fork: () => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      'PATH', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
      'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return utilityProcess.fork(path.join(__dirname, 'customizationScanProcess.js'), [], {
      serviceName: 'cindy-skill-discovery',
      env,
      cwd: os.tmpdir(),
      stdio: 'ignore',
    });
  },
});

let shutdownRegistered = false;

export async function scanLocalCustomizations(
  engine: AgentCustomization['engine'], options: ListCustomizationsOptions,
): Promise<ListCustomizationsResult> {
  registerShutdown();
  const result = await client.scan(engine, options);
  if (result.errors.length > 0) log.warn('Customization discovery returned errors', { engine, count: result.errors.length });
  return result;
}

function registerShutdown(): void {
  if (!shutdownRegistered) {
    onQuit('skillhub-discovery', () => client.dispose());
    shutdownRegistered = true;
  }
}

/** Projection reads user paths only in the same bounded, killable process. */
export async function projectSkillList(input: SkillListProjectionInput): Promise<ScanResult> {
  registerShutdown();
  return client.request({ kind: 'project', input }, (value): value is ScanResult => {
    const result = value as ScanResult | null;
    return !!result && Array.isArray(result.skills) && Array.isArray(result.sources);
  }, (message) => ({ skills: [], sources: [{ kind: 'skill', scope: 'global', path: '',
    status: { state: 'error', message } }] }));
}

/** Private snapshots remain on Main; renderer/account checks stay in the IPC handler. */
export async function inspectSkillListGrants(input: SkillScanGrantInput): Promise<SkillScanGrants> {
  registerShutdown();
  const result = await client.request({ kind: 'grants', input }, (value): value is SkillScanGrants => {
    const result = value as SkillScanGrants | null;
    return !!result && Array.isArray(result.entries) && Array.isArray(result.records);
  }, (error) => ({ entries: [], records: [], error }));
  if (result.error) throw new Error(result.error);
  return result;
}
