export default {
  name: 'task-auto-archive', entry: './fixture.tsx',
  viewport: { width: 1000, height: 360 },
  real: 'fillGhostCardTaskAutoArchiveHint, Toast, Button, product translations',
  notCovered: 'PR shell uses scenario data; task navigation, worktree IPC and mobile rendering are not exercised',
  cases: { default: { about: 'Pending auto-archive copy' }, blocked: { about: 'Uncommitted worktree explanation after leaving' } },
};
