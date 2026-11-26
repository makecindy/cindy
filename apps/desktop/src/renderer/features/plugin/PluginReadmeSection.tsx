/**
 * 插件图文介绍的预览和全文。图片只显示宿主给出的包内图片。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { resolveGhostReadmeAssetPath, type GhostReadmeContent } from '@cindy/plugin-protocol';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { cn } from '@/lib/utils';

export function PluginReadmeSection({ readme, preview = false }: { readme: GhostReadmeContent | null; preview?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const resolveImageSrc = useCallback(
    (src: string) => {
      if (!readme?.markdown.trim()) return null;
      const path = resolveGhostReadmeAssetPath(readme.path, src);
      return path ? (readme.images[path] ?? null) : null;
    },
    [readme],
  );
  useLayoutEffect(() => {
    const outer = box.current;
    const inner = body.current;
    if (!preview || !outer || !inner) return;
    const measure = () => setClipped(outer.scrollHeight > outer.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [preview, readme]);

  if (!readme?.markdown.trim()) return null;
  return (
    <div ref={box} className={cn('mt-3 min-w-0 break-words', preview && 'plugin-detail-readme-preview')}
      data-clipped={preview && clipped ? '' : undefined} inert={preview || undefined}>
      <div ref={body}>
        <MarkdownRenderer
          workingDir=""
          content={readme.markdown}
          allowPrivilegedLinks={false}
          resolveImageSrc={resolveImageSrc}
        />
      </div>
    </div>
  );
}

/**
 * 按需读取介绍内容。`load` 为 null 时不读取；切换插件时丢弃迟到的旧结果，
 * 读取失败按没有介绍处理（详情页其余内容照常显示）。
 */
export function usePluginReadme(
  key: string | null,
  load: (() => Promise<GhostReadmeContent | null>) | null,
): { readme: GhostReadmeContent | null; pending: boolean } {
  const [state, setState] = useState<{ key: string; readme: GhostReadmeContent | null } | null>(
    null,
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  const enabled = load !== null;
  useEffect(() => {
    const current = loadRef.current;
    if (!key || !current) return;
    let cancelled = false;
    current().then(
      (readme) => {
        if (!cancelled) setState({ key, readme });
      },
      () => {
        if (!cancelled) setState({ key, readme: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, enabled]);
  const loaded = state?.key === key;
  return { readme: loaded ? state?.readme ?? null : null, pending: Boolean(enabled && key && !loaded) };
}
