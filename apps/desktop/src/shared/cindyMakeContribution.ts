/**
 * Submitting one Cindy Make change to the official repository as a pull request.
 * Only public facts cross to the renderer: PR number, URL, state, file paths.
 */

export type CindyMakeContributionState = 'open' | 'merged' | 'closed';

export interface CindyMakeContributionView {
  runId: string;
  number: number;
  url: string;
  state?: CindyMakeContributionState;
  submittedAt: number;
}

/** Prefilled pull request; the user reviews and edits every field before submitting. */
export interface CindyMakeContributionDraft {
  runId: string;
  title: string;
  body: string;
  /** Commit author and DCO sign-off identity. */
  name: string;
  email: string;
  files: string[];
  /** The change touches UI paths, so the design-basis field must be filled in. */
  touchesUi: boolean;
  repository: string;
  /** An earlier submission of this change; submitting again updates it. */
  existing?: CindyMakeContributionView;
}

export type CindyMakeContributionRequest =
  | { action: 'status' }
  | { action: 'draft'; runId: string }
  | { action: 'submit'; runId: string; title: string; body: string; name: string; email: string };

export const CINDY_MAKE_CONTRIBUTION_ERRORS = [
  /** The personal version is not saved to the user's GitHub yet. */
  'notBound',
  'github',
  'account',
  /** The change or its saved content is no longer available on this computer. */
  'unavailable',
  /** The change does not apply cleanly to the latest official code. */
  'conflict',
  /** The change has no difference from the latest official code. */
  'empty',
  'invalid',
  'network',
  'workflowScope',
  'failed',
] as const;
export type CindyMakeContributionError = (typeof CINDY_MAKE_CONTRIBUTION_ERRORS)[number];

export const CONTRIBUTION_LIMITS = { title: 200, body: 60_000, name: 100, email: 254 } as const;

/**
 * Mirrors the UI path heuristic of `scripts/check-pr-design-basis.mjs`; keep both lists
 * in sync so a prefilled PR body asks for the design basis exactly when CI will.
 */
const UI_PATH_PREFIXES = [
  'apps/desktop/src/renderer/',
  'apps/mobile/app/',
  'apps/mobile/src/auth/',
  'apps/mobile/src/components/',
  'apps/mobile/src/i18n/',
  'apps/mobile/src/notifications/',
  'apps/mobile/src/session/',
  'apps/mobile/src/settings/',
  'apps/mobile/src/theme/',
];
const UI_FILE_SUFFIXES = ['.css', '.scss', '.less'];

export function touchesUiPath(path: string): boolean {
  return (
    UI_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    UI_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix))
  );
}

/** A plain address check; DCO only needs a real, reachable identity, verified by the author. */
export function isContributionEmail(value: string): boolean {
  return (
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) && value.length <= CONTRIBUTION_LIMITS.email
  );
}
