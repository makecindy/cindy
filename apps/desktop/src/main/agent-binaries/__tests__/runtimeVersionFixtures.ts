import claudeLatest from '../../../../../../tools/claude/latest.json';
import codexLatest from '../../../../../../tools/codex/latest.json';

export const PINNED_CLAUDE_VERSION = claudeLatest.version;
export const PINNED_CODEX_VERSION = codexLatest.version;

function stableVersionParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`Expected a semantic runtime version, received: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function olderStableVersion(version: string): string {
  const [major, minor, patch] = stableVersionParts(version);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  if (major > 0) return `${major - 1}.0.0`;
  throw new Error(`Cannot derive an older stable version from: ${version}`);
}

export function newerStableVersion(version: string): string {
  const [major, minor] = stableVersionParts(version);
  return `${major}.${minor + 1}.0`;
}

export function prereleaseAtPinnedCore(version: string): string {
  const [major, minor, patch] = stableVersionParts(version);
  return `${major}.${minor}.${patch}-beta.1`;
}
