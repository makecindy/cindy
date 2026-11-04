import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Minus, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RecordingPreviewDocument } from '../../../shared/regionCapture';

export interface RecordingPreviewBridge {
  ready(): void; failed(): void;
  onBegin(callback: (document: RecordingPreviewDocument) => void): () => void;
  onEnd(callback: () => void): () => void;
  painted(token: string): void; close(token: string): void; minimize(token: string): void;
  save(token: string): Promise<boolean>;
  copy(token: string): Promise<boolean>;
}
declare global { interface Window { recordingPreview?: RecordingPreviewBridge } }

export function RecordingPreview({ document: clip, bridge }: { document: RecordingPreviewDocument; bridge: RecordingPreviewBridge }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [action, setAction] = useState<'save' | 'copy' | null>(null);
  const saving = action !== null;
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [replay, setReplay] = useState(0);
  const [ready, setReady] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([clip.bytes], { type: clip.format === 'gif' ? 'image/gif' : 'video/webm' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [clip]);
  useEffect(() => {
    if (!ready && !error) return;
    const frame = requestAnimationFrame(() => bridge.painted(clip.token));
    return () => cancelAnimationFrame(frame);
  }, [ready, error, clip.token, bridge]);
  useEffect(() => {
    let fullscreen = !!document.fullscreenElement;
    let exitedFullscreenAt = -Infinity;
    const fullscreenChanged = () => {
      const next = !!document.fullscreenElement;
      if (fullscreen && !next) exitedFullscreenAt = performance.now();
      fullscreen = next;
    };
    const visibility = () => { if (document.hidden) video.current?.pause(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return;
      if (fullscreen || document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
        return;
      }
      // Chromium may exit fullscreen before delivering this same Esc to the page.
      if (performance.now() - exitedFullscreenAt < 250) return;
      bridge.close(clip.token);
    };
    document.addEventListener('fullscreenchange', fullscreenChanged);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('fullscreenchange', fullscreenChanged); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('keydown', escape); };
  }, [bridge, clip.token, saving]);
  async function save() {
    setAction('save'); setStatus(''); setError('');
    try { if (await bridge.save(clip.token)) setStatus('saved'); }
    catch { setError('exportFailed'); }
    finally { setAction(null); }
  }
  async function copy() {
    setAction('copy'); setStatus(''); setError('');
    try {
      if (await bridge.copy(clip.token)) setStatus('copied');
      else setError('copyFailed');
    } catch { setError('copyFailed'); }
    finally { setAction(null); }
  }
  return <div className="flex h-screen flex-col bg-[var(--surface)] text-[var(--text-primary)]">
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-3 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]">
      <span className="text-12">{t('regionScreenshot.live.preview')} · {clip.format === 'gif' ? 'GIF' : 'WebM'}</span>
      <span className="flex-1" />
      <Button size="xs" variant="secondary" tone="quiet" className="w-7 px-0" aria-label={t('titleBar.minimize')} onClick={() => bridge.minimize(clip.token)}><Minus size={14} /></Button>
      <Button size="xs" variant="secondary" tone="quiet" className="w-7 px-0" disabled={saving} aria-label={t('titleBar.close')} onClick={() => bridge.close(clip.token)}><X size={14} /></Button>
    </div>
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      {!ready && !error && <span role="status" className="absolute text-13 text-[var(--text-secondary)]">{t('regionScreenshot.editor.loading')}</span>}
      {url && (clip.format === 'gif'
        ? <img key={replay} src={url} alt={t('regionScreenshot.live.preview')} className="max-h-full max-w-full object-contain" onLoad={() => setReady(true)} onError={() => setError('playbackFailed')} />
        : <video ref={video} src={url} controls playsInline className="h-full w-full object-contain" aria-label={t('regionScreenshot.live.preview')} onLoadedData={() => setReady(true)} onError={() => setError('playbackFailed')} />)}
    </div>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--border-default)] p-3">
      {clip.format === 'gif' && <Button size="sm" variant="secondary" onClick={() => setReplay((value) => value + 1)}><RotateCcw size={14} />{t('regionScreenshot.live.replay')}</Button>}
      <span role={error ? 'alert' : 'status'} className={`min-w-0 flex-1 text-12 ${error ? 'text-[var(--text-danger)]' : 'text-[var(--text-secondary)]'}`}>{(error || status) && t(`regionScreenshot.live.${error || status}`)}</span>
      <Button size="sm" variant="secondary" loading={action === 'copy'} disabled={saving} onClick={() => void copy()}>{t('regionScreenshot.copy')}</Button>
      <Button size="sm" variant="cta" loading={action === 'save'} disabled={saving} onClick={() => void save()}>{t('regionScreenshot.save')}</Button>
    </div>
  </div>;
}
