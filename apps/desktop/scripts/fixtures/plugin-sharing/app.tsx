/** The review canvas imports production components unchanged. Only host/data calls are fixtures. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'harmonyos-sans-sc-webfont-splitted';
import '@/styles/globals.css';
import '@/themes/colors';
import { themeService } from '@/themes/theme-service';
import { defaultLight } from '@/themes/builtin/default-light';
import { defaultDark } from '@/themes/builtin/default-dark';
import { cindyLight } from '@/themes/builtin/cindy-light';
import { cindyDark } from '@/themes/builtin/cindy-dark';
import zh from '@/i18n/locales/zh-CN/common.json';
import en from '@/i18n/locales/en/common.json';
import { MarketPluginDetailView } from '@/features/plugin/MarketPluginDetailView';
import { GhostPluginDetailView } from '@/features/plugin/GhostPluginDetailView';
import { toGhostPluginDetail } from '@/features/plugin/lib/ghostPluginViewModel';
import '@/features/plugin/plugin-motion.css';
import { ToastContainer } from '@/components/ui/toast/ToastContainer';
import { toast } from '@/lib/toast';
import type { PluginMarketDetail } from '../../../src/shared/pluginMarket';
import type { GhostManifest, InstalledGhost } from '../../../src/shared/ghost';
import type { ShareOptions } from '../../../src/shared/share';

const q = new URLSearchParams(location.search);
const english = q.get('region') === 'global';
const themes = { light: defaultLight, dark: defaultDark, 'cindy-light': cindyLight, 'cindy-dark': cindyDark };
themeService.applyTheme(themes[q.get('theme') as keyof typeof themes] ?? defaultLight);
document.documentElement.dataset.platform = 'mac';
await i18next.use(initReactI18next).init({ lng: english ? 'en' : 'zh-CN', resources: { 'zh-CN': { translation: zh }, en: { translation: en } }, interpolation: { escapeValue: false } });
const fixture = await fetch('/share/fixture.json').then((r) => r.json());
const manifest: GhostManifest = { ...fixture.manifest, ...(english ? fixture.en : fixture.zh) };
const scenario = q.get('state') ?? 'ready';
let attempt = 0;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const failOperation = () => { if (scenario === 'copy-failed') throw new Error('Local preview clipboard failure'); };
window.electronAPI = {
  platform: 'darwin',
  getFullscreenState: async () => false,
  onFullscreenChange: () => () => {},
  pluginMarket: {
    prepareShare: async (_id: string, options: ShareOptions) => {
      if (scenario === 'loading') await delay(120_000);
      else await delay(500);
      const code = scenario === 'not-configured' ? 'SHARE_NOT_CONFIGURED' : scenario === 'unavailable' ? 'SHARE_UNAVAILABLE' : scenario === 'failed' || (scenario === 'retry' && attempt++ === 0) ? 'SHARE_TEMPORARILY_UNAVAILABLE' : null;
      if (code) throw new Error(`[${code}] Local preview scenario`);
      const signed = options.includeAttribution && q.get('account') !== 'anonymous';
      const realm = english ? 'global' : 'cn';
      const response = await fetch('/share/api/shares', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(signed ? { Authorization: `Bearer ${scenario === 'profile-unavailable' ? 'fixture-profile-unavailable' : `fixture-${realm}`}` } : {}) },
        body: JSON.stringify({ kind: 'plugin', reference: fixture.ids.ready, includeAttribution: signed, region: realm, lang: english ? 'en' : 'zh-CN', ...(signed ? { authRealm: realm } : {}) }),
      });
      if (!response.ok) throw new Error('Local preview unavailable');
      const data = await response.json();
      return { title: data.plugin.name, url: data.url, imageSvg: data.imageSvg, ...(data.attribution ? { attribution: { displayName: data.attribution.displayName } } : {}) };
    },
  },
  copyTextToClipboard: async ({ text }: { text: string }) => { failOperation(); await navigator.clipboard.writeText(text); },
  copyPngToClipboard: async ({ png }: { png: ArrayBuffer }) => { failOperation(); await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]); },
  saveMediaAs: async ({ url }: { url: string }) => {
    if (scenario === 'save-canceled') return { canceled: true };
    if (scenario === 'save-failed') throw new Error('Local preview save failure');
    const link = document.createElement('a'); link.href = url; link.download = 'cindy-plugin-share.png'; link.click();
    return { canceled: false };
  },
} as unknown as typeof window.electronAPI;

const market: PluginMarketDetail = { pluginId: fixture.ids.ready, ghostId: manifest.id, namespace: null, name: manifest.name, description: manifest.description ?? null, author: manifest.author ?? null, version: manifest.version, manifest, scope: 'public', organizationId: null, defaultInstall: false, releaseId: 'preview-release', publishedAt: fixture.publishedAt, icon: null, enabled: null, installState: 'not-installed', sourceType: 'server', sourceMarketName: null };
const ghost = { manifest, dir: null, enabled: true, approval: { state: 'approved' }, namespace: null, namespaceState: 'confirmed', instanceKey: manifest.id, iconDataUrl: fixture.iconDataUrl, trust: { level: 'cindy-official', publisherSigned: true, publisherVerified: true, reviewed: true, publisherName: 'Cindy Plugin Market' } } as unknown as InstalledGhost;
function App() {
  const [enabled, setEnabled] = useState(true);
  const explain = () => toast.info(english ? 'Preview only. No plugin will be installed or changed.' : '此处仅演示界面，不会安装或修改插件。');
  return <>
    {q.get('view') === 'installed' ? <GhostPluginDetailView ghost={ghost} sharePluginId={fixture.ids.ready} detail={toGhostPluginDetail(ghost)} panelStatus={null} enabledOverride={enabled} onToggle={setEnabled} onBack={explain} onUse={explain} onUpdate={explain} onUpdateFromFile={explain} onUninstall={explain} onExport={explain} toggleDisabled={false} /> : <MarketPluginDetailView detail={market} busy={false} onBack={explain} onInstall={explain} onIconLoadError={() => {}} />}
    <ToastContainer />
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);
