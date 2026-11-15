/** Agent harness runtimes a standalone Host release can bundle (`apps/<name>/<platform>`). */
export const RELEASE_HARNESSES = Object.freeze(['claude-code-bin', 'codex-package-bin', 'pi-bin', 'ripgrep-bin']);

/**
 * Choose which harnesses a release bundles. `--harnesses` takes precedence over
 * `CINDY_HOST_HARNESSES`; with neither, every harness is bundled as before.
 * Unknown names fail fast so a typo cannot ship a release missing an agent.
 *
 * @param {{ option?: string, env?: NodeJS.ProcessEnv }} [input]
 * @returns {{ harnesses: string[], warnings: string[] }}
 */
export function selectReleaseHarnesses({ option, env = process.env } = {}) {
  const raw = option ?? env.CINDY_HOST_HARNESSES;
  if (raw === undefined || raw.trim() === '') return { harnesses: [...RELEASE_HARNESSES], warnings: [] };
  const requested = new Set(raw.split(',').map(name => name.trim()).filter(Boolean));
  const unknown = [...requested].filter(name => !RELEASE_HARNESSES.includes(name));
  if (unknown.length) {
    throw new Error(`Unknown harness: ${unknown.join(', ')}. Choose from: ${RELEASE_HARNESSES.join(', ')}`);
  }
  if (!requested.size) throw new Error('No harness selected; omit --harnesses to bundle all of them');
  const warnings = [];
  // ripgrep is a tool, not an agent, but Pi's search and file tools depend on it.
  if (requested.has('pi-bin') && !requested.has('ripgrep-bin')) {
    warnings.push('pi-bin is selected without ripgrep-bin; Pi search and file tools need ripgrep, so bundle both.');
  }
  return { harnesses: RELEASE_HARNESSES.filter(name => requested.has(name)), warnings };
}
