import assert from 'node:assert/strict';

// Fixture data only: device and plugin names are generic examples, never real user data.
const sources = [
  { deviceId: 'mbp', name: 'MacBook Pro', platform: 'darwin', online: true, lastSeenAt: null },
  { deviceId: 'office', name: 'Office PC', platform: 'win32', online: true, lastSeenAt: null, unavailable: 'remote-control-off' },
  { deviceId: 'old', name: 'Mac mini (old)', platform: 'darwin', online: false, lastSeenAt: null, unavailable: 'offline' },
];

const consent = (ghostId, name, hosts) => ({
  kind: 'install',
  ghostId,
  name,
  version: '2.1.0',
  permissions: hosts.map((host) => ({ key: `network:${host}`, kind: 'network', labelKey: 'networkHost', labelArgs: { host } })),
});

const plugin = (ghostId, name, extra = {}) => ({
  key: `plugin:_root:${ghostId}`,
  state: 'ready',
  ghostId,
  name,
  version: '2.1.0',
  namespace: null,
  pluginId: `plg_${ghostId}`,
  source: 'market',
  marketName: null,
  enabledOnSource: true,
  consent: null,
  ...extra,
});

const plan = {
  planId: 'fixture-plan',
  source: { deviceId: 'mbp', name: 'MacBook Pro', platform: 'darwin' },
  createdAt: 0,
  plugins: [
    plugin('gmail', 'Gmail', { consent: consent('gmail', 'Gmail', ['gmail.googleapis.com']) }),
    plugin('calendar', 'Calendar Sync', { enabledOnSource: false, consent: consent('calendar', 'Calendar Sync', ['www.googleapis.com']) }),
    plugin('design-kit', 'Design Kit', { source: 'custom-market', marketName: 'Team Market', pluginId: 'custom:Team%20Market/design-kit' }),
    plugin('local-notes', 'Local Notes', { state: 'unavailable', reason: 'local-only', source: 'manual', pluginId: null }),
    plugin('retired', 'Retired Helper', { state: 'unavailable', reason: 'not-in-catalog' }),
    plugin('github', 'GitHub', { state: 'present' }),
  ],
  skills: [
    { key: 'skill:release-notes', state: 'ready', name: 'release-notes', version: '1.2.0', catalogScope: 'market', enabledOnSource: true },
    { key: 'skill:team-review', state: 'ready', name: 'team-review', version: '0.4.0', catalogScope: 'team', enabledOnSource: true },
    { key: 'skill:my-notes', state: 'unavailable', reason: 'local-only', name: 'my-notes', version: null, catalogScope: null, enabledOnSource: true },
  ],
  settings: [
    { key: 'settings:appearance', id: 'appearance', changeCount: 3, keptCount: 0, state: 'ready' },
    { key: 'settings:collaboration', id: 'collaboration', changeCount: 2, keptCount: 1, state: 'ready' },
    { key: 'settings:gitSafety', id: 'gitSafety', changeCount: 0, keptCount: 1, state: 'kept' },
    { key: 'settings:memory', id: 'memory', changeCount: 0, keptCount: 0, state: 'present' },
  ],
  rendererPrefs: { key: 'renderer-prefs', state: 'ready', values: { theme: 'dark', language: 'zh-CN' } },
  providers: [
    { key: 'provider:openrouter', state: 'ready', provider: { id: 'openrouter', name: 'OpenRouter', auth: 'apiKey', config: { id: 'openrouter', name: 'OpenRouter', runtimes: {} } } },
    { key: 'provider:ollama', state: 'unavailable', reason: 'local-only', provider: { id: 'ollama', name: 'Ollama (local)', auth: 'none', config: { id: 'ollama', runtimes: {} } } },
  ],
  mcpServers: [
    { key: 'mcp:docs', state: 'ready', server: { id: 'docs', name: 'Team Docs', transport: 'http', url: 'https://mcp.example.com/docs', headers: {}, hasToken: true } },
  ],
  builtinTools: [{ key: 'builtin-tool:browser', id: 'browser', enabled: true, state: 'ready' }],
  access: [
    { key: 'access:remote-control', id: 'remote-control', state: 'ready' },
    { key: 'access:keep-awake', id: 'keep-awake', state: 'ready' },
  ],
  secrets: {
    key: 'secrets',
    state: 'ready',
    items: [
      { kind: 'provider', ref: 'openrouter', name: 'OpenRouter' },
      { kind: 'mcp', ref: 'docs', name: 'Team Docs' },
      { kind: 'builtin', ref: 'brave', name: 'brave' },
      { kind: 'plugin', ref: 'plugin:_root:gmail', name: 'Gmail' },
    ],
  },
  sshHosts: [
    { key: 'ssh:web', id: 'web', displayName: 'web', hostname: 'web.example.com', port: 22, user: 'deploy', state: 'ready' },
    { key: 'ssh:build', id: 'build', displayName: 'Build server', hostname: '10.0.0.12', port: 2222, user: 'ci', state: 'ready' },
    { key: 'ssh:gpu', id: 'gpu', displayName: 'gpu', hostname: 'gpu.example.com', port: 22, user: 'me', state: 'present' },
  ],
  checklist: [
    { id: 'provider-key:openrouter', kind: 'provider-key', label: 'OpenRouter', ref: 'openrouter' },
    { id: 'provider-connection:openrouter', kind: 'provider-connection', label: 'OpenRouter', ref: 'openrouter' },
    { id: 'mcp-token:docs', kind: 'mcp-token', label: 'Team Docs', ref: 'docs' },
    { id: 'im-channel:telegram', kind: 'im-channel', label: 'telegram', ref: 'telegram' },
    { id: 'computer-use', kind: 'computer-use', label: 'computer', ref: 'computer' },
  ],
  unavailable: [],
};

