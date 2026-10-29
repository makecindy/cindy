/** Synthetic requests shared by the approvals-inbox store and transport stubs. */
const rule = (toolName: string, ruleContent?: string) => [
  { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName, ruleContent }] },
];

export interface FixtureRequest {
  sessionId: string;
  requestId: string;
  title: string;
  lead: string;
  role: string;
  label: string;
  project: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  autoReviewReason?: string;
  suggestions?: unknown[];
}

export const LEADS: Record<string, string> = {
  'lead-main': 'Ship approval routing',
  'lead-billing': 'Migrate billing API and roll out regional gateways to every production region',
};

export const REQUESTS: FixtureRequest[] = [
  {
    sessionId: 's-frontend', requestId: 'req-frontend', title: 'Frontend Worker session', lead: 'lead-main',
    role: 'developer', label: 'frontend', project: 'cindy-desktop',
    toolName: 'Bash',
    input: { command: 'pnpm --filter @cindy/desktop exec vitest run src/renderer/features/approvals' },
    description: 'Run the focused tests for the approval inbox.',
    autoReviewReason: 'This command runs project scripts and needs your approval.',
    suggestions: rule('Bash', 'pnpm --filter:*'),
  },
  {
    sessionId: 's-tests', requestId: 'req-tests', title: 'Tests Worker session', lead: 'lead-main',
    role: 'tester', label: 'tests', project: 'cindy-desktop',
    toolName: 'Edit',
    input: {
      file_path: 'apps/desktop/src/renderer/features/approvals/__tests__/ApprovalsInbox.test.tsx',
      old_string: 'expect(count).toBe(2)', new_string: 'expect(count).toBe(3)',
    },
    description: 'Update the assertions for the new placeholder state.',
    suggestions: rule('Edit'),
  },
  {
    sessionId: 's-backend', requestId: 'req-backend', title: 'Backend Worker session', lead: 'lead-billing',
    role: 'developer', label: 'backend', project: 'billing-service',
    toolName: 'LS', input: { path: '/Users/example/Documents/exports/2026-Q3' },
    description: 'List the export folder to find the invoice CSV files.',
    suggestions: rule('LS'),
  },
  {
    sessionId: 's-a11y', requestId: 'req-a11y', title: 'Localization verification session', lead: 'lead-billing',
    role: 'reviewer', label: 'a11y-l10n-verification-worker',
    project: 'customer-portal-localization-monorepo-2026-q4',
    toolName: 'Bash',
    input: {
      command: 'node scripts/verify-localization.mjs --locales ja,ko,zh-TW --fail-on-missing --report artifacts/localization/report-2026-10-28.json --include "packages/**/locales/*.json"',
    },
    description: 'Check that every Japanese, Korean and Traditional Chinese string is present before the regional rollout.',
    autoReviewReason: 'The command writes a report file inside the project.',
    suggestions: rule('Bash', 'node scripts/verify-localization.mjs:*'),
  },
  {
    sessionId: 's-docs', requestId: 'req-docs', title: 'Docs Worker session', lead: 'lead-main',
    role: 'developer', label: 'docs', project: 'cindy-desktop',
    toolName: 'Bash', input: { command: 'git diff --stat docs/design-rules' },
    description: 'See which design documents changed.',
    suggestions: rule('Bash', 'git diff:*'),
  },
];

/** A request that arrives while the page is open (pointer-under-the-queue check). */
export const ARRIVAL: FixtureRequest = {
  sessionId: 's-review', requestId: 'req-review', title: 'Review Worker session', lead: 'lead-main',
  role: 'reviewer', label: 'review', project: 'cindy-desktop',
  toolName: 'Bash', input: { command: 'git log --oneline -n 20' }, description: 'Read the recent history.',
};

export const ALL = [...REQUESTS, ARRIVAL];
