/** Manual UI demo only: all package, account and device data stays in this window. */
import { useState, useSyncExternalStore } from 'react';
import { Button } from '../../../src/renderer/components/ui/button';
import { GhostPluginDetailView } from '../../../src/renderer/features/plugin/GhostPluginDetailView';
import { toGhostPluginDetail } from '../../../src/renderer/features/plugin/lib/ghostPluginViewModel';
import { LocalPluginShareView } from '../../../src/renderer/features/plugin/LocalPluginShareView';
import { GhostInstallConsentHost } from '../../../src/renderer/cindy-brain/GhostInstallConsentHost';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';
import { toast } from '../../../src/renderer/lib/toast';
import { createIpcError } from '../../../src/shared/ipc-errors';
import type { InstalledGhost } from '../../../src/shared/ghost';
import type { LocalPluginShareSnapshot } from '@cindy/plugin-protocol';
import { REMOTE_RESOURCE_MANIFEST_CHANNEL } from '@cindy/device-link';
import { subscription } from '../../ui-page/harness';
import type { UiPageRuntime } from '../../ui-page/harness/types';

const demoWindow = window as typeof window & { __localShareDemoSignedIn?: boolean };
const change = () => window.dispatchEvent(new Event('local-share-demo-change'));
const subscribe = (notify: () => void) => {
  window.addEventListener('local-share-demo-change', notify);
  return () => window.removeEventListener('local-share-demo-change', notify);
};
const plugin = (version: string, publicPlugin = false): InstalledGhost => ({
  manifest: { schemaVersion: 3, id: publicPlugin ? 'public-share-demo' : 'local-share-demo',
    name: publicPlugin ? '公共插件示例' : '本地笔记助手', version: publicPlugin ? '2.3.0' : version, kind: 'chip', entry: 'index.js',
    description: '整理笔记并生成摘要。此插件仅用于分享界面演示，所有操作均为模拟数据。',
    author: 'Demo Author', network: { hosts: ['api.example.test'] } },
  dir: '/fixture/local-share-demo', enabled: true, namespace: null, namespaceState: 'confirmed',
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  ...(publicPlugin ? {} : { publishingSource: { kind: 'local' as const, source: 'manual' as const } }),
});
const shares = new Map<string, LocalPluginShareSnapshot>();
const operations = new Map<string, LocalPluginShareSnapshot>();
const uploadedVersions = new Set<string>();
let sequence = 0;
const devices = [
  { deviceId: 'demo-online', name: '工作电脑', online: true },
  { deviceId: 'demo-offline', name: '离线电脑', online: false },
  { deviceId: 'demo-old', name: '旧版电脑', online: true },
].map(device => ({ ...device, platform: 'darwin', appVersion: '0.1.200', lastSeenAt: null,
  busy: false, isSelf: false, controlEnabled: true, remoteControlEnabled: true }));
const receipts = new Map<string, Record<string, unknown>>();
const pending = new Map<string, (confirmed: boolean) => void>();
const facts = (snapshot: LocalPluginShareSnapshot) => ({ kind: 'install', ghostId: snapshot.ghostId,
  name: snapshot.name, version: snapshot.version,
  permissions: [{ key: 'network:host:api.example.test', kind: 'network', labelKey: 'networkHost', labelArgs: { host: 'api.example.test' } }],
});
function material(snapshot: LocalPluginShareSnapshot, includeAttribution: boolean) {
  return { title: snapshot.name, url: `https://share.example.test/s/${snapshot.snapshotId}`,
    imageSvg: `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><rect width="1080" height="1080" fill="#f4f3ef"/><text x="72" y="128" fill="#555" font-size="28">Cindy · 分享演示</text><text x="72" y="310" fill="#222" font-size="64">${snapshot.name}</text><text x="72" y="410" fill="#555" font-size="40">v${snapshot.version}</text><text x="72" y="860" fill="#555" font-size="28">${includeAttribution ? '演示用户分享' : '插件分享'}</text></svg>`,
    ...(includeAttribution ? { attribution: { displayName: '演示用户' } } : {}) };
}
const snapshotFor = (version: string, id: string): LocalPluginShareSnapshot => ({
  schemaVersion: 1, snapshotId: id, ghostId: 'local-share-demo', name: '本地笔记助手', version,
  description: '这是分享时固定的插件版本。切换本地版本或再次分享，不会改变此记录。', author: 'Demo Author',
  sha256: version === '1.0.0' ? 'a'.repeat(64) : 'b'.repeat(64), sizeBytes: 4096,
  createdAt: '2026-10-28T00:00:00.000Z', icon: null,
});
shares.set('a'.repeat(32), snapshotFor('1.0.0', 'a'.repeat(32)));