const checklistAfter = [
  { id: 'plugin-setup:_root__gmail', kind: 'plugin-setup', label: 'Gmail', ref: '_root__gmail', details: ['Google account'] },
  // Keys copied from the other computer: done right away.
  ...plan.checklist.map((item) => (item.kind === 'provider-key' || item.kind === 'mcp-token' || item.kind === 'provider-connection' ? { ...item, done: true } : item)),
  { id: 'ssh-host:build', kind: 'ssh-host', label: 'Build server', ref: 'build' },
];

const applyResponse = {
  results: [
    { key: 'plugin:_root:gmail', outcome: 'done' },
    { key: 'plugin:_root:calendar', outcome: 'done' },
    { key: 'plugin:_root:design-kit', outcome: 'failed', code: 'MUTATION_CANCELLED' },
    { key: 'skill:release-notes', outcome: 'done' },
    { key: 'skill:team-review', outcome: 'done' },
    { key: 'settings:appearance', outcome: 'done' },
    { key: 'settings:collaboration', outcome: 'done' },
    { key: 'secrets', outcome: 'done' },
    { key: 'provider:openrouter', outcome: 'done' },
    { key: 'mcp:docs', outcome: 'done' },
    { key: 'ssh:web', outcome: 'done' },
    { key: 'ssh:build', outcome: 'failed', code: 'SSH_CONNECT_FAILED' },
  ],
  checklist: checklistAfter,
  handledKeys: ['provider:openrouter', 'mcp:docs'],
};

const waitForSource = { planId: 'fixture-plan', key: 'secrets', phase: 'running', completed: 7, total: 10, confirmCode: '482913' };

const tools = [{ id: 'browser', name: 'Browser' }];

async function next(page, ui) {
  await page.getByRole('button', { name: await ui.t('setupMigration.source.next'), exact: true }).click();
  await page.getByText('Gmail', { exact: true }).first().waitFor();
}

const readyCount = [
  ...plan.plugins,
  ...plan.skills,
  ...plan.settings,
  plan.rendererPrefs,
  ...plan.providers,
  ...plan.mcpServers,
  ...plan.builtinTools,
  ...plan.access,
  plan.secrets,
  ...plan.sshHosts,
].filter((item) => item.state === 'ready').length;

async function start(page, ui) {
  const label = await ui.t('setupMigration.review.start', { count: readyCount });
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByText(await ui.t('setupMigration.permissions.title'), { exact: true }).waitFor();
}

