/**
 * GeneratedFilesCard — 每个 user turn 结尾的「本轮产出文件」卡。
 * ---------------------------------------------------------------------------
 * 对标 Codex Desktop 回复尾部的 artifact 文件卡:agent 本轮新建的文件不再只能
 * 靠模型在正文里写对 Markdown 链接才可见(Issue #1811 场景),而是从 tool_use
 * 结构化派生后集中呈现。文件来源判定见 lib/generatedFiles.ts。
 *
 * 交互:
 *   - 左键 → 与正文文件链接同策(对齐 MarkdownRenderer activateResolvedLocalTarget):
 *     可识别文件直接在 Cindy 内打开——HTML → 安全网页预览,文本/代码 →
 *     TextLightbox,图片 → ImageLightbox,glb/gltf → ModelLightbox;其余(xlsx /
 *     pdf 等)交系统默认应用(远程会话取回缓存副本再打开)。
 *   - 右键 → 共享文件 chip 菜单(复制 / 路径 / 定位 / 打开方式…),与聊天里其它
 *     文件 chip 一致。
 *
 * 存在性门槛(DESIGN.md §14.5「可点必存在」):本地会话渲染前 stat 过滤,不存在
 * 的文件不出 chip,整卡为空则不渲染。远程会话经 verifyRemotePathCached 远端 stat
 * 复核:仅在远端明确确认是普通文件后呈现；检查中、断链或限流都不先展示一张
 * 可能无法打开的完成卡。首屏等检查完成再出现。流式期间只 stat 已完成
 * (ready !== false,或本轮已封口)且尚未确认的路径;内容指纹不变就不发 IPC,
 * 已确认的 chip 留在原地,避免 messages 换引用把整页带着跳。
 *
 * 本地文件统一要求时间戳落在本轮 `[turnStartMs, turnEndMs)` 窗口内。tool 来源
 * (Write / file-change add)也不能只凭存在性:Write 可能覆盖既有文件,失败路径也可能
 * 被后续轮次创建;因此它必须有落在窗口内的 birthtime,不可用时宁可不出。
 * command 来源为兼容不提供 birthtime 的 Linux FS 允许 mtime 回退,但同样受完整
 * 时间窗约束。远程会话无法读取创建时间,维持远端 stat 的存在性复核。
 */