export const interactiveHost = {
  ghosts: {
    listSync: () => ({ ghosts: [plugin('1.0.0')] }), onChanged: subscription('ghosts-changed'),
    listBackgroundTasks: async () => ({ items: [] }),
    usageSummary: async () => ({ subjectId: 'demo', recordingStartedAt: Date.now(), lastUsedAt: null,
      callsLast7Days: 0, totalCalls: 0, until: Date.now(), deviceName: '演示电脑', recentTasks: [] }),
    onInstallConsentRequest: subscription('consent'), onInstallConsentDismissed: subscription('dismissed'),
    resolveInstallConsent: async (requestId: string, confirmed: boolean) => {
      pending.get(requestId)?.(confirmed); pending.delete(requestId); return { handled: true };
    },
  },
  pluginMarket: {
    releaseLocalShare: async () => {},
    prepareLocalShare: async (_instance: string, id: string, options: { includeAttribution: boolean }, binding: { version: string }, confirmed: boolean) => {
      if (!confirmed && !uploadedVersions.has(binding.version)) return { confirmationRequired: true as const };
      uploadedVersions.add(binding.version);
      if (!operations.has(id)) {
        const snapshot = snapshotFor(binding.version, String(++sequence).padStart(32, '0'));
        shares.set(snapshot.snapshotId, snapshot); operations.set(id, snapshot); change();
      }
      return material(operations.get(id)!, options.includeAttribution);
    },
    prepareShare: async (_id: string, options: { includeAttribution: boolean }) =>
      material({ ...snapshotFor('2.3.0', 'p'.repeat(32)), name: '公共插件示例' }, options.includeAttribution),
    localShareDetail: async (id: string) => shares.get(id)!,
    installLocalShare: async (_id: string, snapshot: LocalPluginShareSnapshot) => {
      const requestId = `local-demo-${snapshot.snapshotId}`;
      const confirmed = await new Promise<boolean>(resolve => {
        pending.set(requestId, resolve);
        (window as unknown as { __uiPage: UiPageRuntime }).__uiPage.emit!('consent', {
          requestId, initiator: 'user', origin: 'local-file', facts: facts(snapshot),
        });
      });
      if (!confirmed) throw createIpcError('MUTATION_CANCELLED', 'Demo consent declined');
      return { ghost: plugin(snapshot.version) };
    },
  },
  deviceLink: { invoke: async (device: string, channel: string, [request]: [{ actionId: string; input: Record<string, any> }]) => {
    if (channel === REMOTE_RESOURCE_MANIFEST_CHANNEL) return { collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot' }] }] };
    if (request.actionId === 'management:snapshot') return { effects: [], result: { version: 1, ghosts: [], market: { items: [], customSourceNames: [], unavailableCustomSourceNames: [] }, localShares: device !== 'demo-old' } };
    const id = request.input.operationId;
    if (request.actionId === 'management:begin') receipts.set(id, { operationId: id, phase: 'confirmation', consent: {
      requestId: `consent-${id}`, initiator: 'user', origin: 'local-file', facts: facts(request.input.expectedSnapshot),
    } });
    if (request.actionId === 'management:answer' || request.actionId === 'management:cancel')
      receipts.set(id, { operationId: id, phase: request.input.confirmed ? 'succeeded' : 'cancelled' });
    return { effects: [], result: receipts.get(id) };
  } },
  copyTextToClipboard: async () => { toast.info('已模拟复制动作，可在上方“打开分享记录”中查看接收页。'); },
  copyPngToClipboard: async () => { toast.info('模拟复制图片完成。'); },
  saveMediaAs: async () => ({ canceled: true }),
};

export function InteractivePreview() {
  useSyncExternalStore(subscribe, () => `${sequence}:${demoWindow.__localShareDemoSignedIn !== false}`);
  const [version, setVersion] = useState('1.0.0');
  const [page, setPage] = useState('local');
  const [selected, setSelected] = useState<(typeof devices)[number] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const ghost = plugin(version, page === 'public');
  const explain = () => toast.info('这是演示数据，不会修改真实插件。');
  return <div className="flex h-screen flex-col bg-[var(--surface)] text-[var(--text-primary)]">
    <aside className="shrink-0 space-y-3 border-b border-[var(--border-default)] p-4">
      <p className="text-13 text-[var(--text-secondary)]">分享交互演示 · 模拟账号与包，不会真实上传或安装</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setPage('local')}>本地插件</Button>
        <Button variant="secondary" onClick={() => setPage('public')}>公共插件</Button>
        <label className="text-13">本地版本 <select aria-label="本地版本" value={version} onChange={event => { setVersion(event.target.value); setPage('local'); }}>
          <option>1.0.0</option><option>1.1.0</option>
        </select></label>
        <Button variant="secondary" onClick={() => { demoWindow.__localShareDemoSignedIn = demoWindow.__localShareDemoSignedIn === false; change(); }}>
          {demoWindow.__localShareDemoSignedIn === false ? '模拟登录' : '模拟退出登录'}
        </Button>
        <label className="text-13">打开分享记录 <select aria-label="打开分享记录" value={shares.has(page) ? page : ''} onChange={event => setPage(event.target.value)}>
          <option value="" disabled>选择分享</option>
          {[...shares.values()].map((item, index) => <option key={item.snapshotId} value={item.snapshotId}>分享 {index + 1} · v{item.version}</option>)}
        </select></label>
      </div>
    </aside>
    <div className="min-h-0 flex-1">
      {shares.has(page) ? <LocalPluginShareView key={`${page}:${selected?.deviceId ?? 'local'}`} snapshotId={page}
        onBack={() => setPage('local')} onInstalled={() => toast.success(`模拟安装成功：${selected?.name ?? '本机'}`)}
        deviceControl={{ selected, onSelect: next => setSelected(devices.find(item => item.deviceId === next?.deviceId) ?? null),
          directory: { candidates: devices, target: selected ?? undefined, online: !selected || selected.online, relayOnline: true } }} />
        : <GhostPluginDetailView key={`${page}:${version}`} ghost={ghost} detail={toGhostPluginDetail(ghost)}
          sharePluginId={page === 'public' ? 'public-demo' : undefined} panelStatus={null} enabledOverride={enabled}
          onToggle={setEnabled} onBack={() => setPage('local')} onUse={explain} onUpdate={explain}
          onUpdateFromFile={explain} onUninstall={explain} toggleDisabled={false} />}
    </div>
    <GhostInstallConsentHost /><ToastContainer />
  </div>;
}
