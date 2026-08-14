import path from 'node:path';

import type { PiRuntimeCommand } from '../../types/pi-runtime-capabilities.js';

/**
 * Return the exact explicit --skill directory proven by pinned Pi provenance.
 * Pi v0.83 reports explicit local skills as either `temporary` (staged launch
 * snapshots) or `project` (paths passed directly on the CLI). Both fields must
 * agree; accepting either independently lets malformed runtime data mark the
 * wrong discovered project skill loaded.
 */
export function piExplicitSkillRuntimePath(command: PiRuntimeCommand): string | null {
  const baseDir = command.sourceInfo.baseDir;
  const skillFile = command.sourceInfo.path;
  if (
    command.source !== 'skill'
    || (command.sourceInfo.scope !== 'temporary' && command.sourceInfo.scope !== 'project')
    || command.sourceInfo.source !== 'local'
    || typeof baseDir !== 'string'
    || typeof skillFile !== 'string'
    || baseDir.includes('\0')
    || skillFile.includes('\0')
    || path.resolve(path.dirname(skillFile)) !== path.resolve(baseDir)
  ) return null;
  if (path.basename(skillFile) === 'SKILL.md') return baseDir;
  return path.extname(skillFile) === '.md' ? skillFile : null;
}
