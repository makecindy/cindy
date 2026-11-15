import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import { isAgentIslandSoundId, type AgentIslandSoundChoice } from '../../shared/agentIsland.js';
import { createLogger } from '../logger.js';

const log = createLogger('agent-island:sound');

/** Same level the island helper plays at (`AgentIslandSoundPlayer`). */
const VOLUME = '0.58';

function builtinSoundPath(id: string): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'agent-island')
    : path.join(app.getAppPath(), 'native', 'agent-island');
  return path.join(base, 'sounds', `${id}.mp3`);
}

/**
 * Plays an Agent Notch event sound without the native helper, which is suspended while
 * Agent Notch is off. macOS only; the Live Activity that needs it is macOS-only too.
 */
export function playAgentIslandSoundWithAfplay(sound: AgentIslandSoundChoice): void {
  const file = sound.type === 'builtin'
    ? (isAgentIslandSoundId(sound.id) ? builtinSoundPath(sound.id) : null)
    : sound.path;
  if (!file || !fs.existsSync(file)) return;
  try {
    const child = spawn('/usr/bin/afplay', ['-v', VOLUME, file], { stdio: 'ignore' });
    child.on('error', (error) => log.warn('afplay failed', error));
    child.unref();
  } catch (error) {
    log.warn('afplay failed', error);
  }
}
