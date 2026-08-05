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
 * source==='command' 的候选(从 Bash/exec 命令文本启发式提取,见 generatedFiles.ts)
 * 额外要求文件时间戳落在本轮 `[turnStartMs, turnEndMs)` 窗口内:命令里出现的
 * 既有输入文件早于下界被滤掉;后续 turn 才创建/改写同一路径时晚于上界,旧卡也
 * 不会被新的 stat 结果误点亮。尾部当前 turn 无上界,只查下界。时间窗不可得或
 * 远程会话(无法 stat)时 command 候选一律不出——宁缺毋滥。
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
          'text-[13px] font-medium text-[var(--msg-assistant-text)]',
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
            if (r.kind !== 'file') return false;
            if (f.source === 'tool') return true;
            if (turnStartMs === null) return false;
            // command 候选:创建时间不早于本轮开始才算「本轮新建」。birthtime
            // 优先(Windows/APFS 可靠,且能排除命令只是改写/引用的既有文件);
            // 不可用(部分 Linux FS 恒 0)退回 mtime 下界。都只查下界,用户事后
            // 编辑文件不会让 chip 消失。
            const ts =
              typeof r.birthtimeMs === 'number' && r.birthtimeMs > 0 ? r.birthtimeMs : r.mtimeMs;
            return (
              typeof ts === 'number' &&
              ts >= turnStartMs - TURN_START_SLACK_MS &&
              // 历史 turn 有下一条 user 边界:文件时间戳必须严格早于边界。
              // 上界不加 slack——边界后的文件无论时钟抖动都不属于上一轮。
              (turnEndMs === null || ts < turnEndMs)
            );
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
              'text-[13px] text-[var(--text-secondary)]',
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
              'text-[13px] text-[var(--text-secondary)]',
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