import { memo, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, FileImage, FileText, Globe2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useSidebarTargetSessionId } from '@/features/cc-agent/embeddedSessionNavigation';
import {
  generatedFileExtension,
  partitionBotGeneratedFiles,
} from '@/features/bots/botGeneratedArtifacts';
import { cn } from '@/lib/utils';
import type { DocumentArtifactMetadata, GeneratedFileRef } from '@/lib/generatedFiles';
import { classifyMarkdownHref, toLocalFileUrl } from '@/lib/localPathResolver';
import { isRemoteFileOrigin, toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import {
  fetchChatFileWithToasts,
  remotePathVerdictKey,
  revealRemoteChatFile,
  subscribeRemotePathVerdictChange,
  type RemotePathVerdict,
  verifyRemotePathCached,
} from '@/lib/remoteFileOpen';
import { shouldOpenTextLightboxForOrigin } from '@/lib/filePreview';
import { rewriteToRemoteMediaOrigin } from '../../../shared/remoteMediaUrl';
import { isBrowserOpenablePath } from '../../../shared/browserOpenableExts';
import { useChatSessionFile } from './ChatSessionFileContext';
import { useFileChipContextMenu } from './useFileChipContextMenu';
import { ImageLightbox } from './ImageLightbox';
import { TextLightbox } from './TextLightbox';
import { ModelLightbox } from './ModelLightbox';
import { isHtmlFilePath, openHtmlFileByPreference } from './useOpenWithMenu';

function formatArtifactSummaryValue(summary: DocumentArtifactMetadata['summary']): number | string {
  if (!summary || summary.kind !== 'bytes') return summary?.value ?? '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = summary.value;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

const DOCUMENT_COVER_THEME_TOKENS = {
  light: {
    '--doc-cover-surface': 'var(--surface-elevated)',
    '--doc-cover-tint': 'var(--surface-hover)',
    '--doc-cover-accent': 'var(--accent-cta-bg)',
    '--doc-cover-ink': 'var(--text-primary)',
    '--doc-cover-muted': 'var(--text-tertiary)',
  },
  dark: {
    '--doc-cover-surface': 'var(--surface)',
    '--doc-cover-tint': 'color-mix(in srgb, var(--surface) 88%, var(--text-primary))',
    '--doc-cover-accent': 'var(--text-primary)',
    '--doc-cover-ink': 'var(--text-primary)',
    '--doc-cover-muted': 'var(--text-secondary)',
  },
  navy: {
    '--doc-cover-surface': 'color-mix(in srgb, var(--surface-elevated) 88%, var(--focus-ring))',
    '--doc-cover-tint': 'color-mix(in srgb, var(--surface-elevated) 76%, var(--focus-ring))',
    '--doc-cover-accent': 'var(--focus-ring)',
    '--doc-cover-ink': 'var(--text-primary)',
    '--doc-cover-muted': 'var(--text-secondary)',
  },
} as const;

export function getDocumentCoverThemeStyle(
  theme: DocumentArtifactMetadata['theme'] = 'light',
): Record<string, string> {
  return DOCUMENT_COVER_THEME_TOKENS[theme] ?? DOCUMENT_COVER_THEME_TOKENS.light;
}

export function isConfirmedRemoteGeneratedFile(verdict: RemotePathVerdict): boolean {
  return verdict === 'file';
}

function DocumentCoverPreview({
  artifact,
  title,
}: {
  artifact: DocumentArtifactMetadata;
  title: string;
}) {
  const { t } = useTranslation();
  const formatLabel = t(`chat.generatedFiles.formats.${artifact.format}`);

  return (
    <span
      className="flex h-[142px] border-b border-[var(--border-default)] bg-[var(--surface)] p-3"
      style={getDocumentCoverThemeStyle(artifact.theme)}
      data-document-theme={artifact.theme ?? 'light'}
    >
      <span className="flex h-full w-full flex-col rounded-lg border border-[var(--border-default)] bg-[var(--doc-cover-surface)] px-4 py-3.5">
        <span className="flex items-center justify-between text-11 font-medium uppercase tracking-[0.1em] text-[var(--doc-cover-muted)]">
          <span>{formatLabel}</span>
          {artifact.summary && (
            <span className="normal-case tracking-normal">
              {t(`chat.generatedFiles.summary.${artifact.summary.kind}`, {
                count: formatArtifactSummaryValue(artifact.summary),
              })}
            </span>
          )}
        </span>
        <span className="mt-5 block h-1 w-9 rounded-[9999px] bg-[var(--doc-cover-accent)]" />
        <span className="mt-3 line-clamp-2 text-15 font-semibold leading-5 text-[var(--doc-cover-ink)]">
          {title}
        </span>
        {artifact.subtitle && (
          <span className="mt-1 line-clamp-1 text-11 text-[var(--doc-cover-muted)]">
            {artifact.subtitle}
          </span>
        )}
      </span>
    </span>
  );
}

function SlidePreview({ artifact, title }: { artifact: DocumentArtifactMetadata; title: string }) {
  const { t } = useTranslation();
  const preview = artifact.preview?.kind === 'slide' ? artifact.preview : undefined;
  const previewTitle = preview?.title || title;
  const previewSubtitle = preview?.subtitle || artifact.subtitle;

  return (
    <span
      className="relative flex aspect-[16/9] items-center justify-center border-b border-[var(--border-default)] bg-[var(--doc-cover-surface)] px-8 text-center"
      style={getDocumentCoverThemeStyle(artifact.theme)}
      data-document-theme={artifact.theme ?? 'light'}
    >
      <span className="min-w-0">
        <span className="mx-auto mb-3 block h-1 w-9 rounded-[9999px] bg-[var(--doc-cover-accent)]" />
        <span className="block line-clamp-2 text-15 font-semibold leading-5 text-[var(--doc-cover-ink)]">
          {previewTitle}
        </span>
        {previewSubtitle && (
          <span className="mt-1 block line-clamp-1 text-11 text-[var(--doc-cover-muted)]">
            {previewSubtitle}
          </span>
        )}
      </span>
      {artifact.summary && (
        <span className="absolute bottom-2 right-2 rounded-[9999px] border border-[var(--border-default)] px-2 py-0.5 text-11 text-[var(--doc-cover-muted)]">
          {t(`chat.generatedFiles.summary.${artifact.summary.kind}`, {
            count: formatArtifactSummaryValue(artifact.summary),
          })}
        </span>
      )}
    </span>
  );
}

function SheetPreview({ artifact, title }: { artifact: DocumentArtifactMetadata; title: string }) {
  const preview = artifact.preview?.kind === 'sheet' ? artifact.preview : undefined;
  if (!preview?.rows.length) return <DocumentCoverPreview artifact={artifact} title={title} />;

  const columnCount = Math.max(1, ...preview.rows.map((row) => row.length));
  const gridTemplateColumns =
    columnCount === 3 ? '1fr 1.6fr 1fr' : `repeat(${columnCount}, minmax(0, 1fr))`;

  return (
    <span
      className="block border-b border-[var(--border-default)] bg-[var(--doc-cover-surface)]"
      style={getDocumentCoverThemeStyle(artifact.theme)}
      data-document-theme={artifact.theme ?? 'light'}
    >
      {preview.rows.map((row, rowIndex) => (
        <span
          key={rowIndex}
          className={cn(
            'grid min-h-8 border-b border-[var(--border-default)] last:border-b-0',
            rowIndex === 0 && preview.hasHeader && 'bg-[var(--doc-cover-tint)]',
          )}
          style={{ gridTemplateColumns }}
        >
          {Array.from({ length: columnCount }, (_, columnIndex) => (
            <span
              key={columnIndex}
              className={cn(
                'min-w-0 truncate border-r border-[var(--border-default)] px-2.5 py-1.5 text-12 leading-5 text-[var(--doc-cover-ink)] last:border-r-0',
                rowIndex === 0 && preview.hasHeader && 'text-11 text-[var(--doc-cover-muted)]',
              )}
            >
              {row[columnIndex] || '\u00a0'}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

export function ArtifactPreview({
  artifact,
  title,
}: {
  artifact: DocumentArtifactMetadata;
  title: string;
}) {
  if (artifact.format === 'xlsx') return <SheetPreview artifact={artifact} title={title} />;
  if (artifact.format === 'pptx') return <SlidePreview artifact={artifact} title={title} />;
  return <DocumentCoverPreview artifact={artifact} title={title} />;
}

type GeneratedFilePresentation = 'default' | 'bot-primary' | 'bot-related';

function GeneratedFileChip({
  file,
  presentation = 'default',
}: {
  file: GeneratedFileRef;
  presentation?: GeneratedFilePresentation;
}) {
  const { t } = useTranslation();
  const fileCtx = useChatSessionFile();
  const remoteOrigin = isRemoteFileOrigin(fileCtx.origin) ? fileCtx.origin : null;
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [textLightboxOpen, setTextLightboxOpen] = useState(false);
  const [modelLightboxPath, setModelLightboxPath] = useState<string | null>(null);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const htmlWithSession = isHtmlFilePath(file.path) ? fileCtx.sessionId : undefined;
  const sidebarTargetSessionId = useSidebarTargetSessionId(htmlWithSession);
  const ctxMenu = useFileChipContextMenu({
    getAbsPath: () => file.path,
    // HTML 左键看渲染结果；源码仍可从右键菜单进入。其它生成文件沿用原菜单。
    canOpenInBrowser: isBrowserOpenablePath(file.path),
    sidebarOpenSessionId: htmlWithSession,
    onViewSource: htmlWithSession
      ? async () => {
          if (!(await shouldOpenTextLightboxForOrigin(fileCtx, file.path))) return;
          setTextLightboxOpen(true);
        }
      : undefined,
  });

  // 左键与正文文件链接同策(见文件头注释)。HTML 按网页打开偏好渲染；其它
  // 非文本兜底交给 shouldOpenTextLightboxForOrigin:本地 openPath、远程取回
  // 缓存副本,均含失败 toast。
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
    if (htmlWithSession) {
      if (remoteOrigin) {
        const cachePath = await fetchChatFileWithToasts(
          remoteOrigin,
          fileCtx.workingDir,
          file.path,
        );
        if (cachePath && sidebarTargetSessionId) {
          await openHtmlFileByPreference(sidebarTargetSessionId, cachePath, t);
        }
        return;
      }
      if (sidebarTargetSessionId) {
        await openHtmlFileByPreference(sidebarTargetSessionId, file.path, t);
      }
      return;
    }
    if (!(await shouldOpenTextLightboxForOrigin(fileCtx, file.path))) return;
    setTextLightboxOpen(true);
  };

  const artifact = file.artifact;
  const format = artifact?.format;
  const formatLabel = format ? t(`chat.generatedFiles.formats.${format}`) : null;
  const artifactTitle = artifact?.title || file.name;
  const fileExtension = generatedFileExtension(file).toUpperCase();
  const localKind = classifyMarkdownHref(file.path);
  const botImage = presentation === 'bot-primary' && localKind === 'image-local';
  const botHtml = presentation === 'bot-primary' && isHtmlFilePath(file.path);
  const botFile = presentation === 'bot-primary' && !artifact && !botImage && !botHtml;
  const localBotThumbnail = botImage ? toLocalFileUrl(file.path) : null;
  const rewrittenBotThumbnail = localBotThumbnail
    ? rewriteToRemoteMediaOrigin(
        localBotThumbnail,
        toRemoteMediaOrigin(fileCtx.origin, fileCtx.workingDir),
      )
    : null;
  // 远端 workdir 外的路径无法改写成远端媒体 URL。此时先退文件图标，避免
  // xdt-file:// 误读本机同名路径；点击仍会走既有的下载缓存 + Lightbox 链路。
  const botThumbnail =
    remoteOrigin && rewrittenBotThumbnail === localBotThumbnail ? null : rewrittenBotThumbnail;
  const summaryLabel = artifact?.summary
    ? t(`chat.generatedFiles.summary.${artifact.summary.kind}`, {
        count: formatArtifactSummaryValue(artifact.summary),
      })
    : null;

  return (
    <>
      <button
        type="button"
        title={file.path}
        onClick={() => void open()}
        onContextMenu={ctxMenu.onContextMenu}
        className={cn(
          artifact
            ? 'group block w-full max-w-[420px] cursor-pointer overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-left transition-colors hover:border-[var(--text-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]'
            : presentation === 'bot-primary'
              ? 'group block min-w-0 flex-1 basis-[220px] cursor-pointer overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-left transition-colors hover:border-[var(--text-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]'
              : 'inline-flex h-7 max-w-[280px] items-center gap-1.5 rounded-[9999px] bg-[var(--msg-md-inline-code-bg)] px-2.5 py-1.5 text-13 font-medium text-[var(--msg-assistant-text)] transition-colors hover:bg-[var(--cmd-palette-item-hover)]',
        )}
      >
        {artifact ? (
          <>
            <ArtifactPreview artifact={artifact} title={artifactTitle} />
            <span className="flex min-w-0 items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-13 font-medium leading-5 text-[var(--text-primary)]">
                  {artifactTitle}
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-11 text-[var(--text-tertiary)]">
                  <span className="shrink-0">{formatLabel}</span>
                  {summaryLabel && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0">{summaryLabel}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{file.name}</span>
                </span>
              </span>
              <span className="shrink-0 text-[var(--text-tertiary)] transition-colors group-hover:text-[var(--text-secondary)]">
                <FileText size={15} aria-hidden="true" />
              </span>
            </span>
          </>
        ) : botImage ? (
          <>
            {botThumbnail && !thumbnailFailed ? (
              <img
                src={botThumbnail}
                alt={file.name}
                onError={() => setThumbnailFailed(true)}
                className="h-[148px] w-full border-b border-[var(--border-default)] bg-[var(--surface-hover)] object-contain"
              />
            ) : (
              <span className="flex h-[104px] w-full items-center justify-center border-b border-[var(--border-default)] bg-[var(--surface-hover)] text-[var(--text-tertiary)]">
                <FileImage size={24} aria-hidden="true" />
              </span>
            )}
            <span className="flex min-w-0 items-center gap-2 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
                {file.name}
              </span>
              <span className="shrink-0 text-11 text-[var(--text-tertiary)]">{fileExtension}</span>
            </span>
          </>
        ) : botHtml ? (
          <>
            <span className="flex h-[104px] w-full flex-col items-center justify-center gap-2 border-b border-[var(--border-default)] bg-[var(--surface-hover)] text-[var(--text-secondary)]">
              <Globe2 size={24} aria-hidden="true" />
              <span className="text-11">{t('chat.generatedFiles.openWebPreview')}</span>
            </span>
            <span className="flex min-w-0 items-center gap-2 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
                {file.name}
              </span>
              <span className="shrink-0 text-11 text-[var(--text-tertiary)]">HTML</span>
            </span>
          </>
        ) : botFile ? (
          <span className="flex min-h-[64px] min-w-0 items-center gap-3 px-3 py-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-hover)] text-[var(--text-secondary)]">
              <FileText size={16} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-13 font-medium text-[var(--text-primary)]">
                {file.name}
              </span>
              {fileExtension ? (
                <span className="mt-0.5 block text-11 text-[var(--text-tertiary)]">
                  {fileExtension}
                </span>
              ) : null}
            </span>
          </span>
        ) : (
          <>
            <FileText size={14} className="shrink-0 opacity-70" />
            <span className="truncate">{file.name}</span>
          </>
        )}
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
 * 本地文件是否有足够证据归属于该 turn。普通文件工具必须有真实创建时间；
 * 只有文档工具的结构化 ok:true 结果能证明 overwrite 是本轮成功交付，此时
 * 改用 mtime。command 来源为兼容不提供 birthtime 的 Linux FS,维持 mtime
 * 回退,但仍受完整 turn 时间窗约束。
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
  const confirmedArtifactOverwrite = file.artifactConfirmed === true;
  const ts = confirmedArtifactOverwrite
    ? stat.mtimeMs
    : file.source === 'tool'
      ? birthtimeMs
      : (birthtimeMs ?? stat.mtimeMs);
  // tool 来源的 birthtime 或显式成功交付的 mtime 都是同机 FS 事实，不放宽
  // 下界；command 来源保留消息落库/执行时序抖动余量。
  const lowerBound = file.source === 'tool' ? turnStartMs : turnStartMs - TURN_START_SLACK_MS;
  return typeof ts === 'number' && ts >= lowerBound && (turnEndMs === null || ts < turnEndMs);
}

function artifactVisibleSignature(artifact: DocumentArtifactMetadata | undefined): string {
  if (!artifact) return '';
  const preview = artifact.preview ? JSON.stringify(artifact.preview) : '';
  return [
    artifact.format,
    artifact.title ?? '',
    artifact.subtitle ?? '',
    artifact.theme ?? '',
    artifact.cover === undefined ? '' : artifact.cover ? '1' : '0',
    artifact.summary?.kind ?? '',
    String(artifact.summary?.value ?? ''),
    preview,
  ].join('\t');
}

/** 决定 chip 是否换样的字段;故意不含数组引用。 */
export function generatedFileVisibleSignature(file: GeneratedFileRef): string {
  return [
    file.path,
    file.source,
    file.artifactConfirmed ? '1' : '0',
    artifactVisibleSignature(file.artifact),
  ].join('\t');
}

/** 未完成的 tool_use 在本轮还没封口时不 stat:文件多半还没落盘。 */
export function isGeneratedFileStatable(
  file: GeneratedFileRef,
  turnEndMs: number | null,
  turnSealed = false,
): boolean {
  return file.ready !== false || turnEndMs !== null || turnSealed;
}

/**
 * 卡片是否要重查的内容指纹。只计入当前可 stat 的文件,流式 token /
 * 未完成的 Write 换新数组不会触发 IPC。
 */
export function generatedFilesCheckKey(
  files: readonly GeneratedFileRef[],
  turnStartMs: number | null,
  turnEndMs: number | null,
  turnSealed = false,
): string {
  return [
    String(turnStartMs ?? ''),
    String(turnEndMs ?? ''),
    turnSealed ? '1' : '0',
    ...files
      .filter((file) => isGeneratedFileStatable(file, turnEndMs, turnSealed))
      .map((file) => generatedFileVisibleSignature(file)),
  ].join('\0');
}

/**
 * 文件列表增量更新时,先留下已经确认过的 chip。
 * 流式中候选从 A 换成 C 时先留着 A,等 C 的 stat 完成再替换,避免整卡先卸再挂。
 * 本轮封口或环境变了才允许立刻丢掉已消失的路径。
 * 首屏 previous 为 null,保持「检查完成前不展示」。
 */
export function retainVisibleGeneratedFiles(
  previous: GeneratedFileRef[] | null,
  nextCandidates: readonly GeneratedFileRef[],
  options?: { dropMissing?: boolean },
): GeneratedFileRef[] | null {
  if (!previous || previous.length === 0) return previous;
  const dropMissing = options?.dropMissing === true;
  const nextByPath = new Map(nextCandidates.map((file) => [file.path, file]));
  const kept: GeneratedFileRef[] = [];
  let changed = false;
  for (const file of previous) {
    const next = nextByPath.get(file.path);
    if (!next) {
      if (dropMissing) {
        changed = true;
        continue;
      }
      kept.push(file);
      continue;
    }
    if (generatedFileVisibleSignature(next) !== generatedFileVisibleSignature(file)) {
      changed = true;
      kept.push(next);
    } else {
      kept.push(file);
    }
  }
  if (kept.length !== previous.length) changed = true;
  return changed ? kept : previous;
}

/** stat 结果没变时沿用旧数组,避免无意义的 setState 把卡片再刷一遍。 */
export function reuseGeneratedFilesIfUnchanged(
  previous: GeneratedFileRef[] | null,
  next: GeneratedFileRef[],
): GeneratedFileRef[] {
  if (
    previous &&
    previous.length === next.length &&
    previous.every(
      (file, index) =>
        generatedFileVisibleSignature(file) === generatedFileVisibleSignature(next[index]),
    )
  ) {
    return previous;
  }
  return next;
}

export function planGeneratedFilesVisibility(input: {
  previousVisible: GeneratedFileRef[] | null;
  candidates: readonly GeneratedFileRef[];
  turnEndMs: number | null;
  envChanged: boolean;
  turnWindowChanged: boolean;
  forceRestat?: boolean;
  turnSealed?: boolean;
}): { visible: GeneratedFileRef[] | null; toStat: GeneratedFileRef[] } {
  const turnSealed = input.turnSealed === true;
  const statable = input.candidates.filter((file) =>
    isGeneratedFileStatable(file, input.turnEndMs, turnSealed),
  );
  if (input.envChanged) {
    return { visible: null, toStat: statable };
  }
  const previousPaths = new Set((input.previousVisible ?? []).map((file) => file.path));
  const hasIncomingReplacement = statable.some((file) => !previousPaths.has(file.path));
  const visible = retainVisibleGeneratedFiles(input.previousVisible, input.candidates, {
    // 有新候选在 stat 时暂留旧 chip，避免 A→C 中间卸卡；单纯删除没有替补则立刻撤。
    // 最新一轮没有后续 user 边界时 turnEndMs 仍是 null，要用封口信号触发复核。
    dropMissing: input.turnEndMs !== null || turnSealed || !hasIncomingReplacement,
  });
  if (input.turnWindowChanged || input.forceRestat) {
    return { visible, toStat: statable };
  }
  const confirmedPaths = new Set((input.previousVisible ?? []).map((file) => file.path));
  return {
    visible,
    toStat: statable.filter((file) => !confirmedPaths.has(file.path)),
  };
}

export function mergeGeneratedFileStatResults(input: {
  previousVisible: GeneratedFileRef[] | null;
  candidates: readonly GeneratedFileRef[];
  checked: readonly GeneratedFileRef[];
  confirmedPaths: ReadonlySet<string>;
  turnWindowChanged: boolean;
}): GeneratedFileRef[] {
  const trusted = new Set<string>();
  if (!input.turnWindowChanged && input.previousVisible) {
    const checkedPaths = new Set(input.checked.map((file) => file.path));
    for (const file of input.previousVisible) {
      if (!checkedPaths.has(file.path)) trusted.add(file.path);
    }
  }
  for (const path of input.confirmedPaths) trusted.add(path);
  return input.candidates.filter((file) => trusted.has(file.path));
}

/** 折叠阈值:约两行 chip。超过则收起为「前 N 个 + 再显示 M 个文件」。 */
const MAX_VISIBLE_FILES = 6;
const MAX_VISIBLE_BOT_ARTIFACTS = 4;

function generatedFilesCardPropsEqual(
  prev: {
    files: readonly GeneratedFileRef[];
    turnStartMs: number | null;
    turnEndMs: number | null;
    turnSealed?: boolean;
    botArtifacts?: boolean;
  },
  next: {
    files: readonly GeneratedFileRef[];
    turnStartMs: number | null;
    turnEndMs: number | null;
    turnSealed?: boolean;
    botArtifacts?: boolean;
  },
): boolean {
  return (
    prev.botArtifacts === next.botArtifacts &&
    generatedFilesCheckKey(prev.files, prev.turnStartMs, prev.turnEndMs, prev.turnSealed) ===
      generatedFilesCheckKey(next.files, next.turnStartMs, next.turnEndMs, next.turnSealed)
  );
}

export const GeneratedFilesCard = memo(function GeneratedFilesCard({
  files,
  turnStartMs,
  turnEndMs,
  turnSealed = false,
  botArtifacts = false,
}: {
  files: readonly GeneratedFileRef[];
  turnStartMs: number | null;
  turnEndMs: number | null;
  turnSealed?: boolean;
  /** 伙伴会话专属：成果优先、辅助文件默认收起。 */
  botArtifacts?: boolean;
}) {
  const { t } = useTranslation();
  const fileCtx = useChatSessionFile();
  const remoteOrigin = isRemoteFileOrigin(fileCtx.origin) ? fileCtx.origin : null;
  // 首屏保持 null。之后按内容指纹增量 stat:未完成的 tool_use 不查,
  // 已确认的路径不重复 IPC,工作目录 / 远端来源变了才整卡重来。
  const [existing, setExisting] = useState<GeneratedFileRef[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [relatedExpanded, setRelatedExpanded] = useState(false);
  const [remoteVerdictGen, setRemoteVerdictGen] = useState(0);
  const checkKey = generatedFilesCheckKey(files, turnStartMs, turnEndMs, turnSealed);
  const filesRef = useRef(files);
  filesRef.current = files;
  const visibleRef = useRef<GeneratedFileRef[] | null>(null);
  const checkEnvRef = useRef({ remoteOrigin, workingDir: fileCtx.workingDir });
  const turnWindowRef = useRef({ turnStartMs, turnEndMs, turnSealed });
  const remoteVerdictGenRef = useRef(remoteVerdictGen);

  useEffect(() => {
    if (!remoteOrigin) return;
    const watched = new Set(
      files
        .filter(
          (file) => file.source === 'tool' && isGeneratedFileStatable(file, turnEndMs, turnSealed),
        )
        .map((file) => remotePathVerdictKey(remoteOrigin, fileCtx.workingDir, file.path)),
    );
    if (watched.size === 0) return;
    return subscribeRemotePathVerdictChange((key) => {
      if (watched.has(key)) setRemoteVerdictGen((generation) => generation + 1);
    });
  }, [remoteOrigin, fileCtx.workingDir, checkKey, files, turnEndMs, turnSealed]);

  useEffect(() => {
    let cancelled = false;
    const currentFiles = filesRef.current;
    const envChanged =
      checkEnvRef.current.remoteOrigin !== remoteOrigin ||
      checkEnvRef.current.workingDir !== fileCtx.workingDir;
    const turnWindowChanged =
      turnWindowRef.current.turnStartMs !== turnStartMs ||
      turnWindowRef.current.turnEndMs !== turnEndMs ||
      turnWindowRef.current.turnSealed !== turnSealed;
    const forceRestat = remoteVerdictGenRef.current !== remoteVerdictGen;
    checkEnvRef.current = { remoteOrigin, workingDir: fileCtx.workingDir };
    turnWindowRef.current = { turnStartMs, turnEndMs, turnSealed };
    remoteVerdictGenRef.current = remoteVerdictGen;

    const plan = planGeneratedFilesVisibility({
      previousVisible: envChanged ? null : visibleRef.current,
      candidates: currentFiles,
      turnEndMs,
      envChanged,
      turnWindowChanged,
      forceRestat,
      turnSealed,
    });
    visibleRef.current = plan.visible;
    if (plan.visible === null) {
      setExisting(null);
    } else {
      setExisting((prev) => reuseGeneratedFilesIfUnchanged(prev, plan.visible ?? []));
    }

    const toStat = remoteOrigin
      ? plan.toStat.filter((file) => file.source === 'tool')
      : plan.toStat;
    if (toStat.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const confirmedPaths = new Set<string>();
      if (remoteOrigin) {
        const checks = await Promise.all(
          toStat.map(async (file) => {
            const verdict = await verifyRemotePathCached(
              remoteOrigin,
              fileCtx.workingDir,
              file.path,
            );
            return isConfirmedRemoteGeneratedFile(verdict);
          }),
        );
        checks.forEach((ok, index) => {
          if (ok) confirmedPaths.add(toStat[index].path);
        });
      } else {
        const checks = await Promise.all(
          toStat.map(async (file) => {
            try {
              const stat = await window.electronAPI.fsBrowse.statPath(file.path);
              return isLocalGeneratedFileInTurn(file, stat, turnStartMs, turnEndMs);
            } catch {
              return false;
            }
          }),
        );
        checks.forEach((ok, index) => {
          if (ok) confirmedPaths.add(toStat[index].path);
        });
      }
      if (cancelled) return;
      const merged = mergeGeneratedFileStatResults({
        previousVisible: envChanged ? null : visibleRef.current,
        candidates: filesRef.current,
        checked: toStat,
        confirmedPaths,
        turnWindowChanged,
      });
      visibleRef.current = merged;
      setExisting((prev) => reuseGeneratedFilesIfUnchanged(prev, merged));
    })();

    return () => {
      cancelled = true;
    };
  }, [
    checkKey,
    remoteOrigin,
    turnStartMs,
    turnEndMs,
    turnSealed,
    fileCtx.workingDir,
    remoteVerdictGen,
  ]);

  if (!existing || existing.length === 0) return null;

  if (botArtifacts) {
    const { primary, related } = partitionBotGeneratedFiles(existing, fileCtx.workingDir);
    const visiblePrimary = expanded ? primary : primary.slice(0, MAX_VISIBLE_BOT_ARTIFACTS);
    const hiddenPrimaryCount = primary.length - visiblePrimary.length;

    return (
      <div className="my-1 flex max-w-[680px] flex-col gap-2" data-testid="bot-generated-artifacts">
        {primary.length > 0 ? (
          <>
            <span className="text-12 font-medium text-[var(--text-secondary)]">
              {t('chat.generatedFiles.botTitle')}
            </span>
            <div className="flex flex-wrap gap-2">
              {visiblePrimary.map((file) => (
                <GeneratedFileChip key={file.path} file={file} presentation="bot-primary" />
              ))}
            </div>
            {hiddenPrimaryCount > 0 ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="flex h-7 w-fit items-center gap-1 rounded-[9999px] px-2.5 py-1.5 text-13 text-[var(--text-secondary)] transition-colors hover:bg-[var(--cmd-palette-item-hover)]"
              >
                {t('chat.generatedFiles.showMore', { count: hiddenPrimaryCount })}
                <ChevronDown size={14} className="shrink-0" />
              </button>
            ) : null}
            {expanded && primary.length > MAX_VISIBLE_BOT_ARTIFACTS ? (
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="flex h-7 w-fit items-center gap-1 rounded-[9999px] px-2.5 py-1.5 text-13 text-[var(--text-secondary)] transition-colors hover:bg-[var(--cmd-palette-item-hover)]"
              >
                {t('chat.generatedFiles.showLess')}
                <ChevronUp size={14} className="shrink-0" />
              </button>
            ) : null}
          </>
        ) : null}
        {related.length > 0 ? (
          <div className="flex flex-col items-start gap-2">
            <button
              type="button"
              onClick={() => setRelatedExpanded((value) => !value)}
              aria-expanded={relatedExpanded}
              className="flex h-7 items-center gap-1 rounded-[9999px] px-2.5 py-1.5 text-12 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--text-secondary)]"
            >
              {t('chat.generatedFiles.relatedFiles', { count: related.length })}
              {relatedExpanded ? (
                <ChevronUp size={13} className="shrink-0" />
              ) : (
                <ChevronDown size={13} className="shrink-0" />
              )}
            </button>
            {relatedExpanded ? (
              <div className="flex flex-wrap gap-2">
                {related.map((file) => (
                  <GeneratedFileChip key={file.path} file={file} presentation="bot-related" />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  // 折叠(对标 Codex 的可展开产物列表):超过 MAX_VISIBLE_FILES 时只显示前
  // MAX_VISIBLE_FILES 个 + 「再显示 N 个文件」;展开后提供「收起」回折。
  const visible = expanded ? existing : existing.slice(0, MAX_VISIBLE_FILES);
  const hiddenCount = existing.length - visible.length;

  const hasArtifacts = existing.some((file) => file.artifact);
  const hasOnlyArtifacts = existing.every((file) => file.artifact);

  return (
    <div className="my-1 flex flex-col gap-2">
      {!hasOnlyArtifacts && (
        <span className="text-12 font-medium text-[var(--text-secondary)]">
          {t('chat.generatedFiles.title')}
        </span>
      )}
      <div className={cn('flex flex-wrap gap-2', hasArtifacts && 'flex-col')}>
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
}, generatedFilesCardPropsEqual);
