/**
 * Model3DCard
 * ---------------------------------------------------------------------------
 * 聊天里的 3D 模型卡片：缩略图 + 文件名 + 格式，点击打开 ModelLightbox。
 *
 * 缩略图由渲染进程的缩略图服务（`mivo-model-viewer`，WebGL）按需生成，不依赖插件
 * 提供预览图。只有卡片进入视口（预留 200px）才开始读取字节与渲染，长对话里滚动
 * 经过的模型不会一次性全部解析；生成失败 / 模型过大时显示占位图标，点击预览不受影响。
 *
 * 拆成两层，供不同容器复用：
 *   - `Model3DCardContent`：纯展示的缩略图 + 页脚，嵌进已有的按钮里（文件卡片）；
 *   - `Model3DCard`：自带按钮与 ModelLightbox（工具结果里的独立模型）。
 */

import { useEffect, useRef, useState } from 'react';
import { getModel3DFormat } from '@cindy/maker-shared/model3d';
import { Box } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { getModel3DThumbnail } from '@/lib/model3d/thumbnails';
import { type Model3DSource, model3DFileName } from '@/lib/model3d/readModel3DBlob';
import { CHAT_COLOR_TRANSITION_CLASS, CHAT_FOCUS_CLASS } from './chatChrome';
import { ModelLightbox } from './ModelLightbox';

type ThumbnailState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; src: string }
  | { status: 'failed' };

/** 进入视口后才触发缩略图生成；`enabled=false`（例如文件复核未落地）时保持 idle。 */
function useModel3DThumbnail(source: Model3DSource, enabled: boolean) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<ThumbnailState>({ status: 'idle' });
  // 来源用稳定的字符串作依赖，避免父组件每次渲染新建对象时重复触发
  const sourceKey = source.kind === 'blob' ? `blob:${source.url}` : `local:${source.absPath}`;

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!enabled || !visible) return;
    let cancelled = false;
    setState({ status: 'loading' });
    getModel3DThumbnail(source).then(
      (src) => {
        if (!cancelled) setState({ status: 'ready', src });
      },
      () => {
        if (!cancelled) setState({ status: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, visible, sourceKey]);

  return { ref, state };
}

interface Model3DCardContentProps {
  source: Model3DSource;
  /** 展示用文件名；缺省取来源路径的文件名。 */
  fileName?: string;
  /** 为 false 时不触发缩略图生成（占位）。 */
  enabled?: boolean;
}

/** 缩略图区域 + 页脚。外层容器（按钮）负责边框、圆角、点击与右键菜单。 */
export function Model3DCardContent({ source, fileName, enabled = true }: Model3DCardContentProps) {
  const { t } = useTranslation();
  const name = fileName ?? model3DFileName(source);
  const format = getModel3DFormat(name)?.toUpperCase() ?? '3D';
  const { ref, state } = useModel3DThumbnail(source, enabled);

  return (
    <>
      <span
        ref={ref}
        className="flex h-[148px] w-full items-center justify-center border-b border-[var(--border-default)] bg-[var(--surface-hover)] text-[var(--text-tertiary)]"
      >
        {state.status === 'ready' ? (
          <img
            src={state.src}
            alt={t('chat.media.modelPreviewAlt')}
            draggable={false}
            className="h-full w-full object-contain"
          />
        ) : state.status === 'loading' ? (
          <Spinner size={18} />
        ) : (
          <Box size={26} aria-hidden="true" />
        )}
      </span>
      <span className="flex min-w-0 items-center gap-2 px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
          {name}
        </span>
        <span className="shrink-0 text-11 text-[var(--text-tertiary)]">{format}</span>
      </span>
    </>
  );
}

/** 卡片按钮的容器样式，与文件卡片里的图片 / 网页卡片一致。 */
export const MODEL3D_CARD_CLASS = cn(
  CHAT_FOCUS_CLASS,
  CHAT_COLOR_TRANSITION_CLASS,
  'group block w-full max-w-[420px] cursor-pointer overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-left hover:border-[var(--text-tertiary)]',
);

interface Model3DCardProps {
  source: Model3DSource;
  fileName?: string;
  className?: string;
}

/** 独立的模型卡片：点击打开 ModelLightbox。 */
export function Model3DCard({ source, fileName, className }: Model3DCardProps) {
  const [open, setOpen] = useState(false);
  const name = fileName ?? model3DFileName(source);

  return (
    <>
      <button
        type="button"
        title={name}
        onClick={() => setOpen(true)}
        className={cn(MODEL3D_CARD_CLASS, className)}
      >
        <Model3DCardContent source={source} fileName={name} />
      </button>
      {open ? (
        <ModelLightbox
          source={
            source.kind === 'blob'
              ? { kind: 'blob', url: source.url }
              : { kind: 'local', absPath: source.absPath }
          }
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
