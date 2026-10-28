import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Download, Pencil, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { ScrollCapture } from '../../../shared/scrollCapture';
import type { RegionCaptureBegin } from '../../../shared/regionCapture';
import type { RegionScreenshotBitmap } from '../../../shared/regionScreenshot';
import { bitmapToImageData, type RegionScreenshotOverlayBridge } from './bridge';

/** The selection stays over the source app; only its thumbnail/actions take input. */
export function ScrollCaptureOverlay({ begin, token, bridge, onEdit }: {
  begin: RegionCaptureBegin;
  token: string;
  bridge: RegionScreenshotOverlayBridge;
  onEdit(image: RegionScreenshotBitmap): Promise<void>;
}) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const sourceCanvas = useRef<HTMLCanvasElement | null>(null);
  const paintedRange = useRef({ start: -1, end: -1 });
  const scrollPaint = useRef(0);
  const growthFrame = useRef(0);
  const followGrowth = useRef(true);
  const previousHeight = useRef(begin.first.height);
  const reducedMotion = useReducedMotion();
  const followEdge = useRef<'start' | 'end'>('start');
  const runtime = useRef({ active: true, finishing: false, capture: new ScrollCapture(begin.first), pending: null as Promise<void> | null, automatic: false, stillFrames: 0, unmatchedSince: 0, movingUntil: 0 });
  const [height, setHeight] = useState(begin.first.height);
  const [automatic, setAutomatic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('scrollHint');
  const [error, setError] = useState('');
  const layout = begin.scrollLayout!;
  const ratio = layout.preview.width / begin.first.width;
  const previewHeight = Math.min(layout.preview.height, Math.ceil(height * ratio));
  const initialPreviewHeight = Math.min(layout.preview.height, Math.ceil(begin.first.height * ratio));

  function paintRange(destination = preview.current?.scrollTop ?? 0, force = false) {
    const target = canvas.current;
    const view = preview.current;
    if (!target || !view) return;
    const capture = runtime.current.capture;
    const visibleRows = Math.ceil(layout.preview.height / ratio);
    const current = Math.floor(view.scrollTop / ratio);
    const next = Math.floor(destination / ratio);
    const previous = paintedRange.current;
    if (!force && current >= previous.start && Math.min(capture.height, current + visibleRows) <= previous.end) return;
    // Buffer the current and destination viewports so native smooth scrolling
    // moves existing pixels. Never allocate/convert the entire growing image.
    const start = Math.max(0, Math.min(current, next) - Math.ceil(visibleRows / 2));
    const end = Math.min(capture.height, Math.max(current, next) + visibleRows * 2);
    const image = capture.image(start, end - start);
    const source = sourceCanvas.current ??= document.createElement('canvas');
    source.width = image.width; source.height = image.height;
    source.getContext('2d')!.putImageData(bitmapToImageData(image), 0, 0);
    const density = Math.min(2, window.devicePixelRatio || 1);
    target.width = Math.max(1, Math.round(image.width * ratio * density));
    target.height = Math.max(1, Math.round(image.height * ratio * density));
    target.style.top = `${start * ratio}px`;
    target.style.height = `${image.height * ratio}px`;
    target.getContext('2d')!.drawImage(source, 0, 0, target.width, target.height);
    paintedRange.current = { start, end };
  }

  useLayoutEffect(() => {
    const view = preview.current;
    const container = panel.current;
    if (!view || !container) return;
    cancelAnimationFrame(growthFrame.current);
    followGrowth.current = true;
    const fromHeight = container.getBoundingClientRect().height;
    // Prepending rebases every existing pixel. Compensate before painting so
    // the old content stays still while the new strip is revealed above it.
    const prepend = followEdge.current === 'start' ? (height - previousHeight.current) * ratio : 0;
    previousHeight.current = height;
    view.scrollTop += prepend;
    const fromScroll = view.scrollTop;
    const destination = followEdge.current === 'end' ? Math.max(0, height * ratio - previewHeight) : 0;
    paintRange(destination, true);
    const token = getComputedStyle(container).getPropertyValue('--motion-base').trim();
    const duration = reducedMotion ? 0 : (parseFloat(token) || 0) * (token.endsWith('ms') ? 1 : 1000);
    const started = performance.now();
    // One linear timeline for growing height and following the captured edge.
    // New samples retarget from the currently displayed geometry, not the old
    // destination; independent CSS-height and native-scroll animations drift.
    const advance = (now: number) => {
      const progress = duration > 0 ? Math.min(1, (now - started) / duration) : 1;
      container.style.height = `${fromHeight + (previewHeight - fromHeight) * progress}px`;
      if (followGrowth.current) view.scrollTop = fromScroll + (destination - fromScroll) * progress;
      if (progress < 1) growthFrame.current = requestAnimationFrame(advance);
    };
    advance(started);
    return () => cancelAnimationFrame(growthFrame.current);
    // The capture layout is fixed for this session; only accepted pixels animate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, reducedMotion]);

  async function changeAutomatic(enabled: boolean) {
    const state = runtime.current;
    if (state.finishing) return;
    const accepted = await bridge.autoScroll(token, enabled);
    if (!state.active || state.finishing) return;
    state.automatic = accepted === true && enabled;
    state.stillFrames = 0;
    setAutomatic(state.automatic);
    setError(accepted === 'accessibility' ? 'autoPermission' : accepted ? '' : 'autoUnavailable');
  }

  async function sample() {
    const state = runtime.current;
    const frame = await bridge.liveFrame(token, false, panel.current?.clientHeight);
    if (!frame || !state.active || state.finishing) return;
    if (state.automatic && frame.autoScrolling === false) {
      state.automatic = false; setAutomatic(false); setError('autoUnavailable');
    }
    const match = state.capture.add(frame.image);
    if (match === 'append' || match === 'prepend') {
      followEdge.current = match === 'append' ? 'end' : 'start';
      setHeight(state.capture.height);
      state.movingUntil = performance.now() + 400;
      state.stillFrames = 0; state.unmatchedSince = 0; setStatus('scrollHint'); setError('');
    } else if (match === 'unmatched') {
      state.unmatchedSince ||= performance.now();
      if (performance.now() - state.unmatchedSince > 1500) {
        if (state.capture.height > begin.first.height) setStatus('overlap');
        if (state.automatic) await changeAutomatic(false);
      }
    } else {
      state.unmatchedSince = 0;
      setStatus(match === 'limit' ? 'limit' : 'scrollHint');
      if (state.automatic && (match === 'limit' || ++state.stillFrames >= 8)) await changeAutomatic(false);
    }
  }

  async function finish(action: 'edit' | 'copy' | 'save') {
    const state = runtime.current;
    if (state.finishing) return;
    state.finishing = true; setBusy(true);
    state.automatic = false; setAutomatic(false);
    try {
      await bridge.holdCapture(token);
      await state.pending;
      if (!state.active) return;
      const bitmap = state.capture.image();
      if (action === 'edit') await onEdit(bitmap);
      else if (!await bridge.exportImage(token, { action, selection: begin.selection, image: bitmap })) throw new Error('Export rejected');
    } catch {
      if (state.active) { state.finishing = false; setBusy(false); setError('exportFailed'); }
    }
  }

  useEffect(() => {
    const state = runtime.current;
    state.active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!state.active) return;
      if (state.finishing) { timer = setTimeout(tick, 200); return; }
      const started = performance.now();
      state.pending = sample().catch(() => { if (state.active && !state.finishing) { setError('captureFailed'); void changeAutomatic(false); } });
      await state.pending;
      state.pending = null;
      // Track active manual scrolling more closely; idle and automatic scrolling
      // keep their existing cadence (and automatic scrolling speed).
      const interval = !state.automatic && performance.now() < state.movingUntil ? 100 : 200;
      if (state.active) timer = setTimeout(tick, Math.max(0, interval - (performance.now() - started)));
    };
    timer = setTimeout(tick, 200);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); bridge.cancel(token); }
      else if (event.key === 'Enter' || ((event.ctrlKey || event.metaKey) && ['c', 's'].includes(event.key.toLowerCase()))) {
        event.preventDefault(); void finish(event.key.toLowerCase() === 's' ? 'save' : 'copy');
      }
    };
    window.addEventListener('keydown', key);
    return () => { state.active = false; clearTimeout(timer); cancelAnimationFrame(scrollPaint.current); window.removeEventListener('keydown', key); void bridge.holdCapture(token).catch(() => {}); };
    // A fresh session mounts a fresh overlay; mutable capture state lives in runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actions = [
    { key: 'edit', label: t('regionScreenshot.live.edit'), Icon: Pencil, run: () => void finish('edit') },
    { key: 'save', label: t('regionScreenshot.save'), Icon: Download, run: () => void finish('save') },
    { key: 'cancel', label: t('regionScreenshot.cancel'), Icon: X, run: () => bridge.cancel(token) },
    { key: 'copy', label: t('regionScreenshot.live.finish'), Icon: Check, run: () => void finish('copy') },
  ];
  const message = error === 'captureFailed' ? t('regionScreenshot.captureFailed') : t(`regionScreenshot.live.${error || status}`);
  return <div className="fixed inset-0 pointer-events-none select-none text-[var(--text-primary)]">
    <div aria-hidden className="absolute border border-[var(--text-primary)]" style={{ left: begin.selection.x - 1, top: begin.selection.y - 1, width: begin.selection.width + 2, height: begin.selection.height + 2, boxShadow: '0 0 0 1px var(--surface-elevated)' }} />
    <aside ref={panel} aria-label={t('regionScreenshot.live.preview')} className="absolute overflow-hidden pointer-events-auto" style={{ left: layout.preview.x, bottom: layout.viewport.height - layout.preview.y - layout.preview.height, width: layout.preview.width, height: initialPreviewHeight }}>
      <div ref={preview} tabIndex={0} className="h-full w-full overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none', overflowAnchor: 'none', scrollBehavior: 'auto' }} onWheel={() => { followGrowth.current = false; }} onScroll={() => {
        cancelAnimationFrame(scrollPaint.current);
        scrollPaint.current = requestAnimationFrame(() => paintRange());
      }}>
        <div className="relative w-full" style={{ height: Math.ceil(height * ratio) }}><canvas ref={canvas} className="absolute left-0 block w-full" /></div>
      </div>
      <p role="status" className="sr-only">{message}</p>
      <span className="sr-only">{begin.first.width} × {height}</span>
      {(error || status !== 'scrollHint') && <p role="alert" className="absolute inset-x-0 top-0 bg-[var(--surface-elevated)] px-2 py-1 text-11 text-[var(--text-secondary)] pointer-events-none">{message}</p>}
    </aside>
    <div className="absolute flex items-center justify-center gap-1 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] pointer-events-auto" style={{ left: layout.actions.x, top: layout.actions.y, width: layout.actions.width, height: layout.actions.height }}>
        {actions.map(({ key, label, Icon, run }) => <Tip key={key} text={label} side="top"><Button size="xs" variant={key === 'copy' ? 'cta' : 'secondary'} className="w-7 px-0" aria-label={label} disabled={busy} onClick={run}><Icon size={16} aria-hidden /></Button></Tip>)}
    </div>
    <div className="absolute flex items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] pointer-events-auto" style={{ left: layout.auto.x, top: layout.auto.y, width: layout.auto.width, height: layout.auto.height }}>
      <Tip text={t('regionScreenshot.live.scrollHint')} side="top"><Button size="sm" variant="secondary" disabled={busy} onClick={() => void changeAutomatic(!automatic)}>{t(`regionScreenshot.live.${automatic ? 'stopScroll' : 'autoScroll'}`)}</Button></Tip>
    </div>
  </div>;
}
