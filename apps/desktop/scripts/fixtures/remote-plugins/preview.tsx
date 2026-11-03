import { ghostConsentPermissionItems } from '../../../src/shared/ghostInstallConsent';
/** Visual fixture only. Uses the actual components; never reads production accounts or invokes a real computer. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '../../../src/renderer/styles/globals.css';

const query = new URLSearchParams(location.search);
const dark = query.get('theme') === 'dark';
const offline = query.has('offline');
const devices = [
  {
    deviceId: 'fixture-design',
    name: '设计电脑',
    platform: 'darwin',
    online: !offline,
    isSelf: false,
    controlEnabled: true,
    remoteControlEnabled: true,
  },
  {
    deviceId: 'fixture-build',
    name: '工作电脑',
    platform: 'win32',
    online: true,
    isSelf: false,
    controlEnabled: true,
    remoteControlEnabled: true,
  },
];
const ghosts = [null, 'design-team'].map((namespace) => ({
  manifest: {
    schemaVersion: 3,
    minCindyVersion: '0.1.61',
    id: 'notes',
    name: namespace ? '项目笔记' : '个人笔记',
    version: namespace ? '2.0.0' : '1.0.0',
    author: 'Example Publisher',
    description: namespace
      ? '整理团队资料，维护项目知识库。'
      : '记录想法和工作摘要，随时查阅重要内容。',
    kind: 'chip',
    entry: 'main.js',
    tools: [
      {
        name: 'read_notes',
        description: '读取已保存的笔记。',
        parameters: { type: 'object', properties: {} },
      },
    ],
  },
  dir: namespace ? '/fixture/_ns/design-team/notes' : '/fixture/notes',
  instanceKey: namespace ? '_ns__design-team__notes' : 'notes',
  namespace,
  enabled: true,
  iconDataUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><path fill="none" stroke="currentColor" stroke-width="2" d="M14 10h20v28H14zM19 18h10M19 24h10M19 30h6"/></svg>'),
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
}));
const marketItem = {
  pluginId: 'fixture-market',
  ghostId: 'calendar',
  namespace: null,
  name: '日历',
  description: '查看日程，安排每天的工作。',
  author: 'Fixture',
  scope: 'public',
  organizationId: null,
  defaultInstall: false,
  releaseId: 'fixture-release',
  version: '1.0.0',
  publishedAt: '',
  icon: null,
  installState: 'not-installed',
  enabled: null,
  sourceType: 'server',
  sourceMarketName: null,
};
const manifest = {
  schemaVersion: 3,
  minCindyVersion: '0.1.61',
  id: 'calendar',
  name: '日历',
  description: '查看日程，安排每天的工作。',
  version: '1.0.0',
  kind: 'chip',
  entry: 'main.js',
  network: { hosts: ['calendar.example.test'] },
};
const skillInventories = new Map(
  devices.map((device, index) => [
    device.deviceId,
    [
      {
        id: 'global-summary',
        revision: 'r1',
        name: '工作摘要',
        description: '整理当天进展，生成清晰的工作记录。',
        kind: 'skill',
        scope: 'global',
        engines: ['Codex', 'Claude Code'],
        enabled: true,
        managedByPlugin: false,
        builtIn: false,
        canUninstall: true,
        version: index ? '3.0.0' : '1.0.0',
        market: { name: 'daily-summary', catalogScope: 'market' },
      },
      {
        id: 'project-summary',
        revision: 'r1',
        name: '工作摘要',
        description: '按项目约定整理资料与交付记录。',
        kind: 'skill',
        scope: 'project',
        project: 'Cindy',
        engines: ['Codex'],
        enabled: false,
        managedByPlugin: false,
        builtIn: false,
        canUninstall: true,
        version: '2.0.0',
        market: { name: 'daily-summary', catalogScope: 'team' },
      },
    ],
  ]),
);
const skillMarket = {
  name: 'meeting-notes',
  displayName: '会议记录',
  description: '从会议内容整理决策与下一步工作。',
  version: '1.0.0',
  catalogScope: 'market',
};
const skillOperations = new Map<string, { receipt: any; request: any; device: string }>();
let nativeFixtureConfirm: (facts: any) => Promise<boolean> = async () => false;
const operations = new Map<string, any>();
const inventories = new Map(
  devices.map((device) => [
    device.deviceId,
    structuredClone(ghosts).map((g) => ({
      ...g,
      manifest: {
        ...g.manifest,
        version:
          device.deviceId === 'fixture-build' && g.namespace === null
            ? '3.0.0'
            : g.manifest.version,
      },
    })),
  ]),
);
const projectInventories = new Map(devices.map((device, index) => [device.deviceId,
  query.has('no-projects') ? [] : [
    { id: device.deviceId + '-cindy', name: 'Cindy' },
    { id: device.deviceId + '-other', name: index ? '发布工具' : '设计素材' },
  ],
]));
const projectPolicies = new Map<string, { revision: number; disabled: Set<string> }>();
for (const [device, projects] of projectInventories) for (const project of projects)
  projectPolicies.set(device + ':' + project.id, { revision: 1, disabled: new Set(project.id.endsWith('-other') ? ['_ns__design-team__notes'] : []) });
let connected = !offline;
const failedReads = new Set<string>();
const statusListeners = new Set<(value: unknown) => void>();
function disconnect() {
  connected = false;
  for (const listener of statusListeners) listener({ status: 'offline' });
}
const defaultApi: any = new Proxy(async () => null, {
  get: (_target, key) => (String(key).startsWith('on') ? () => () => {} : defaultApi),
});
(window as any).electronAPI = new Proxy(
  {
    ghosts: {
      ...defaultApi,
      unreadSync: () => ({ entries: [] }),
      onBadge: () => () => {},
      onUnreadSnapshot: () => () => {},
    },
    deviceLink: new Proxy(
      {
        listDevices: async () => ({ devices }),
        getState: async () => ({
          linkStatus: connected ? 'online' : 'offline',
          settings: { revokedControllers: [] },
        }),
        onStatusChanged: (listener: (value: unknown) => void) => {
          statusListeners.add(listener);
          return () => statusListeners.delete(listener);
        },
        onPresenceChanged: () => () => {},
        onControlTargetChanged: () => () => {},
        onRemotePush: () => () => {},
        pickPluginPackage: async (device: string) => {
          // Test substitute for the native file picker and peer transfer; never opens a real file.
          const accepted = await nativeFixtureConfirm({ name: 'fixture.cindy' });
          return accepted ? { attachment: 'fixture-package-' + device } : null;
        },
        confirmSkillMutation: async (device: string, id: string) => {
          const op = skillOperations.get(id)!;
          const accepted = await nativeFixtureConfirm(op.receipt.confirmation);
          const items = skillInventories.get(device)!;
          const item = items.find((item) => item.id === op.request.resourceRef?.id);
          if (accepted && op.request.input.kind === 'uninstall' && item)
            items.splice(items.indexOf(item), 1);
          if (accepted && op.request.input.kind === 'update' && item) {
            item.version = op.request.input.version;
            item.revision += '-updated';
          }
          if (accepted && op.request.input.kind === 'install')
            items.push({
              ...items[0],
              id: 'meeting-notes',
              revision: 'installed',
              name: '会议记录',
              description: skillMarket.description,
              version: skillMarket.version,
              market: { name: skillMarket.name, catalogScope: 'market' },
            });
          op.receipt = { operationId: id, phase: accepted ? 'succeeded' : 'cancelled' };
          return op.receipt;
        },
        invoke: async (_device: string, channel: string, args: any[]) => {
          const ghosts = inventories.get(_device)!;
          const request = args[0],
            input = request.input ?? {};
          if (channel.endsWith(':manifest'))
            return {
              collections: [
                { id: 'plugins', ...(query.has('old-plugins') ? {} : { actions: [{ id: 'management:snapshot' }] }) },
                ...(query.has('old')
                  ? []
                  : [{ id: 'skills', actions: [{ id: 'management:snapshot' }] }]),
              ],
            };
          if (channel.endsWith(':list') || channel.endsWith(':get')) {
            const mode = channel.endsWith(':list') ? 'list' : 'detail';
            if (query.has('fail-plugin-' + mode) && !failedReads.has(mode)) {
              failedReads.add(mode);
              throw new Error('Fixture read failure');
            }
            const items = ghosts.map((ghost) => ({
              ref: { collectionId: 'plugins', kind: 'plugin', id: ghost.instanceKey },
              revision: ghost.approval.revision,
              display: {
                title: ghost.manifest.name,
                subtitle: ghost.manifest.description,
                avatar: { kind: 'asset', value: ghost.iconDataUrl, fallbackText: 'N' },
                status: { label: ghost.enabled ? 'enabled' : 'disabled' },
              },
              actions: [{ id: ghost.enabled ? 'disable' : 'enable', label: 'Fixture action' }],
              links: [],
            }));
            if (mode === 'list') return { items: query.has('old-empty') ? [] : items };
            const index = items.findIndex((item) => item.ref.id === request.ref.id);
            const ghost = ghosts[index];
            return {
              ...items[index],
              blocks: [
                {
                  id: 'about',
                  primitive: 'markdown',
                  fallbackMarkdown: ghost.manifest.description,
                },
                { id: 'version', primitive: 'status', fallbackMarkdown: ghost.manifest.version },
                ...(query.has('missing-plugin-facts')
                  ? []
                  : [
                      {
                        id: 'capabilities',
                        primitive: 'plugin-capabilities',
                        fallbackMarkdown: '',
                        data: {
                          tools: ghost.manifest.tools,
                          permissions: [
                            { title: '访问笔记服务', description: '仅访问插件声明的笔记服务。' },
                          ],
                          details: [
                            { key: 'version', title: '版本', value: 'v' + ghost.manifest.version },
                            { key: 'author', title: '作者', value: ghost.manifest.author },
                            { key: 'identifier', title: '标识', value: ghost.manifest.id },
                          ],
                        },
                      },
                    ]),
              ],
            };
          }
          if (request.collectionId === 'skills') {
            const items = skillInventories.get(_device)!;
            let result;
            if (request.actionId === 'management:snapshot')
              result = {
                version: 1,
                items: structuredClone(items),
                market: [
                  skillMarket,
                  {
                    ...skillMarket,
                    name: 'team-meeting-notes',
                    displayName: '团队会议记录',
                    catalogScope: 'team',
                  },
                ],
                nextCursor: null,
                marketUnavailable: false,
              };
            if (request.actionId === 'management:detail') {
              const item = items.find((item) => item.id === request.resourceRef.id)!;
              result = {
                id: item.id,
                revision: item.revision,
                markdown:
                  '整理今日进展、重要决定和下一步工作。\n\n输出包括：完成内容、待处理问题、负责人和时间。',
                latest: item.market
                  ? {
                      name: item.market.name,
                      catalogScope: item.market.catalogScope,
                      displayName: item.name,
                      description: item.description,
                      version: '4.0.0',
                    }
                  : null,
              };
            }
            if (request.actionId === 'management:begin') {
              const item = items.find((item) => item.id === request.resourceRef?.id);
              const approval = ['install', 'update', 'uninstall'].includes(input.kind);
              result = {
                operationId: input.operationId,
                phase: approval ? 'confirmation' : 'succeeded',
                ...(approval
                  ? {
                      confirmation: {
                        requestId: 'fixture',
                        kind: input.kind,
                        name: item?.name ?? skillMarket.displayName,
                        version: input.version,
                      },
                    }
                  : {}),
              };
              if (item && input.kind === 'enable') {
                item.enabled = true;
                item.revision += '-enabled';
              }
              if (item && input.kind === 'disable') {
                item.enabled = false;
                item.revision += '-disabled';
              }
              skillOperations.set(input.operationId, { receipt: result, request, device: _device });
            }
            if (
              request.actionId === 'management:operation' ||
              request.actionId === 'management:cancel'
            )
              result = skillOperations.get(input.operationId)?.receipt;
            return { result, effects: [] };
          }
          let result;
          switch (request.actionId) {
            case 'management:snapshot':
              result = {
                version: 1,
                ghosts,
                ...(!query.has('old-projects') ? { projects: projectInventories.get(_device) } : {}),
                market: {
                  items: [
                    {
                      ...marketItem,
                      installState: ghosts.some((g) => g.manifest.id === 'calendar')
                        ? 'installed'
                        : 'not-installed',
                    },
                  ],
                  unavailableReason: null,
                  customSourceNames: [],
                  unavailableCustomSourceNames: [],
                },
              };
              break;
            case 'management:project-state': {
              if (query.has('project-error')) throw new Error('fixture project read failed');
              const policy = projectPolicies.get(_device + ':' + input.projectId)!;
              result = { projectId: input.projectId, revision: policy.revision.toString(16).padStart(64, '0'), disabled: [...policy.disabled] };
              break;
            }
            case 'management:market-detail':
              result = { ...marketItem, manifest };
              break;
            case 'management:begin': {
              result =
                ['install', 'install-file'].includes(input.kind)
                  ? {
                      operationId: input.operationId,
                      phase: 'confirmation',
                      consent: {
                        requestId: 'fixture-confirm',
                        initiator: 'user',
                        origin: 'market',
                        facts: {
                          kind: 'install',
                          name: '日历',
                          version: '1.0.0',
                          permissions: ghostConsentPermissionItems(manifest as any),
                        },
                      },
                    }
                  : { operationId: input.operationId, phase: 'succeeded' };
              const ghost = ghosts.find((g) => g.instanceKey === request.resourceRef?.id);
              if (input.projectId && ghost && ['enable', 'disable'].includes(input.kind)) {
                const policy = projectPolicies.get(_device + ':' + input.projectId)!;
                if (policy.revision.toString(16).padStart(64, '0') !== input.expectedProjectRevision)
                  result = { operationId: input.operationId, phase: 'failed', errorCode: 'NOT_FOUND' };
                else {
                  if (input.kind === 'disable') policy.disabled.add(ghost.instanceKey);
                  else policy.disabled.delete(ghost.instanceKey);
                  policy.revision++;
                }
              } else {
                if (ghost && input.kind === 'disable') ghost.enabled = false;
                if (ghost && input.kind === 'enable') ghost.enabled = true;
              }
              operations.set(input.operationId, result);
              break;
            }
            case 'management:operation':
              result = operations.get(input.operationId);
              break;
            case 'management:answer':
              if (input.confirmed && !ghosts.some((g) => g.manifest.id === 'calendar'))
                ghosts.push({
                  manifest: manifest as any,
                  dir: '/fixture/calendar',
                  instanceKey: 'calendar',
                  namespace: null,
                  enabled: true,
                  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' },
                });
              result = {
                operationId: input.operationId,
                phase: input.confirmed ? 'succeeded' : 'cancelled',
              };
              operations.set(input.operationId, result);
              break;
            case 'management:cancel':
              result = { operationId: input.operationId, phase: 'cancelled' };
              break;
          }
          return { effects: [], result };
        },
      },
      { get: (target, key) => (key in target ? (target as any)[key] : defaultApi[key]) },
    ),
  },
  {
    get: (target, key) =>
      key in target
        ? (target as any)[key]
        : String(key).startsWith('on')
          ? () => () => {}
          : defaultApi,
  },
);
await import('../../../src/renderer/i18n');
const { default: i18n } = await import('../../../src/renderer/i18n');
await i18n.changeLanguage('zh-CN');
await import('../../../src/renderer/themes/colors');
const { ThemeService } = await import('../../../src/renderer/themes/theme-service');
const { defaultLight } = await import('../../../src/renderer/themes/builtin/default-light');
const { defaultDark } = await import('../../../src/renderer/themes/builtin/default-dark');
new ThemeService().applyTheme(dark ? defaultDark : defaultLight);
document.documentElement.classList.toggle('dark', dark);
const { setDataOwnerGeneration } =
  await import('../../../src/renderer/contexts/dataOwnerGeneration');
setDataOwnerGeneration('fixture-owner');
const { ConfirmDialogProvider } =
  await import('../../../src/renderer/components/ui/confirm-dialog-provider');
const { RemoteSkillsPage } =
  await import('../../../src/renderer/features/skillhub/RemoteSkillsPage');
const { useConfirmDialog } =
  await import('../../../src/renderer/components/ui/confirm-dialog-provider');
const { RemotePluginPage } = await import('../../../src/renderer/features/plugin/RemotePluginPage');
const { usePluginDeviceDirectory } =
  await import('../../../src/renderer/features/plugin/PluginDevicePicker');
function FixtureContent() {
  const { confirm } = useConfirmDialog();
  nativeFixtureConfirm = (facts) =>
    confirm({
      title: `测试确认：${facts.name}`,
      description: '隔离测试数据 · 实际产品使用当前电脑的原生确认框。',
      confirmText: '确认',
      cancelText: '取消',
    });
  const [tab, setTab] = useState<'plugins' | 'skills'>(query.has('skills') ? 'skills' : 'plugins');
  const [device, setDevice] = useState({ deviceId: 'fixture-design', name: '设计电脑' });
  const directory = usePluginDeviceDirectory(device);
  const reachable = directory.online;
  return (
    <>
      <div
        style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface)',
        }}
      >
        <div
          style={{
            padding: '10px 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            生产组件 · 隔离测试数据 · {dark ? 'Dark' : 'Light'}
          </span>
          <button onClick={disconnect} style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            断开测试连接
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {tab === 'plugins' ? (
            <RemotePluginPage
              key={device.deviceId}
              device={device}
              online={reachable}
              deviceControl={{
                  selected: device,
                  directory,
                  onSelect: (next) => {
                    if (next) setDevice(next);
                  },
              }}
              onSelectCatalogTab={setTab}
            />
          ) : (
            <RemoteSkillsPage
              key={device.deviceId}
              device={device}
              online={reachable}
              deviceControl={{
                  selected: device,
                  directory,
                  onSelect: (next) => {
                    if (next) setDevice(next);
                  },
              }}
              onSelectCatalogTab={setTab}
            />
          )}
        </div>
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <ConfirmDialogProvider>
      <FixtureContent />
    </ConfirmDialogProvider>
  </MemoryRouter>,
);
