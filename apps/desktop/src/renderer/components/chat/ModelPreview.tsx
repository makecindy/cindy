import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AnimationMixer, type Group } from 'three';
import type { ViewerEngine } from 'mivo-model-viewer/core';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { extractIpcError } from '@/utils/ipcError';
import { PreviewButton, PreviewFooter } from './PreviewChrome';
import { loadPreviewModel } from './loadPreviewModel';

/** `path` reads a local file through the size-capped, path-checked read IPC
 * (xdt-file: stays out of connect-src); `url` is a managed media URL. */
export function ModelPreview({ url, path, filename }: { url: string; path?: string; filename: string }) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<ViewerEngine | null>(null);
  const reset = useRef<(() => void) | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'too-large'>('loading');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const element = container.current!;
    let engine: ViewerEngine | undefined;
    let object: Group | undefined;
    let observer: ResizeObserver | undefined;
    let mixer: AnimationMixer | undefined;
    let stopAnimation: (() => void) | undefined;
    let disposeObject: ((object: Group) => void) | undefined;
    setPhase('loading');
    void (async () => {
      const [core, data] = await Promise.all([
        import('mivo-model-viewer/core'),
        path
          ? window.electronAPI.readFileBytes({ filePath: path }).then(({ bytes }) => bytes)
          : fetch(url, { signal: controller.signal }).then(async (response) => {
              if (!response.ok) throw new Error('Unable to read model');
              return response.blob();
            }),
      ]);
      const file = new File([data as BlobPart], filename);
      if (controller.signal.aborted) return;
      core.setEnabledFormats(['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'dae', '3mf', '3ds']);
      disposeObject = core.disposeObject3D;
      engine = new core.ViewerEngine(element, { alpha: true, clearColor: null });
      viewer.current = engine;
      const resize = () => engine?.setRenderSize(Math.max(1, element.clientWidth), Math.max(1, element.clientHeight));
      resize();
      observer = new ResizeObserver(resize);
      observer.observe(element);
      const loaded = await loadPreviewModel(file);
      if (controller.signal.aborted) {
        core.disposeObject3D(loaded);
        return;
      }
      object = loaded;
      engine.addObject(loaded);
      const fit = () => {
        engine!.setCamera({ position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] });
        const pose = engine!.focusObject(loaded, { animate: false });
        if (pose) engine!.setCamera({ near: Math.max(pose.radius / 1000, 0.0001), far: Math.max((pose.distance + pose.radius) * 10, 100) });
      };
      reset.current = fit;
      fit();
      if (loaded.animations.length) {
        mixer = new AnimationMixer(loaded);
        mixer.clipAction(loaded.animations[0]).play();
        stopAnimation = engine.onBeforeRender(({ delta }) => mixer?.update(delta));
      }
      setPhase('ready');
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const ipcError = path ? extractIpcError(error) : null;
      setPhase(ipcError?.code === 'PRECONDITION_FAILED' &&
        ipcError.message === 'file exceeds the preview size limit' ? 'too-large' : 'error');
    });
    return () => {
      controller.abort();
      observer?.disconnect();
      stopAnimation?.();
      mixer?.stopAllAction();
      if (object) {
        mixer?.uncacheRoot(object);
        engine?.removeObject(object);
        disposeObject?.(object);
      }
      engine?.dispose();
      viewer.current = null;
      reset.current = null;
    };
  }, [url, path, filename, retry]);

  const zoom = (factor: number) => {
    const engine = viewer.current;
    if (!engine) return;
    const camera = engine.getCamera();
    const controls = engine.getControls();
    const offset = camera.position.clone().sub(controls.target);
    offset.setLength(Math.max(controls.minDistance, Math.min(controls.maxDistance, offset.length() * factor)));
    camera.position.copy(controls.target).add(offset);
    controls.update();
  };

  return <>
    <div ref={container} className="absolute inset-x-0 bottom-16 top-16 overflow-hidden" aria-label={filename} />
    {(phase === 'error' || phase === 'too-large') && <div role="alert" className="absolute inset-x-0 bottom-16 top-16 flex flex-col items-center justify-center gap-3 text-sm text-[var(--text-secondary)]">
      <span>{phase === 'too-large' ? t('chat.media.modelTooLarge', { maxSize: '30 MiB' }) : t('chat.media.modelLoadFailed')}</span>
      {phase === 'error' && <Button variant="secondary" size="sm" onClick={() => setRetry(value => value + 1)}>{t('attachmentPreview.retry')}</Button>}
    </div>}
    {phase === 'too-large' ? <PreviewFooter collectionOnly /> : <PreviewFooter>
      {phase === 'loading' ? <div role="status" className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
        <Spinner />{t('chat.media.modelLoading')}
      </div> : <>
        <PreviewButton label={t('chat.mermaidLightbox.zoomOut')} disabled={phase !== 'ready'} onClick={() => zoom(1.2)}><Minus className="h-4 w-4" /></PreviewButton>
        <PreviewButton label={t('attachmentPreview.reset')} disabled={phase !== 'ready'} onClick={() => reset.current?.()}><RotateCcw className="h-4 w-4" /></PreviewButton>
        <PreviewButton label={t('chat.mermaidLightbox.zoomIn')} disabled={phase !== 'ready'} onClick={() => zoom(1 / 1.2)}><Plus className="h-4 w-4" /></PreviewButton>
      </>}
    </PreviewFooter>}
  </>;
}