export default {
  name: 'setup-migration',
  entry: './setup-migration-fixture.tsx',
  viewport: { width: 1040, height: 760 },
  real: 'SetupMigrationDialog (computer picker, review groups, batch plugin permissions with GhostInstallConsentContent, result and one-time checklist), SetupMigrationSection, translations and themes',
  notCovered: 'Main-side snapshot, plan, plugin/skill installers, settings writes, key copy and SSH authorization (unit-tested in src/main/setup-migration and src/main/remote-ssh), the confirmation dialog on the other computer (native), device-link transport, the first-run suggestion timer, and two real computers',
  cases: {
    source: { about: 'Pick a computer; offline and remote-control-off computers explain why they cannot be read', data: { surface: 'dialog', sources, plan, applyResponse, tools } },
    default: { about: 'Review what moves: plugins, skills, settings, providers/MCP, access switches and the one-time checklist', data: { surface: 'dialog', sources, plan, applyResponse, tools } },
    permissions: { about: 'One confirmation for the permissions of all selected market plugins', data: { surface: 'dialog', sources, plan, applyResponse, tools } },
    done: { about: 'Result with a failed item and what is left to do on this computer', data: { surface: 'dialog', sources, plan, applyResponse, tools } },
    confirm: { about: 'Waiting for the other computer to allow keys and SSH, with the code both computers show', data: { surface: 'dialog', sources, plan, applyResponse, tools, waitForSource } },
    walkthrough: {
      about: 'Going through the remaining checklist one item at a time',
      data: {
        surface: 'walkthrough',
        walkthroughIds: checklistAfter.filter((item) => !item.done).map((item) => item.id),
        state: { lastRun: { sourceName: 'MacBook Pro', finishedAt: 0, checklist: checklistAfter }, suggestion: null },
      },
      viewport: { width: 900, height: 400 },
    },
    'read-error': { about: 'The other computer runs an older Cindy', data: { surface: 'dialog', deviceId: 'mbp', sources, plan, previewError: 'SETUP_SOURCE_OUTDATED', applyResponse, tools } },
    settings: {
      about: 'Settings → General entry with the remaining checklist',
      data: {
        surface: 'settings',
        state: { lastRun: { sourceName: 'MacBook Pro', finishedAt: 0, checklist: checklistAfter.map((item, index) => (index === 1 ? { ...item, done: true } : item)) }, suggestion: null },
      },
      viewport: { width: 900, height: 760 },
    },
  },
  async check(page, ui) {
    if (ui.case === 'settings') {
      await page.getByText(await ui.t('setupMigration.settings.description'), { exact: true }).waitFor();
      return;
    }
    if (ui.case === 'walkthrough') {
      await page.getByText(await ui.t('setupMigration.walkthrough.next'), { exact: true }).waitFor();
      return;
    }
    if (ui.case === 'read-error') {
      await page.getByText(await ui.t('setupMigration.errors.SETUP_SOURCE_OUTDATED', { name: 'MacBook Pro' }), { exact: true }).waitFor();
      return;
    }
    await page.getByText('MacBook Pro', { exact: true }).waitFor();
    if (ui.case === 'source') return;
    await next(page, ui);
    if (ui.case === 'default') {
      // Already-identical items are summarized instead of listed.
      assert.equal(await page.getByText('GitHub', { exact: true }).count(), 0);
      await ui.capture('scrolled', {});
      // Keys and SSH servers sit at the end of the list.
      await page.getByText(await ui.t('setupMigration.review.groups.ssh'), { exact: true }).scrollIntoViewIfNeeded();
      await ui.capture('keys-and-ssh', {});
      return;
    }
    await start(page, ui);
    if (ui.case === 'permissions') return;
    const confirm = await ui.t('setupMigration.permissions.confirm', { count: 2 });
    await page.getByRole('button', { name: confirm, exact: true }).click();
    if (ui.case === 'confirm') {
      await page.getByText('482913', { exact: true }).waitFor();
      return;
    }
    await page.getByText(await ui.t('setupMigration.done.checklistTitle'), { exact: true }).waitFor();
  },
};
