import fs from "node:fs/promises";
import path from "node:path";

function isPathWithin(base: string, target: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const relative = path.relative(normalize(base), normalize(target));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Resolve an attachment only when its lexical path is under an approved root
 * (original or canonical form) and its canonical target stays under that root.
 * Returning the canonical
 * path keeps the later stat/read on the same symlink-resolved target.
 */
export async function resolveAllowedOutboundFile(
  absPath: string,
  allowedRoots: readonly string[],
  realpath: (target: string) => Promise<string> = fs.realpath,
): Promise<string | null> {
  const targetAbs = path.resolve(absPath);
  for (const root of allowedRoots) {
    if (!root.trim()) continue;
    const rootAbs = path.resolve(root);
    try {
      const rootReal = await realpath(rootAbs);
      // Host collection returns realpath; a symlink/junction workdir may still
      // be lexical here. Accept either spelling, not arbitrary outside aliases.
      if (!isPathWithin(rootAbs, targetAbs) && !isPathWithin(rootReal, targetAbs)) continue;
      const targetReal = await realpath(targetAbs);
      if (isPathWithin(rootReal, targetReal)) return targetReal;
    } catch {
      // Missing, unreadable, or cyclic paths fail closed.
    }
  }
  return null;
}
