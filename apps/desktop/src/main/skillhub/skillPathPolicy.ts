import fs from 'node:fs';
import path from 'node:path';

const SKILL_PATH_WHITELIST = /\/(\.(claude\/(skills|commands|agents)|agents\/skills|codex\/skills|pi\/skills)|codex-home\/skills)\//;

export function isLexicallyAllowedSkillPath(absolutePath: string): boolean {
  // path.resolve 解析 .. 和 . 段，防止遍历绕过白名单
  const norm = path.resolve(absolutePath).replace(/\\/g, '/');
  return SKILL_PATH_WHITELIST.test(norm);
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

/**
 * Resolve the final existing target before Main performs IO. Project-owned
 * `.pi/skills` paths get an extra physical boundary: neither the source root
 * nor a child symlink may escape the project. Other roots keep supporting the
 * existing global compatibility symlinks used by shared skill installs.
 */
export function resolveAllowedExistingSkillPath(absolutePath: string): string | null {
  if (!isLexicallyAllowedSkillPath(absolutePath)) return null;
  const lexicalPath = path.resolve(absolutePath);
  let realTarget: string;
  try {
    realTarget = fs.realpathSync.native(lexicalPath);
  } catch {
    return null;
  }

  const normalized = lexicalPath.replace(/\\/g, '/');
  const marker = '/.pi/skills/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return realTarget;

  const lexicalSkillRoot = path.normalize(normalized.slice(0, markerIndex + marker.length - 1));
  const lexicalProjectRoot = path.dirname(path.dirname(lexicalSkillRoot));
  try {
    const realProjectRoot = fs.realpathSync.native(lexicalProjectRoot);
    const realSkillRoot = fs.realpathSync.native(lexicalSkillRoot);
    if (
      !isPathWithin(realProjectRoot, realSkillRoot)
      || !isPathWithin(realSkillRoot, realTarget)
    ) return null;
  } catch {
    return null;
  }
  return realTarget;
}

export function resolveExistingSkillPathForGrant(absolutePath: string): string | null {
  if (!absolutePath || !path.isAbsolute(absolutePath)) return null;
  return resolveAllowedExistingSkillPath(absolutePath);
}
