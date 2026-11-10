// Controlled performance specimen: real theme, shared surfaces, background hook
// and sidebar geometry hook; synthetic rows isolate composition from agent work.
import { useLayoutEffect, useRef, useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { useWallpaperBackground } from '../../../src/renderer/hooks/useWallpaperBackground';
import { useSidebarMaterial } from '../../../src/renderer/hooks/useSidebarMaterial';
import { SettingsCard, SettingsRow } from '../../../src/renderer/components/ui/settings-rows';

type Config = { visibility: number; blur: number };
declare global {
  interface Window {
    perfBridge: { width: (width: number) => void };
    perfConfigure: (config: Config) => Promise<void>;
    perfWorkload: (kind: string, duration: number) => Promise<number[]>;
  }
}

function Specimen() {
  const [config, setConfig] = useState<Config>({ visibility: 0, blur: 0 });
  const sidebar = useRef<HTMLElement>(null);
  useSidebarMaterial(sidebar);
  useWallpaperBackground({ background: undefined, desktopBackground: true,
    ...config, reducedMotion: true });
  useLayoutEffect(() => {
    window.perfConfigure = next => new Promise(resolve => {
      setConfig(next);
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    window.perfWorkload = (kind, duration) => new Promise(resolve => {
      if (kind === 'idle' || kind === 'behind') {
        setTimeout(() => resolve([]), duration);
        return;
      }
      const scroller = document.querySelector<HTMLElement>('[data-perf-scroll]')!;
      const intervals: number[] = [];
      let start = 0, previous = 0;
      const tick = (now: number) => {
        if (!start) start = now;
        if (previous) intervals.push(now - previous);
        previous = now;
        if (kind === 'scroll') scroller.scrollTop = (now - start) * 0.6;
        if (now - start < duration) requestAnimationFrame(tick);
        else resolve(intervals);
      };
      scroller.scrollTop = 0;
      requestAnimationFrame(tick);
    });
  }, []);
  return <div className="flex h-screen text-[var(--text-primary)]">
    <aside ref={sidebar} className="bg-sidebar relative flex shrink-0 flex-col p-4" style={{ width: 260 }}>
      <div className="sidebar-frost pointer-events-none absolute inset-0" />
      <div className="relative">Cindy · 性能测试样本<br />独立窗口，不修改你的设置</div>
    </aside>
    <main className="bg-content-area min-w-0 flex-1 overflow-auto p-6" data-perf-scroll>
      <div className="flex flex-col gap-4">
        {Array.from({ length: 100 }, (_, index) => <SettingsCard key={index}>
          <SettingsRow title={`样本 ${index + 1} · Background composition`}
            hint="保持文字清晰；卡片复用主题色与透明度保护。This content is synthetic, using production surfaces." />
          <div className="m-4 rounded-xl bg-[var(--msg-user-bg)] p-4">输入框、消息与卡片保持各自的材质规则。</div>
        </SettingsCard>)}
      </div>
    </main>
  </div>;
}

void mountPage({
  host: { theme: { setSidebarWidth: (width: number) => window.perfBridge.width(width) } },
  render: () => <Specimen />,
});
