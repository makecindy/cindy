// Real component graph, synthetic props, no preload or live backend.
import React, { useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'harmonyos-sans-sc-webfont-splitted';
import '../../src/renderer/themes/colors';
import { themeService } from '../../src/renderer/themes/theme-service';
import { cindyLight } from '../../src/renderer/themes/builtin/cindy-light';
import { cindyDark } from '../../src/renderer/themes/builtin/cindy-dark';
import common from '../../src/renderer/i18n/locales/en/common.json';
import '../../src/renderer/styles/globals.css';

const options = Object.fromEntries(new URLSearchParams(location.search));
const stats = window.ax5406Stats = { mutations: 0, commits: 0, errors: [], component: 'MessageStream', renderedRows: 0 };
addEventListener('error', event => stats.errors.push(String(event.error?.stack || event.message)));
addEventListener('unhandledrejection', event => stats.errors.push(String(event.reason?.stack || event.reason)));
// No recursive proxy: missing IPC capabilities remain missing, not silently successful.
let accessibilityEnabled = options.accessibility === 'on';
const accessibilityListeners = new Set();
window.ax5406Accessibility = enabled => {
  accessibilityEnabled = enabled;
  accessibilityListeners.forEach(callback => callback(enabled));
};
window.electronAPI = { platform: 'win32', logToMain() {}, accessibilitySupport: {
  getSync: () => accessibilityEnabled,
  onChanged(callback) { accessibilityListeners.add(callback); callback(accessibilityEnabled); return () => accessibilityListeners.delete(callback); },
} };
document.documentElement.lang = 'en';
themeService.applyTheme(cindyLight);
const { applyFontSettings, getInitialFontSettings } = await import('../../src/renderer/hooks/useFontSettings');
applyFontSettings(getInitialFontSettings());
await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', defaultNS: 'common', resources: { en: { common } }, interpolation: { escapeValue: false } });
const { MessageStream } = await import('../../src/renderer/components/chat/MessageStream');
const { ConfirmDialogProvider } = await import('../../src/renderer/components/ui/confirm-dialog-provider');
const { Tooltip } = await import('../../src/renderer/components/ui/tooltip');
if (options.containment === 'off') {
  const style = document.createElement('style');
  style.textContent = '.msg-stream-items > * { content-visibility: visible !important; contain-intrinsic-size: none !important; }';
  document.head.append(style);
}
let seed = Number(options.seed) || 5406;
function random() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; }
function text(index, step) {
  return `Synthetic row ${index}, update ${step}.\n\n` +
    ('Ordinary text with **bold text** and *inline emphasis* for wrapping. 中文无障碍文本布局。 '.repeat(3 + Math.floor(random() * 12))) +
    '\n\n' + 'Pending streaming text '.repeat(2 + step % 12);
}
function Fixture() {
  const [generation, setGeneration] = useState(0);
  const [focusId, setFocusId] = useState();
  const [sessionStreaming, setSessionStreaming] = useState(true);
  const [messages, setMessages] = useState(() => Array.from({ length: Number(options.rows) || 80 }, (_, i) => ({
    clientId: `synthetic-${i}`, role: i % 2 ? 'assistant' : 'user', content: text(i, 0),
    isStreaming: options.workload === 'visual' ? i === Number(options.rows) - 1 : i % 2 === 1,
  })));
  useLayoutEffect(() => {
    stats.commits++;
    const items = document.querySelector('.msg-stream-items');
    stats.renderedRows = items?.children.length || 0;
    stats.mountedBodies = items ? items.querySelectorAll(':scope > :not([data-message-placeholder])').length : 0;
    stats.containment = items?.firstElementChild ? getComputedStyle(items.firstElementChild).contentVisibility : null;
    const scroller = document.querySelector('[data-scroll-container]');
    stats.layout = { display: items ? getComputedStyle(items).display : null,
      gap: items ? getComputedStyle(items).rowGap : null,
      overflowY: scroller ? getComputedStyle(scroller).overflowY : null,
      height: scroller?.clientHeight, scrollHeight: scroller?.scrollHeight,
      fontFamily: getComputedStyle(document.body).fontFamily };
    stats.domTextLength = items?.textContent.length || 0;
    // Verify the experiment's actual computed row styles on every commit, before AX work.
    // All compared policies run these same reads. This is diagnostic overhead.
    if (options.policy && options.policy !== 'production') {
      const activeIds = new Set(messages.filter(m => m.isStreaming).map(m => m.clientId));
      const counts = { auto: 0, visible: 0, activeAuto: 0 };
      for (const row of items?.children || []) {
        const visibility = getComputedStyle(row).contentVisibility;
        counts[visibility] = (counts[visibility] || 0) + 1;
        if (visibility === 'auto' && activeIds.has(row.dataset.messageClientId)) counts.activeAuto++;
      }
      stats.policy = options.policy;
      stats.rowStyles = counts;
      stats.maxActiveAuto = Math.max(stats.maxActiveAuto || 0, counts.activeAuto);
      stats.activeCommits = (stats.activeCommits || 0) + Number(activeIds.size > 0);
      stats.settledCommits = (stats.settledCommits || 0) + Number(activeIds.size === 0);
    }
  });
  useEffect(() => {
    if (options.workload === 'visual') {
      window.ax5406Visual = {
        streamStart() {
          setSessionStreaming(true);
          setMessages(previous => previous.map((m, i) => i === previous.length - 1
            ? { ...m, content: '', isStreaming: true } : { ...m, isStreaming: false }));
          stats.mutations++;
        },
        streamChunk(chunk) {
          setMessages(previous => previous.map((m, i) => i === previous.length - 1
            ? { ...m, content: m.content + chunk } : m));
          stats.mutations++;
        },
        streamFinish() {
          setMessages(previous => previous.map(m => ({ ...m, isStreaming: false })));
          setSessionStreaming(false);
          stats.mutations++;
        },
        theme(dark) { themeService.applyTheme(dark ? cindyDark : cindyLight); },
        remount() { setGeneration(value => value + 1); },
        focus(id) { setFocusId(id); },
        grow(id) { setMessages(previous => previous.map(m => m.clientId === id
          ? { ...m, content: m.content + '\n\n' + 'Asynchronously added content. '.repeat(150) } : m)); stats.mutations++; },
        image(id) {
          const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 320;
          const context = canvas.getContext('2d'); context.fillStyle = '#3b82f6'; context.fillRect(0, 0, 640, 320);
          context.fillStyle = 'white'; context.font = '32px sans-serif'; context.fillText('Async image fixture', 40, 160);
          const base64 = canvas.toDataURL('image/png').split(',')[1];
          setMessages(previous => previous.map(m => m.clientId === id
            ? { ...m, images: [{ base64, mimeType: 'image/png', originalName: 'fixture.png' }] } : m)); stats.mutations++;
        },
        append() { setMessages(previous => [...previous.map(m => ({ ...m, isStreaming: false })),
          { clientId: `synthetic-${previous.length}`, role: 'user', content: 'A new user message.' },
          { clientId: `synthetic-${previous.length + 1}`, role: 'assistant', content: 'A new streaming reply.', isStreaming: true }]); stats.mutations++; },
      };
      return () => { delete window.ax5406Visual; };
    }
    let frame, step = 0;
    function tick() {
      step++;
      setMessages(previous => {
        const active = options.workload !== 'cycle' || step % 120 < 90;
        const next = options.workload === 'cycle'
          ? previous.map(m => ({ ...m, isStreaming: active && m.role === 'assistant' }))
          : [...previous];
        for (let n = 0; active && n < Number(options.batch || 1); n++) {
          let index = Math.floor(random() * next.length);
          if (options.target === 'tail') index = next.length - 1;
          else if (options.target === 'assistant') index = Math.min(next.length - 1, index | 1);
          else if (options.target === 'user') index &= ~1;
          next[index] = { ...next[index], content: text(index, step) };
          stats.mutations++;
        }
        return next;
      });
      if (options.scroll !== 'off' && step % 12 === 0) {
        const scroller = document.querySelector('[data-scroll-container]');
        if (scroller) scroller.scrollTop = random() * scroller.scrollHeight;
      }
      frame = requestAnimationFrame(tick);
    }
    // Allow initial render and native AX tree registration before changing props.
    const timer = setTimeout(() => { frame = requestAnimationFrame(tick); }, 1200);
    return () => { clearTimeout(timer); cancelAnimationFrame(frame); };
  }, []);
  const base = '.msg-stream-items > * { content-visibility: auto !important; contain-intrinsic-size: auto 240px !important; }';
  const activeSelectors = messages.filter(m => m.isStreaming).map(m =>
    `.msg-stream-items > [data-message-client-id="${m.clientId}"]`);
  const override = options.policy === 'active' && activeSelectors.length
    ? `${activeSelectors.join(',')} { content-visibility: visible !important; contain-intrinsic-size: none !important; }` : '';
  return <>{['auto', 'active'].includes(options.policy) && <style>{base + override}</style>}
    <MessageStream key={generation} workingDir="" messages={messages} historyLoaded hasMoreMessages={false}
      focusMessageClientId={focusId} isSessionStreaming={sessionStreaming} contentWidth={880} /></>;
}
createRoot(document.getElementById('root')).render(<MemoryRouter><ConfirmDialogProvider><Tooltip.Provider><Fixture /></Tooltip.Provider></ConfirmDialogProvider></MemoryRouter>);
