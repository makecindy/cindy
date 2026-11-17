/**
 * Path-string helpers shared between the main and renderer processes.
 *
 * Lives in `src/shared` (like `textFileExts.ts`) so both processes import the same
 * canonical implementation via relative paths.
 */

/**
 * Strip trailing path separators (`/` and `\`) from a string.
 *
 * Behaviour-identical to `value.replace(/[\\/]+$/, '')` but linear (O(n)): it walks
 * back from the end instead of letting the regex engine retry the anchored `[\\/]+$`
 * at every offset, which CodeQL flags as a degree-2 polynomial ReDoS on long runs of
 * separators (`js/polynomial-redos`).
 */
export function stripTrailingPathSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === '/' || value[end - 1] === '\\')) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

/**
 * `/D:/x` — a Windows drive-letter path spelled as a URI pathname — without the
 * leading slash: `D:/x`. Models emit this shape inside markdown links
 * (`[dir](/D:/Java)`); a bare `/D:` is the same spelling of the drive root and
 * maps to `D:/` (the link pipeline strips a trailing separator off directory
 * hrefs before resolving, so `/D:/` arrives here as `/D:`). Non-matching
 * inputs are returned unchanged, so callers can detect a hit by comparing
 * `out !== in`.
 */
export function stripWindowsDriveUriSlash(value: string): string {
  if (/^\/[A-Za-z]:$/.test(value)) return `${value.slice(1)}/`;
  return /^\/[A-Za-z]:[\\/]/.test(value) ? value.slice(1) : value;
}

/**
 * Convert POSIX-shaped spellings of a Windows drive path to native Win32 form,
 * for callers that feed Node `fs` / `shell` APIs on Windows:
 *   - `/e/AIWork/x` — MSYS/Git-Bash drive mount (Claude Code SDK `file_path`)
 *   - `/D:/x`, `/D:` — URI pathname form (see stripWindowsDriveUriSlash)
 * Anything else is returned unchanged.
 */
export function posixDrivePathToWin32(value: string): string {
  const driveUri = /^\/([a-zA-Z]):(?:[\\/](.*))?$/.exec(value);
  if (driveUri) return `${driveUri[1].toUpperCase()}:\\${(driveUri[2] ?? '').replace(/\//g, '\\')}`;
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(value);
  if (msys) return `${msys[1].toUpperCase()}:\\${msys[2].replace(/\//g, '\\')}`;
  return value;
}
