import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical, Pause, Play, Pencil, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MAX_RECORDING_MS, recordingControlsBounds, type RegionCaptureBegin } from '../../../shared/regionCapture';
import type { RegionScreenshotBitmap } from '../../../shared/regionScreenshot';
import { bitmapToImageData, type RegionScreenshotOverlayBridge } from './bridge';
import { CaptureRecorder } from './captureRecorder';
import { SCREENSHOT_INK } from './screenshotColors';

type Phase = 'countdown' | 'capturing' | 'paused' | 'finishing' | 'done';
type Point = { x: number; y: number };
type Mark = { kind: 'pen' | 'arrow' | 'rect'; points: Point[] };

export function LiveCapturePanel({ begin, token, bridge }: { begin: RegionCaptureBegin; token: string; bridge: RegionScreenshotOverlayBridge }) {
  const { t } = useTranslation();
  const preview = useRef<HTMLCanvasElement>(null);
  const runtime = useRef({
    phase: 'countdown' as Phase, countdownUntil: 0,
    active: true, inFlight: null as Promise<void> | null, recorder: null as CaptureRecorder | null,
    canvas: null as HTMLCanvasElement | null,
    imageData: undefined as ImageData | undefined,
    bitmap: begin.first, marks: [] as Mark[], draft: null as Mark | null,
    elapsed: 0, startedAt: 0,
  });
  const [phase, setPhase] = useState<Phase>(runtime.current.phase);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [countdown, setCountdown] = useState(3);
  const [expanded, setExpanded] = useState(false);
  const layout = begin.recordingLayout!;
  const [controls, setControls] = useState(layout.controls);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; point: Point } | null>(null);
  const controlsRequest = useRef(0);
  const [tool, setTool] = useState<Mark['kind'] | null>(null);
  const [result, setResult] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [saving, setSaving] = useState(false);
  const currentTime = () => runtime.current.elapsed + (runtime.current.phase === 'capturing' ? performance.now() - runtime.current.startedAt : 0);
  const changePhase = (next: Phase) => { runtime.current.phase = next; setPhase(next); };

  function paint(bitmap: RegionScreenshotBitmap, pointer: Point | null = null) {
    const state = runtime.current;
    state.canvas ??= document.createElement('canvas');
    const canvas = state.canvas;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    state.imageData = bitmapToImageData(bitmap, state.imageData);
    ctx.putImageData(state.imageData, 0, 0);
    {
      ctx.strokeStyle = SCREENSHOT_INK.red;
      ctx.lineWidth = Math.max(2, bitmap.width / 350);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const mark of state.draft ? [...state.marks, state.draft] : state.marks) {
        const points = mark.points.map((point) => ({ x: point.x * bitmap.width, y: point.y * bitmap.height }));
        const first = points[0], last = points[points.length - 1];
        if (!first || !last) continue;
        ctx.beginPath();
        if (mark.kind === 'rect') ctx.rect(first.x, first.y, last.x - first.x, last.y - first.y);
        else {
          ctx.moveTo(first.x, first.y);
          for (const point of mark.kind === 'arrow' ? [last] : points.slice(1)) ctx.lineTo(point.x, point.y);
          if (mark.kind === 'arrow') {
            const angle = Math.atan2(last.y - first.y, last.x - first.x), length = ctx.lineWidth * 5;
            for (const delta of [-0.5, 0.5]) { ctx.moveTo(last.x, last.y); ctx.lineTo(last.x - length * Math.cos(angle + delta), last.y - length * Math.sin(angle + delta)); }
          }
        }
        ctx.stroke();
      }
      if (pointer) {
        ctx.fillStyle = SCREENSHOT_INK.white; ctx.strokeStyle = SCREENSHOT_INK.black; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(pointer.x, pointer.y); ctx.lineTo(pointer.x + 5, pointer.y + 19); ctx.lineTo(pointer.x + 9, pointer.y + 12); ctx.lineTo(pointer.x + 16, pointer.y + 11); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    const target = preview.current;
    if (target) {
      if (target.width !== bitmap.width || target.height !== bitmap.height) {
        target.width = bitmap.width; target.height = bitmap.height;
      }
      target.getContext('2d')!.drawImage(canvas, 0, 0);
    }
  }

  async function sample() {
    const state = runtime.current;
    const frame = await bridge.liveFrame(token, false);
    if (!state.active || state.phase !== 'capturing' || !frame) return;
    {
      state.bitmap = frame.image;
      paint(frame.image, frame.cursor);
      if (!state.recorder) {
        state.startedAt = performance.now(); state.elapsed = 0;
        state.recorder = new CaptureRecorder(state.canvas!, begin.mode === 'gif' ? 'gif' : 'webm', () => { setStatus('limit'); void finish(); });
      }
      state.recorder.add(currentTime());
      setElapsed(Math.floor(currentTime() / 1000) * 1000);
      if (currentTime() >= MAX_RECORDING_MS) { setStatus('limit'); queueMicrotask(() => void finish()); }
    }
  }

  useEffect(() => {
    const state = runtime.current;
    state.active = true; state.countdownUntil = performance.now() + 3000;
    paint(begin.first);
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!state.active) return;
      const tickStarted = performance.now();
      if (state.phase === 'countdown') {
        const remaining = Math.max(0, Math.ceil((state.countdownUntil - tickStarted) / 1000));
        setCountdown(remaining);
        if (!remaining) {
          state.startedAt = performance.now(); changePhase('capturing');
          // Let the countdown leave the compositor before capturing the first frame.
          timer = setTimeout(tick, 150);
          return;
        }
      }
      if (state.phase === 'capturing') {
        state.inFlight = sample().catch(() => {
          if (!state.active || state.phase !== 'capturing') return;
          state.elapsed = currentTime();
          state.recorder?.pause(state.elapsed);
          changePhase('paused'); setError('captureFailed');
        });
        await state.inFlight;
        state.inFlight = null;
      }
      if (state.active) timer = setTimeout(tick, Math.max(0, 100 - (performance.now() - tickStarted)));
    };
    timer = setTimeout(tick, 250);
    return () => { state.active = false; clearTimeout(timer); state.recorder?.dispose(); };
    // A capture's lifetime is the component's lifetime; all changing options live in runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (expanded) paint(runtime.current.bitmap); }, [expanded]);

  function pause() {
    const state = runtime.current;
    if (state.phase === 'capturing') {
      state.elapsed = currentTime(); state.recorder?.pause(state.elapsed); changePhase('paused'); setStatus('paused');
      void bridge.holdCapture(token).catch(() => {});
    } else if (state.phase === 'paused') {
      state.startedAt = performance.now(); state.recorder?.resume(); changePhase('capturing'); setError(''); setStatus('recording');
    }
  }

  async function finish() {
    const state = runtime.current;
    if (state.phase === 'done' || state.phase === 'finishing' || state.phase === 'countdown') return;
    const at = currentTime();
    state.elapsed = at; setElapsed(at);
    changePhase('finishing');
    // Finish after any in-flight sample; it will see the changed phase and discard its frame.
    await state.inFlight;
    if (!state.active) return;
    try {
      await bridge.holdCapture(token);
      {
        if (!state.recorder) { setError('captureFailed'); changePhase('paused'); return; }
        const bytes = await state.recorder.finish(at);
        if (!state.active) return;
        setResult(bytes);
        changePhase('done'); setStatus('done');
        await previewRecording(bytes);
      }
    } catch { if (state.active) { setError('encodeFailed'); changePhase('done'); } }
  }

  async function previewRecording(bytes: Uint8Array<ArrayBuffer>) {
    try {
      const opened = await bridge.previewRecording(token, bytes, begin.mode === 'gif' ? 'gif' : 'webm');
      if (!opened && runtime.current.active) setError('previewUnavailable');
    } catch { if (runtime.current.active) setError('previewUnavailable'); }
  }

  async function saveRecording() {
    if (!result) return;
    setSaving(true);
    try {
      if (await bridge.saveRecording(token, result, begin.mode === 'gif' ? 'gif' : 'webm')) setStatus('saved');
    } catch { setError('exportFailed'); }
    finally { if (runtime.current.active) setSaving(false); }
  }

  function point(event: PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  }

  async function moveControls(nextExpanded: boolean, point?: Point, dragging = false) {
    const next = recordingControlsBounds(begin.selection, layout.viewport, nextExpanded, point, layout.area);
    if (!next) { setError('annotationNoRoom'); return; }
    const request = ++controlsRequest.current;
    setControls(next); setExpanded(nextExpanded);
    try {
      const accepted = await bridge.recordingControls(token, nextExpanded, point, dragging);
      if (accepted && runtime.current.active && request === controlsRequest.current) setControls(accepted);
    } catch { if (runtime.current.active) setError('captureFailed'); }
  }

  function dragPoint(event: PointerEvent<HTMLButtonElement>): Point | null {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return null;
    return { x: start.left + event.clientX - start.x, y: start.top + event.clientY - start.y };
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>, finalPoint?: Point | null) {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    drag.current = null;
    // Use the final pointer position, not the last React render / IPC response.
    void moveControls(expanded, finalPoint ?? start.point);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return <div className="pointer-events-none fixed inset-0 select-none text-12 text-[var(--text-primary)]">
    <div className="absolute border-2 border-[var(--focus-ring)]" style={{ left: begin.selection.x - 2, top: begin.selection.y - 2, width: begin.selection.width + 4, height: begin.selection.height + 4 }} />
    {phase === 'countdown' && <div className="absolute flex items-center justify-center" style={{ left: begin.selection.x, top: begin.selection.y, width: begin.selection.width, height: begin.selection.height }}>
      <span role="status" aria-label={t('regionScreenshot.live.countdown', { count: countdown })} className="flex h-40 w-40 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] font-semibold leading-none tabular-nums shadow-lg" style={{ fontSize: 64 }}>{countdown}</span>
    </div>}
    <section aria-label={t('regionScreenshot.live.video')} className="pointer-events-auto absolute flex flex-col gap-1 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-2" style={{ left: controls.x, top: controls.y, width: controls.width, height: controls.height }}>
    <div className="flex shrink-0 items-center gap-1">
      <button type="button" aria-label={t('regionScreenshot.moveToolbar')} className="flex h-7 min-w-0 flex-1 touch-none cursor-grab items-center gap-1 rounded-full text-left hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] active:cursor-grabbing"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: controls.x, top: controls.y, point: controls };
          event.currentTarget.setPointerCapture(event.pointerId);
          void moveControls(expanded, controls, true);
        }}
        onPointerMove={(event) => { const point = dragPoint(event); if (point && drag.current) { drag.current.point = point; void moveControls(expanded, point, true); } }}
        onPointerUp={(event) => endDrag(event, dragPoint(event))}
        onPointerCancel={(event) => endDrag(event)}
        onLostPointerCapture={(event) => endDrag(event)}
        onKeyDown={(event) => { const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]; if (delta) { event.preventDefault(); void moveControls(expanded, { x: controls.x + delta[0], y: controls.y + delta[1] }); } }}>
        <span className="flex w-7 shrink-0 justify-center"><GripVertical size={14} /></span>
        <span className="text-[var(--text-secondary)]">{begin.mode === 'gif' ? 'GIF' : 'WebM'}</span>
        <span className="whitespace-nowrap font-medium tabular-nums">{`${Math.floor(elapsed / 60_000)}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}`} / 5:00</span>
      </button>
      {(phase === 'capturing' || phase === 'paused') && <>
        <Button size="xs" variant="secondary" tone={expanded ? 'default' : 'quiet'} className="w-7 px-0" aria-label={t('regionScreenshot.live.annotate')} aria-pressed={expanded} onClick={() => void moveControls(!expanded)}><Pencil size={14} /></Button>
        <Button size="xs" variant="secondary" tone="quiet" className="w-7 px-0" aria-label={t(`regionScreenshot.live.${phase === 'capturing' ? 'pause' : 'resume'}`)} onClick={pause}>{phase === 'capturing' ? <Pause size={14} /> : <Play size={14} />}</Button>
      </>}
      {phase !== 'countdown' && phase !== 'done' && <Button size="xs" variant="cta" disabled={phase === 'finishing'} onClick={() => void finish()}><Square size={12} />{t(`regionScreenshot.live.${phase === 'finishing' ? 'finishing' : 'finish'}`)}</Button>}
      {phase === 'done' && result && <>
        <Button size="xs" variant="secondary" onClick={() => void previewRecording(result)}>{t('regionScreenshot.live.preview')}</Button>
        <Button size="xs" variant="cta" disabled={saving} onClick={() => void saveRecording()}>{t('regionScreenshot.save')}</Button>
      </>}
      <Button size="xs" variant="secondary" tone="quiet" className="w-7 px-0" disabled={saving || phase === 'finishing'} aria-label={t('regionScreenshot.cancel')} onClick={() => bridge.cancel(token)}><X size={14} /></Button>
    </div>
    <p role={error ? 'alert' : 'status'} className={`truncate ${error ? 'text-[var(--text-danger)]' : 'text-[var(--text-secondary)]'}`} title={error ? t(`regionScreenshot.live.${error}`) : undefined}>{t(`regionScreenshot.live.${error || (phase === 'countdown' ? 'countdownHint' : phase === 'finishing' ? 'finishing' : status || (phase === 'paused' ? 'paused' : phase === 'done' ? 'done' : 'recording'))}`)}</p>
    {expanded && <><div className="flex min-h-12 flex-1 items-center justify-center overflow-hidden">
      <canvas ref={preview} aria-label={t('regionScreenshot.live.preview')} className="block max-h-full max-w-full" style={{ objectFit: 'contain', cursor: tool ? 'crosshair' : 'default' }}
        onPointerDown={(event) => {
          if (!tool || phase === 'done' || phase === 'finishing') return;
          event.currentTarget.setPointerCapture(event.pointerId);
          runtime.current.draft = { kind: tool, points: [point(event)] };
        }}
        onPointerMove={(event) => {
          const draft = runtime.current.draft;
          if (!draft) return;
          if (draft.points.length < 4000) draft.points.push(point(event));
          paint(runtime.current.bitmap);
        }}
        onPointerUp={() => {
          const state = runtime.current;
          if (state.draft && state.marks.length < 100) state.marks.push(state.draft);
          state.draft = null; paint(state.bitmap);
        }} onPointerCancel={() => { runtime.current.draft = null; paint(runtime.current.bitmap); }} />
    </div>
      <div className="flex flex-wrap gap-1">
        {(['pen', 'arrow', 'rect'] as const).map((kind) => <Button key={kind} size="xs" variant="secondary" tone={tool === kind ? 'default' : 'quiet'} aria-pressed={tool === kind} onClick={() => setTool(tool === kind ? null : kind)}>{t(`regionScreenshot.tools.${kind}`)}</Button>)}
        <Button size="xs" variant="secondary" tone="quiet" onClick={() => { runtime.current.marks.pop(); paint(runtime.current.bitmap); }}>{t('regionScreenshot.undo')}</Button>
      </div>
    </>}
    </section>
  </div>;
}
