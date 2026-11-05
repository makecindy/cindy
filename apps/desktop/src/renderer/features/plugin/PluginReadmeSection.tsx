/**
 * 插件详情页的「介绍」区：显示插件包里的详细介绍（manifest.readme）。
 * 图片只显示宿主给出的包内图片，正文较长时先折叠。安装后与市场详情页共用。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveGhostReadmeAssetPath, type GhostReadmeContent } from '@cindy/plugin-protocol';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { cn } from '@/lib/utils';

import { DetailSectionHeader } from './GhostPluginDetailView';

/** 折叠时的最大高度；超出才显示「展开」。 */
const COLLAPSED_MAX_HEIGHT_PX = 360;

export function PluginReadmeSection({ readme }: { readme: GhostReadmeContent | null }) {
  const { t } = useTranslation();
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const resolveImageSrc = useCallback(
    (src: string) => {
      if (!readme) return null;
      const path = resolveGhostReadmeAssetPath(readme.path, src);
      return path ? (readme.images[path] ?? null) : null;
    },
    [readme],
  );

  useEffect(() => setExpanded(false), [readme]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    // 图片解码后高度才稳定，跟着内容尺寸变化重算是否需要折叠。
    const measure = () => setOverflows(body.scrollHeight > COLLAPSED_MAX_HEIGHT_PX + 1);
    measure();
    const observer = new ResizeObserver(measure);
    const content = body.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [readme]);

  if (!readme) return null;
  return (
    <section className="mt-10" aria-labelledby={titleId}>
      <DetailSectionHeader id={titleId} title={t('settings.ghosts.detail.readmeTitle')} />
      <div
        ref={bodyRef}
        className={cn('mt-4 max-w-[760px] overflow-hidden', !expanded && 'max-h-[360px]')}
      >
        <div>
          <MarkdownRenderer
            workingDir=""
            content={readme.markdown}
            allowPrivilegedLinks={false}
            resolveImageSrc={resolveImageSrc}
          />
        </div>
      </div>
      {overflows ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="mt-2 rounded-full text-13 leading-5 text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
        >
          {t(
            expanded
              ? 'settings.ghosts.detail.descriptionCollapse'
              : 'settings.ghosts.detail.descriptionExpand',
          )}
        </button>
      ) : null}
    </section>
  );
}

/**
 * 按需读取介绍内容。`load` 为 null 时不读取；切换插件时丢弃迟到的旧结果，
 * 读取失败按没有介绍处理（详情页其余内容照常显示）。
 */
export function usePluginReadme(
  key: string | null,
  load: (() => Promise<GhostReadmeContent | null>) | null,
): GhostReadmeContent | null {
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
  return state && state.key === key ? state.readme : null;
}
