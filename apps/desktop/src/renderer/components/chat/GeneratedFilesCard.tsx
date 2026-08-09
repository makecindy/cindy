/**
 * GeneratedFilesCard — 每个 user turn 结尾的「本轮产出文件」卡。
 * ---------------------------------------------------------------------------
 * 对标 Codex Desktop 回复尾部的 artifact 文件卡:agent 本轮新建的文件不再只能
 * 靠模型在正文里写对 Markdown 链接才可见(Issue #1811 场景),而是从 tool_use
 * 结构化派生后集中呈现。文件来源判定见 lib/generatedFiles.ts。
 *
 * 交互:
 *   - 左键 → 与正文文件链接同策(对齐 MarkdownRenderer activateResolvedLocalTarget):
 *     可识别文件直接在 Cindy 内打开——文本/代码 → TextLightbox,图片 → ImageLightbox,
 *     glb/gltf → ModelLightbox;其余(xlsx / pdf 等)交系统默认应用(远程会话取回
 *     缓存副本再打开)。
 *   - 右键 → 共享文件 chip 菜单(复制 / 路径 / 定位 / 打开方式…),与聊天里其它
 *     文件 chip 一致。
 *
 * 存在性门槛(DESIGN.md §14.5「可点必存在」):本地会话渲染前 stat 过滤,不存在
 * 的文件不出 chip,整卡为空则不渲染。远程会话经 verifyRemotePathCached 远端 stat
 * 复核:先按 tool_use 记录乐观呈现,verdict 回来后 nonfile/directory 摘掉;
 * unknown(断链 / 限流)保持乐观——与正文 chip 的远程点亮不变量同策。
 *
 * 本地文件统一要求时间戳落在本轮 `[turnStartMs, turnEndMs)` 窗口内。tool 来源
 * (Write / file-change add)也不能只凭存在性:Write 可能覆盖既有文件,失败路径也可能
 * 被后续轮次创建;因此它必须有落在窗口内的 birthtime,不可用时宁可不出。
 * command 来源为兼容不提供 birthtime 的 Linux FS 允许 mtime 回退,但同样受完整
 * 时间窗约束。远程会话无法读取创建时间,维持远端 stat 的存在性复核。
 */

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { GeneratedFileRef } from '@/lib/generatedFiles';
import { classifyMarkdownHref, toLocalFileUrl } from '@/lib/localPathResolver';
import { isRemoteFileOrigin, toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import {
  fetchChatFileWithToasts,
  revealRemoteChatFile,
  verifyRemotePathCached,
} from '@/lib/remoteFileOpen';
import { shouldOpenTextLightboxForOrigin } from '@/lib/filePreview';
import { rewriteToRemoteMediaOrigin } from '../../../shared/remoteMediaUrl';
import { useChatSessionFile } from './ChatSessionFileContext';
import { useFileChipContextMenu } from './useFileChipContextMenu';
import { ImageLightbox } from './ImageLightbox';
import { TextLightbox } from './TextLightbox';
import { ModelLightbox } from './ModelLightbox';

function GeneratedFileChip({ file }: { file: GeneratedFileRef }) {
  const fileCtx = useChatSessionFile();
  const remoteOrigin = isRemoteFileOrigin(fileCtx.origin) ? fileCtx.origin : null;
  const ctxMenu = useFileChipContextMenu({
    getAbsPath: () => file.path,
    // 生成物常是 .xlsx / .pdf / 图片等,"打开方式"对它们最有用;会话上下文
    // (含侧边栏定位目标)由 useFileChipContextMenu 内部从 ChatSessionFileContext 取。
    canOpenInBrowser: false,
  });

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [textLightboxOpen, setTextLightboxOpen] = useState(false);
  const [modelLightboxPath, setModelLightboxPath] = useState<string | null>(null);

  // 左键与正文文件链接同策(见文件头注释)。非文本兜底交给
  // shouldOpenTextLightboxForOrigin:本地 openPath、远程取回缓存副本,均含失败 toast。
  const open = async (): Promise<void> => {
    const kind = classifyMarkdownHref(file.path);
    if (kind === 'image-local') {
      const localUrl = toLocalFileUrl(file.path);
      if (!remoteOrigin) {
        setLightboxSrc(localUrl);
        return;
      }
      // 远程:xdt-file:// 经 origin 改写走 cindy-remote-media 管线;改写不了
      // (ssh workdir 外)→ 取回缓存副本后按本机文件预览(与正文链接同策)。
      const rewritten = rewriteToRemoteMediaOrigin(
        localUrl,
        toRemoteMediaOrigin(fileCtx.origin, fileCtx.workingDir),
      );
      if (rewritten !== localUrl) {
        setLightboxSrc(rewritten);
        return;
      }
      const cachePath = await fetchChatFileWithToasts(remoteOrigin, fileCtx.workingDir, file.path);
      if (cachePath) setLightboxSrc(toLocalFileUrl(cachePath));
      return;
    }
    if (kind === 'model-local') {
      if (remoteOrigin) {
        await revealRemoteChatFile(remoteOrigin, fileCtx.workingDir, file.path);
        return;
      }
      // FBX 无应用内预览且 openPath 有误导弹窗风险(正文链接同款取舍)→ 定位。
      if (/\.fbx$/i.test(file.path)) {
        void window.electronAPI.showItemInFolder({ filePath: file.path });
        return;
      }
      setModelLightboxPath(file.path);
      return;
    }
    if (!(await shouldOpenTextLightboxForOrigin(fileCtx, file.path))) return;
    setTextLightboxOpen(true);
  };

  return (
    <>
      <button
        type="button"
        title={file.path}
        onClick={() => void open()}
        onContextMenu={ctxMenu.onContextMenu}
        className={cn(
          'inline-flex items-center gap-1.5',
          'h-7 px-2.5 py-1.5 max-w-[280px]',
          'rounded-[9999px]',
          'bg-[var(--msg-md-inline-code-bg)]',
          'text-13 font-medium text-[var(--msg-assistant-text)]',
          'hover:bg-[var(--cmd-palette-item-hover)]',
          'transition-colors cursor-pointer',
        )}
      >
        <FileText size={14} className="shrink-0 opacity-70" />
        <span className="truncate">{file.name}</span>
      </button>
      {ctxMenu.menu}
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      {textLightboxOpen && (
        <TextLightbox
          filePath={file.path}
          fileName={file.name}
          onClose={() => setTextLightboxOpen(false)}
        />
      )}
      {modelLightboxPath && (
        <ModelLightbox
          source={{ kind: 'local', absPath: modelLightboxPath }}
          onClose={() => setModelLightboxPath(null)}
        />
      )}
    </>
  );
}

/** command 候选 mtime 下界的时钟余量:消息落库时间与文件写盘时间的抖动缓冲。 */
const TURN_START_SLACK_MS = 120_000;

interface GeneratedFileStat {
  kind: 'dir' | 'file' | 'missing';
  birthtimeMs?: number;
  mtimeMs?: number;
}

/**
 * 本地文件是否有足够证据归属于该 turn。tool 来源必须有真实创建时间:
 * Write 也可能覆盖既有文件,仅凭成功/mtime 不能把它当成“新建”;birthtime
 * 不可用时宁可不出。command 来源为兼容不提供 birthtime 的 Linux FS,维持
 * mtime 回退,但仍受完整 turn 时间窗约束。
 */
export function isLocalGeneratedFileInTurn(
  file: GeneratedFileRef,
  stat: GeneratedFileStat,
  turnStartMs: number | null,
  turnEndMs: number | null,
): boolean {
  if (stat.kind !== 'file' || turnStartMs === null) return false;
  const birthtimeMs =
    typeof stat.birthtimeMs === 'number' && stat.birthtimeMs > 0 ? stat.birthtimeMs : null;
  const ts = file.source === 'tool' ? birthtimeMs : (birthtimeMs ?? stat.mtimeMs);
  // tool 来源的 birthtime 是同机 FS 事实,不放宽下界:放 2 分钟 slack 会把本轮
  // 覆盖的旧文件误当新建。command 来源保留消息落库/执行时序抖动余量。
  const lowerBound =
    file.source === 'tool' ? turnStartMs : turnStartMs - TURN_START_SLACK_MS;
  return (
    typeof ts === 'number' &&
    ts >= lowerBound &&
    (turnEndMs === null || ts < turnEndMs)
  );
}

/** 折叠阈值:约两行 chip。超过则收起为「前 N 个 + 再显示 M 个文件」。 */
const MAX_VISIBLE_FILES = 6;

export function GeneratedFilesCard({
  files,
  turnStartMs,
  turnEndMs,
}: {
  files: readonly GeneratedFileRef[];
  turnStartMs: number | null;
  turnEndMs: number | null;
}) {
  const { t } = useTranslation();
  const fileCtx = useChatSessionFile();
  const remoteOrigin = isRemoteFileOrigin(fileCtx.origin) ? fileCtx.origin : null;
  // 本地会话:stat 过滤到真实存在的文件(null = 尚未算完,不渲染,避免闪现后
  // 又被过滤掉);远程:tool 来源先乐观呈现、远端 stat 复核,command 候选无法
  // 验证 mtime 一律不出(见文件头注释)。
  const [existing, setExisting] = useState<GeneratedFileRef[] | null>(
    remoteOrigin ? files.filter((f) => f.source === 'tool') : null,
  );
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (remoteOrigin) {
      const toolFiles = files.filter((f) => f.source === 'tool');
      setExisting(toolFiles);
      void (async () => {
        const checks = await Promise.all(
          toolFiles.map(async (f) => {
            const verdict = await verifyRemotePathCached(remoteOrigin, fileCtx.workingDir, f.path);
            // nonfile(不存在 / 非普通文件)/ directory 是远端确定结论 → 摘掉;
            // unknown(断链 / 限流)保持乐观。
            return verdict !== 'nonfile' && verdict !== 'directory';
          }),
        );
        if (!cancelled) setExisting(toolFiles.filter((_, idx) => checks[idx]));
      })();
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      const checks = await Promise.all(
        files.map(async (f) => {
          try {
            const r = await window.electronAPI.fsBrowse.statPath(f.path);
            return isLocalGeneratedFileInTurn(f, r, turnStartMs, turnEndMs);
          } catch {
            return false;
          }
        }),
      );
      if (!cancelled) setExisting(files.filter((_, idx) => checks[idx]));
    })();
    return () => {
      cancelled = true;
    };
  }, [files, remoteOrigin, turnStartMs, turnEndMs, fileCtx.workingDir]);

  if (!existing || existing.length === 0) return null;

  // 折叠(对标 Codex 的可展开产物列表):超过 MAX_VISIBLE_FILES 时只显示前
  // MAX_VISIBLE_FILES 个 + 「再显示 N 个文件」;展开后提供「收起」回折。
  const visible = expanded ? existing : existing.slice(0, MAX_VISIBLE_FILES);
  const hiddenCount = existing.length - visible.length;

  return (
    <div className="my-1 flex flex-col gap-1.5">
      <span className="text-12 text-[var(--text-secondary)]">
        {t('chat.generatedFiles.title')}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {visible.map((f) => (
          <GeneratedFileChip key={f.path} file={f} />
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className={cn(
              'inline-flex items-center gap-1 h-7 px-2.5 py-1.5 rounded-[9999px]',
              'text-13 text-[var(--text-secondary)]',
              'hover:bg-[var(--cmd-palette-item-hover)] transition-colors cursor-pointer',
            )}
          >
            {t('chat.generatedFiles.showMore', { count: hiddenCount })}
            <ChevronDown size={14} className="shrink-0" />
          </button>
        )}
        {expanded && existing.length > MAX_VISIBLE_FILES && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className={cn(
              'inline-flex items-center gap-1 h-7 px-2.5 py-1.5 rounded-[9999px]',
              'text-13 text-[var(--text-secondary)]',
              'hover:bg-[var(--cmd-palette-item-hover)] transition-colors cursor-pointer',
            )}
          >
            {t('chat.generatedFiles.showLess')}
            <ChevronUp size={14} className="shrink-0" />
          </button>
        )}
      </div>
    </div>
  );
}
