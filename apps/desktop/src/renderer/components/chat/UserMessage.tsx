/**
 * UserMessage
 * ---------------------------------------------------------------------------
 * Right-aligned chat bubble for user messages.
 *
 * F-MSG-1: user message styling
 * - Card background + 1px Board border + 12px radius
 * - Max width 520px, right-aligned
 * - Inline chips for `@file`, `@dir/`, `@.claude/agents/x.md`, `/command`
 *
 * F-MSG-IMG: image attachments rendered above text bubble (rounded-12, max-w 280px)
 * F-MSG-DOC: document paths rendered inline as @path chips in text content
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  File as FileIcon,
  FileText,
  Folder as FolderIcon,
  Sparkles,
  Target,
} from 'lucide-react';
import { readAgentInputReferences } from '@cindy/maker-shared/agent-input-projection';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { cn } from '@/lib/utils';
import { resolveLocalPath, resolveLocalPathSmart, toLocalFileUrl } from '@/lib/localPathResolver';
import { isBrowserOpenablePath } from '../../../shared/browserOpenableExts';
import { toast } from '@/lib/toast';
import { shouldOpenTextLightboxForOrigin } from '@/lib/filePreview';
import {
  isSafetyDowngradedAttachment,
  saveChatAttachmentWithToasts,
} from '@/lib/chatAttachmentSave';
import { saveDraft as saveComposerDraft } from '@/lib/composerDraftStore';
import { emitPatch as emitSessionPatch } from '@/lib/sessionsBus';
import { makerChatStore } from '@/lib/makerChatStore';
import type {
  Session,
  AgentKind as RendererAgentKind,
  MessageAutomationOrigin,
} from '@/lib/ccAgent.types';
import type { PastedTextRange, SlashCommandRange } from '@/lib/imageRef';
import type { AgentInputReference } from '../../../shared/agentInputQueue';
import type { PersistedSessionReferenceMetadata } from '../../../shared/sessionReferenceMetadata';
import { buildRewindDraftAttachments } from '@/lib/rewindDraftAttachments';
import {
  useAgentCapabilities,
  type AgentKind as MakerAgentKind,
} from '@/hooks/useAgentCapabilities';
import { useGitSafetyAutoSnapshotEnabledForDevice } from '@/hooks/useGitSafetySettings';
import { useChatSessionFile } from './ChatSessionFileContext';
import { isRemoteFileOrigin, originDeviceId, toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import { rewriteToRemoteMediaOrigin } from '../../../shared/remoteMediaUrl';
import { ImageLightbox } from './ImageLightbox';
import {
  joinChatQuoteTextSegments,
  formatQuoteForSend,
  parseChatQuoteSegments,
  stripChatQuoteMarkerLines,
  type ChatQuoteSegment,
} from '@/lib/chatQuotes';
import { quoteSegmentsToComposerDocument } from '@/lib/composerQuoteDocument';
import { ChatImageView } from './ChatImageView';
import { TextLightbox } from './TextLightbox';
import { ToolPayloadLightbox } from './ToolPayloadLightbox';
import { MessageActionBar } from './MessageActionBar';
import { shareSelectionStore } from './shareSelectionStore';
import { ErrorMessageCard } from './ErrorMessageCard';
import { useForkAtMessage, textToTiptapDoc } from './useForkAtMessage';
import { useDeleteMessage } from './useDeleteMessage';
import {
  isInteractiveSessionNavigationMode,
  useSessionNavigationMode,
} from '@/features/cc-agent/embeddedSessionNavigation';
import { RewindPreviewDialog } from './RewindPreviewDialog';
import { UserMessageEditBox } from './UserMessageEditBox';
import HookTaskCard from './HookTaskCard';
import { useFileChipContextMenu } from './useFileChipContextMenu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  mayExceedVisualLineThreshold,
  useUserMessageAutoCollapse,
} from './userMessageCollapse';
import { findLinkifyMatches } from './userMessageLinkify';
import { SessionLinkChip } from './SessionLinkChip';
import { ProjectLinkChip } from './ProjectLinkChip';
import { buildSessionMessageDeepLink, parseSessionDeepLinkHref } from '@/lib/deepLink';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { insertSessionLinkIntoComposer } from '@/lib/composerActionsBus';
import { MENTION_TOKEN_SPLIT, parseMentionToken } from '@/lib/mentionRefFormat';
import { parseGhostCommandWord, splitGhostDirective } from '@/cindy-brain/ghostCommand';
import { splitHostCapabilityDirective } from '@/cindy-brain/hostCapabilityInvocation';
import {
  GhostFulfillmentContext,
  GhostSummonCard,
  type GhostSummonDisplay,
} from './GhostSummonCard';
import { AutomationOriginBadge } from './AutomationOriginBadge';
import { UserMessageUrlLink } from './UserMessageUrlLink';
import { InlineReferenceChip } from './InlineReferenceChip';
import { QuoteChip } from './QuoteChip';
import { SentAgentReferenceChip, sentAgentReferenceDisplayLabel } from './SentAgentReferenceChip';
import { parseOrcaCommunicationContent, resolveUserDisplayText } from './userMessageDisplayText';

/**
 * image-local-cache: a user-message image can be in two shapes:
 *   - cached (xdt-image:// url) — the persistent, primary form
 *   - F6 fallback (in-memory base64) — only until session restart
 */
type UserImageItem =
  | {
      url: string;
      mimeType: string;
      originalName: string;
      /** 非破坏性标注(见 imageRef.ts):原图 url + 矢量笔迹,历史图可再编辑。 */
      annotationSourceUrl?: string;
      annotationStrokes?: Array<{ points: Array<{ x: number; y: number }> }>;
    }
  | { base64: string; mimeType: string; originalName?: string };

interface UserMessageProps {
  /** F2: session cwd used to resolve relative paths in inline @-chip refs.
   *  Stable per-session — only changes on session switch. */
  workingDir: string;
  content: string;
  /** Resolved range summaries for session links in this user message. */
  sessionReferences?: PersistedSessionReferenceMetadata[];
  /** chat-text-quote:content 开头 blockquote 为引用功能产出(胶囊化渲染判据)。 */
  quotesEncoded?: boolean;
  /** Hidden semantic reference ranges; preserved only while visible text is unchanged. */
  agentReferences?: AgentInputReference[];
  pastedTextRanges?: PastedTextRange[];
  slashCommandRanges?: SlashCommandRange[];
  images?: UserImageItem[];
  files?: Array<{ name: string; path: string }>;
  /** ISO timestamp for the smart-time display in the hover action bar. */
  createdAt?: string;
  /** Active session id; required to wire the Fork button. When omitted,
   *  the Fork button is not rendered. */
  sessionId?: string;
  /** Owning agent kind (renderer 短名 'cc' | 'codex') — gates Fork/Rewind icon
   *  visibility via capabilities. Codex rewind additionally requires the Git
   *  safety snapshot setting because file rewind depends on savepoint commits. */
  agentKind?: RendererAgentKind;
  /** Owning session's remote SSH host id (null for local). Remote cc daemon
   *  sessions don't support the query-rebuild that Fork/Rewind need yet (MVP),
   *  so both actions are hidden when this is set. */
  remoteHostId?: string | null;
  /** clientId of this message (== messages.client_id in DB). Backend's
   *  fork IPC takes (sessionId, clientId) to locate the fork point. When
   *  omitted, the Fork button is not rendered. */
  messageClientId?: string;
  /** Whether this session currently has an in-flight SDK turn. Rewind uses it
   *  to select stop-then-rewind confirmation; fork is allowed from stable history. */
  sessionRunning?: boolean;
  /** Host-side delivery marker. Same-turn steer user rows are unstable while running. */
  delivery?: 'turn' | 'steer';
  /** True iff this is the first user message in the visible list. Both
   *  Fork and Rewind buttons are hidden — fork-at-first 等价于复制整条
   *  session（无意义），rewind-at-first 后端会抛 NO_PRIOR_ASSISTANT。 */
  isFirstUserMessage?: boolean;
  /** True iff this is the LAST user message in the full message list.
   *  edit-last-message: 只有最后一条 user 消息显示编辑入口(编辑 = rewind 到
   *  这条 + 重发,更早的消息编辑会静默丢弃后续轮次,v1 不开放)。 */
  isLastUserMessage?: boolean;
  /** scheduler 注入的消息来源标记;存在时在气泡上方渲染"由自动化任务发送"标签。 */
  automationOrigin?: MessageAutomationOrigin;
  /** Hook 来源元数据;存在时渲染左对齐 Cindy 署名任务卡片(替代右对齐气泡)。 */
  hookSource?: {
    im: string;
    channelName?: string | null;
    userText?: string;
    threadContext?: Array<{ author: string; text: string; isBot?: boolean }>;
  };
  /** /goal 目标设定/更新标记:在气泡上方渲一个「目标 / 目标已更新」徽标。 */
  goalBadge?: { updated: boolean };
  /** 订阅槽①:本条消息被意识钩子拦下(未发出)。存在时气泡下方渲一条 error
   *  红条(内容 = 意识返回文本,直接显示);用户用编辑铅笔改了重发。 */
  blockedByGhost?: { ghostId: string; ghostName: string; reason: string };
}

export function shouldBlockUserFork(
  sessionRunning?: boolean,
  delivery?: 'turn' | 'steer',
): boolean {
  return sessionRunning === true && delivery === 'steer';
}

/**
 * UserFileChip — `@file` chip in a user message. Left click opens TextLightbox
 * via onClick; right click opens the shared file-chip menu (copy / copy path /
 * reveal in folder). Extracted into a component so the hook can run; renderContent
 * itself isn't a React component and can't call hooks directly.
 */
function UserFileChip({
  refText,
  fileName,
  workingDir,
  onClick,
}: {
  refText: string;
  fileName: string;
  workingDir: string;
  // chip 由 InlineReferenceChip 渲染成 `<span role="button">`(见其剪贴板契约),
  // 不再是原生 `<button>`;这里标 HTMLElement 与实际 currentTarget 对齐。
  onClick: (e: React.MouseEvent<HTMLElement>) => void | Promise<void>;
}) {
  // remote 会话:fs:resolve-path 打的是本机 fs,对远程 workdir 恒 none——
  // 按 workdir 风格直接 join(与 useResolvedMarkdownTarget 的 remote 分支同策)。
  const chipRemote = isRemoteFileOrigin(useChatSessionFile().origin);
  const ctxMenu = useFileChipContextMenu({
    getAbsPath: async () => {
      if (chipRemote) return resolveLocalPath(refText, workingDir);
      const r = await resolveLocalPathSmart(refText, workingDir);
      if (r.status === 'unique') return r.absPath;
      if (r.status === 'multiple') return r.candidates[0] ?? refText;
      return r.fallbackAbsPath;
    },
    canOpenInBrowser: isBrowserOpenablePath(refText),
  });
  return (
    <>
      <InlineReferenceChip
        label={fileName}
        icon={<FileIcon aria-hidden />}
        tooltip={refText}
        tooltipMono
        ariaLabel={fileName}
        onClick={onClick}
        onContextMenu={ctxMenu.onContextMenu}
        className="relative top-[-1px] -my-[1px] max-w-[min(240px,55vw)] align-middle"
      />
      {ctxMenu.menu}
    </>
  );
}

/**
 * UserAttachmentChip — 用户消息下方的文件附件 chip(与正文里的 `@file` 引用
 * chip 是两种呈现;此前只有 onClick,右键无反应,与 UserFileChip 交互不一致,
 * Issue #1811 讨论中实捉)。左键保持既有行为:安全降级附件走另存流程,其余
 * 文本预览 / 交系统默认应用。右键:
 *   - 普通附件 → 共享文件 chip 菜单(复制 / 路径 / 定位等,与 UserFileChip 同款);
 *   - 安全降级附件 → 仅「另存为…」单项。受控 `.bin` 副本的路径不该经「复制
 *     文件路径 / 打开所在目录」外泄,打开类动作更会绕过降级本身。
 */
function UserAttachmentChip({
  file,
  onOpenTextPreview,
}: {
  file: { name: string; path: string };
  /** 文本预览分支的回调:父组件记录 chip 元素(关闭预览后焦点复位)并开 lightbox。 */
  onOpenTextPreview: (chip: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  const sessionFileCtx = useChatSessionFile();
  const downloadOnly = isSafetyDowngradedAttachment(file);
  // Rules-of-hooks:两个菜单 hook/状态都无条件建,按 downloadOnly 选用其一。
  const ctxMenu = useFileChipContextMenu({
    getAbsPath: () => file.path,
    canOpenInBrowser: isBrowserOpenablePath(file.path),
  });
  const [saveMenuPos, setSaveMenuPos] = useState<{ x: number; y: number } | null>(null);

  const saveOnlyMenu = (
    <DropdownMenu
      open={saveMenuPos !== null}
      onOpenChange={(open) => {
        if (!open) setSaveMenuPos(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          data-fixed-menu-anchor
          style={{
            position: 'fixed',
            left: saveMenuPos?.x ?? 0,
            top: saveMenuPos?.y ?? 0,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={2} onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem
          onClick={() => {
            setSaveMenuPos(null);
            void saveChatAttachmentWithToasts(sessionFileCtx, file);
          }}
        >
          <Download className="mr-2 h-4 w-4" />
          {t('chat.media.saveAs')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      <button
        type="button"
        aria-label={
          downloadOnly ? t('chat.userMessage.saveAttachmentAs', { name: file.name }) : undefined
        }
        onClick={async (e) => {
          if (downloadOnly) {
            await saveChatAttachmentWithToasts(sessionFileCtx, file);
            return;
          }
          const chip = e.currentTarget;
          if (!(await shouldOpenTextLightboxForOrigin(sessionFileCtx, file.path))) return;
          onOpenTextPreview(chip);
        }}
        onContextMenu={(e) => {
          if (downloadOnly) {
            e.preventDefault();
            e.stopPropagation();
            setSaveMenuPos({ x: e.clientX, y: e.clientY });
            return;
          }
          ctxMenu.onContextMenu(e);
        }}
        className={cn(
          'inline-flex items-center gap-1.5',
          'h-7 px-2.5 py-1.5',
          'rounded-[9999px]',
          'bg-[var(--msg-user-bg)]',
          'border border-[var(--msg-user-border)]',
          'text-13 font-medium',
          'text-[var(--msg-user-text)]',
          'hover:bg-[var(--cmd-palette-item-hover)]',
          'transition-colors cursor-pointer',
          'max-w-[280px]',
        )}
      >
        {downloadOnly ? (
          <Download size={14} className="shrink-0 text-[var(--msg-user-text)]" />
        ) : (
          <FileText size={14} className="shrink-0 text-[var(--msg-user-text)]" />
        )}
        <span className="truncate">{file.name}</span>
      </button>
      {downloadOnly ? saveOnlyMenu : ctxMenu.menu}
    </>
  );
}

/**
 * Render a plain-text segment, converting:
 *   - http(s) URLs into links that follow the user's opening preference
 *   - bare absolute image paths into clickable buttons that open the
 *     ImageLightbox via the xdt-file:// custom protocol
 * Everything else is returned as-is string fragments.
 */
function renderTextWithLinks(
  text: string,
  keyPrefix: string,
  onImageClick: ((xdtFileUrl: string) => void) | undefined,
  sessionId?: string,
  sessionReferences?: readonly PersistedSessionReferenceMetadata[],
  interactive = true,
): React.ReactNode[] {
  if (!interactive) return [text];

  const result: React.ReactNode[] = [];
  const matches = findLinkifyMatches(text);
  let lastIndex = 0;

  for (const match of matches) {
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index));
    }
    if (match.kind === 'url') {
      const url = match.text;
      result.push(
        <UserMessageUrlLink
          key={`${keyPrefix}-url-${match.index}`}
          url={url}
          sessionId={sessionId}
        />,
      );
    } else if (match.kind === 'session') {
      const target = parseSessionDeepLinkHref(match.href);
      const referenceMetadata = target
        ? sessionReferences?.find(
            (reference) =>
              reference.sessionId === target.sessionId &&
              (reference.messageClientId ?? null) === target.messageClientId,
          )
        : undefined;
      // 会话深链 → chip(显式 label / 标题 / 短 ID),点击跳会话、带锚点定位
      // 消息。`[标题](深链)` markdown 形式(输入框粘贴 chip 化的序列化产物)
      // 带显式 label,SessionLinkChip 优先展示、不查库。
      result.push(
        <SessionLinkChip
          key={`${keyPrefix}-session-${match.index}`}
          href={match.href}
          label={match.label}
          referenceMetadata={referenceMetadata}
        />,
      );
    } else if (match.kind === 'project') {
      // 项目深链 → chip(显式 label / 目录名),点击聚焦侧边栏 project 节点。
      result.push(
        <ProjectLinkChip
          key={`${keyPrefix}-project-${match.index}`}
          href={match.href}
          label={match.label}
        />,
      );
    } else {
      const p = match.text;
      result.push(
        <button
          key={`${keyPrefix}-img-${match.index}`}
          type="button"
          onClick={() => onImageClick?.(toLocalFileUrl(p))}
          // 同 UserMessageUrlLink:可点 = 正文色 + 常显下划线,不再靠 --msg-link 颜色。
          className="underline underline-offset-2 cursor-pointer break-all"
        >
          {p}
        </button>,
      );
    }
    lastIndex = match.index + match.length;
  }

  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }
  return result;
}

/**
 * Heuristic: does a `@ref` look like a real file/dir/agent path?
 *
 * Positive signals (any one is enough):
 *   - Contains `/`           → looks like a path  (e.g. `src/App.tsx`)
 *   - Has a file extension   → looks like a file  (e.g. `App.tsx`)
 *   - Starts with `.`        → dotfile / dotdir   (e.g. `.env`)
 *
 * Plain words like `@someone`, `@123131312`, `@param` → false.
 */
function looksLikePath(ref: string): boolean {
  if (ref.includes('/')) return true;
  if (/\.\w{1,10}$/.test(ref)) return true;
  if (ref.startsWith('.')) return true;
  return false;
}

/**
 * Heuristic: does a `/word` at line start look like a real command name?
 *
 * Must start with a letter, contain only letters/digits/hyphens/underscores,
 * and be reasonably short (≤ 30 chars). This matches real commands like
 * `compact`, `sivi-halt`, `help` but rejects paths like `/etc/passwd` and
 * noise like `/1312312`.
 */
function looksLikeCommand(word: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,29}$/.test(word);
}

/**
 * Parse serialized message content and render @mentions and /commands as
 * inline chips — but only when they look like real file paths or command
 * names. Plain `@word` and arbitrary `/text` are left as normal text.
 *
 * Chip patterns:
 *   @.claude/agents/name.md  → agent chip (sparkles + name)
 *   @path/to/dir/            → dir chip (folder + dirname/)
 *   @path/to/file.ext        → file chip (file + basename) — clickable
 *   /command (at line start) → slash chip (no icon, /command)
 *
 * Plain text segments are further scanned for URLs, which are rendered as
 * clickable links that open in the system default browser.
 *
 * F2: file chips are clickable (they open TextLightbox); dir/agent/slash chips
 * are inert — no click target in this iteration. Both render through
 * InlineReferenceChip, whose interactive shell is a `<span role="button">`
 * rather than a native `<button>` so copied messages survive an external
 * paste (see the clipboard contract on InlineReferenceChip).
 *
 * @param content       The user message content to parse.
 * @param workingDir    Session cwd; used to resolve relative refs.
 * @param onFileChipClick  Called when a file chip is clicked. Receives the
 *                          resolved abs path, the displayed file name, and
 *                          the clicked chip element (for focus restoration
 *                          when the lightbox closes — F6).
 */
function renderContentWithoutPastedText(
  content: string,
  workingDir: string,
  onFileChipClick:
    ((abs: string, name: string, chip: HTMLElement) => void | Promise<void>) | undefined,
  onImageClick: ((xdtFileUrl: string) => void) | undefined,
  t: TFunction,
  sessionId?: string,
  /** remote 会话:@-chip 点击跳过本机 smart resolve,按 workdir 风格直接 join。 */
  remoteJoin = false,
  renderLegacySlashCommands = true,
  sessionReferences?: readonly PersistedSessionReferenceMetadata[],
  interactive = true,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const lines = content.split('\n');

  for (let li = 0; li < lines.length; li++) {
    if (li > 0) nodes.push('\n');
    let line = lines[li];

    // Check for /command at line start — only if it looks like a real command
    const slashMatch = line.match(/^\/(\S+)/);
    if (renderLegacySlashCommands && slashMatch && looksLikeCommand(slashMatch[1])) {
      nodes.push(
        <InlineReferenceChip
          key={`s-${li}`}
          label={`/${slashMatch[1]}`}
          tooltip={`/${slashMatch[1]}`}
          className="relative top-[-1px] -my-[1px] max-w-[min(240px,55vw)] align-middle text-[var(--msg-user-text)]"
        />,
      );
      line = line.slice(slashMatch[0].length);
    }

    // Parse @mentions in the remaining line. MENTION_TOKEN_SPLIT also captures
    // the `@"path with spaces"` quoted form so含空格的文件名不再被空格截断。
    const parts = line.split(MENTION_TOKEN_SPLIT);
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      if (!part) continue;

      if (part.startsWith('@')) {
        const { ref } = parseMentionToken(part); // 去 @ 与外层引号、反转义

        // @ embedded mid-word (e.g. email `user@example.com`) → plain text.
        // A real mention is always preceded by whitespace or sits at line start.
        const prev = parts[pi - 1];
        if (prev && prev.length > 0 && !/\s$/.test(prev)) {
          nodes.push(
            ...renderTextWithLinks(
              part,
              `${li}-${pi}`,
              onImageClick,
              sessionId,
              sessionReferences,
              interactive,
            ),
          );
          continue;
        }

        // Only render as chip if it looks like a real path
        if (!looksLikePath(ref)) {
          // Not a path — render as plain text
          nodes.push(
            ...renderTextWithLinks(
              part,
              `${li}-${pi}`,
              onImageClick,
              sessionId,
              sessionReferences,
              interactive,
            ),
          );
          continue;
        }

        const key = `${li}-${pi}`;

        if (ref.startsWith('.claude/agents/')) {
          const name = ref.replace('.claude/agents/', '').replace(/\.md$/, '');
          nodes.push(
            <InlineReferenceChip
              key={key}
              label={name}
              icon={<Sparkles aria-hidden />}
              tooltip={name}
              className="relative top-[-1px] -my-[1px] max-w-[min(240px,55vw)] align-middle"
            />,
          );
        } else if (ref.endsWith('/')) {
          // 同时按 / 和 \ 拆分，否则 Windows 绝对路径（drop 文件夹时常见，
          // 如 `C:\Users\foo\bar\/`）会被当成单段，dirName 退化成完整路径，
          // chip 的 whitespace-nowrap 会把气泡撑变形。
          const dirName = ref.slice(0, -1).split(/[\\/]/).filter(Boolean).pop() || ref;
          nodes.push(
            <InlineReferenceChip
              key={key}
              label={`${dirName}/`}
              icon={<FolderIcon aria-hidden />}
              tooltip={ref}
              tooltipMono
              className="relative top-[-1px] -my-[1px] max-w-[min(240px,55vw)] align-middle"
            />,
          );
        } else {
          const fileName = ref.split(/[\\/]/).pop() || ref;
          // v7: 右键菜单(复制 / 复制文件路径 / 打开文件所在目录) 由 UserFileChip 提供。
          nodes.push(
            interactive && onFileChipClick ? (
              <UserFileChip
                key={key}
                refText={ref}
                fileName={fileName}
                workingDir={workingDir}
                onClick={async (e) => {
                  // Capture currentTarget before the await: `currentTarget` is only
                  // set while the DOM event is being dispatched, so it reads back as
                  // null once the IPC resolves. (Not React event pooling — that was
                  // removed in React 17; this is plain DOM Event semantics.) The
                  // element is needed later to restore focus when the lightbox closes.
                  const chip = e.currentTarget;
                  if (remoteJoin) {
                    // remote:本机 BFS 无意义,join 出远端绝对路径,存在性由
                    // 点击后的远程取回链路兜底。
                    await onFileChipClick(resolveLocalPath(ref, workingDir), fileName, chip);
                    return;
                  }
                  // markdown-monorepo-resolve: smart resolve so a chip like
                  // `@src/App.tsx` resolves to the right sub-package even
                  // though session.workingDir points at the workspace root.
                  const result = await resolveLocalPathSmart(ref, workingDir);
                  if (result.status === 'multiple') {
                    toast.error(
                      t('chat.markdownRenderer.duplicateFiles', {
                        count: result.candidates.length,
                      }),
                    );
                    return;
                  }
                  const abs = result.status === 'unique' ? result.absPath : result.fallbackAbsPath;
                  await onFileChipClick(abs, fileName, chip);
                }}
              />
            ) : (
              <InlineReferenceChip
                key={key}
                label={fileName}
                icon={<FileIcon aria-hidden />}
                tooltip={ref}
                tooltipMono
                ariaLabel={fileName}
                className="relative top-[-1px] -my-[1px] max-w-[min(240px,55vw)] align-middle"
              />
            ),
          );
        }
      } else {
        nodes.push(
          ...renderTextWithLinks(
            part,
            `${li}-${pi}`,
            onImageClick,
            sessionId,
            sessionReferences,
            interactive,
          ),
        );
      }
    }
  }
  return nodes;
}

export type SentInlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'slash'; text: string }
  | { kind: 'pasted'; text: string; display: string }
  | { kind: 'agent-reference'; text: string; reference: AgentInputReference };

type SentInlineRange =
  | { tokenKind: 'pasted'; start: number; end: number; display: string }
  | { tokenKind: 'slash'; start: number; end: number }
  | {
      tokenKind: 'agent-reference';
      start: number;
      end: number;
      reference: AgentInputReference;
    };

/** Split exact persisted ranges without guessing from repeated text. */
export function buildSentInlineTokens(
  content: string,
  pastedTextRanges: readonly PastedTextRange[] = [],
  slashCommandRanges: readonly SlashCommandRange[] = [],
  agentReferences: readonly AgentInputReference[] = [],
): SentInlineToken[] {
  const ranges: SentInlineRange[] = [
    ...pastedTextRanges.map(({ start, end, display }): SentInlineRange => ({
      tokenKind: 'pasted',
      start,
      end,
      display,
    })),
    ...slashCommandRanges.map(({ start, end }): SentInlineRange => ({
      tokenKind: 'slash',
      start,
      end,
    })),
    ...agentReferences.map((reference): SentInlineRange => ({
      tokenKind: 'agent-reference',
      start: reference.start,
      end: reference.end,
      reference,
    })),
  ].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.tokenKind === 'agent-reference' && b.tokenKind !== 'agent-reference') return -1;
    if (b.tokenKind === 'agent-reference' && a.tokenKind !== 'agent-reference') return 1;
    return a.end - b.end;
  });
  const tokens: SentInlineToken[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (
      range.start < cursor ||
      range.start < 0 ||
      range.end > content.length ||
      range.end <= range.start
    ) {
      continue;
    }
    if (range.start > cursor)
      tokens.push({ kind: 'text', text: content.slice(cursor, range.start) });
    const text = content.slice(range.start, range.end);
    if (range.tokenKind === 'pasted') {
      tokens.push({ kind: 'pasted', text, display: range.display });
    } else if (range.tokenKind === 'slash') {
      tokens.push({ kind: 'slash', text });
    } else {
      tokens.push({ kind: 'agent-reference', text, reference: range.reference });
    }
    cursor = range.end;
  }
  if (cursor < content.length) tokens.push({ kind: 'text', text: content.slice(cursor) });
  return tokens;
}

/**
 * 收起判定与镜像测量共用的纯文本投影:粘贴段折叠成它自己的胶囊文案。
 *
 * 展开态里粘贴段是一个胶囊(点击看全文),收起态却按原文纯文本裁剪 —— 用户看到的
 * 是"收起还能看到日志前 10 行、展开只剩一个胶囊"的反向落差(issue #946)。测量
 * 使用同一份投影避免被折叠掉的几百行原文顶穿阈值；实际收起态则复用静态 chip
 * renderer，保证它与展开态的内容形状一致。
 *
 * 只在 range 偏移确定精确时调用(见 UserMessage 的 collapseMeasureBody):
 * buildSentInlineTokens 本身会丢弃越界 / 逆序的 range,偏移不准最坏退化成"不折叠",
 * 不会截断或错位正文。
 */
export function projectSentPastedPlainText(
  content: string,
  pastedTextRanges: readonly PastedTextRange[] = [],
): string {
  if (pastedTextRanges.length === 0) return content;
  return buildSentInlineTokens(content, pastedTextRanges)
    .map((token) => (token.kind === 'pasted' ? token.display : token.text))
    .join('');
}

/** Project rich inline ranges to the labels users see when a long message is collapsed. */
export function projectSentInlinePlainText(
  content: string,
  pastedTextRanges: readonly PastedTextRange[] = [],
  agentReferences: readonly AgentInputReference[] = [],
): string {
  if (pastedTextRanges.length === 0 && agentReferences.length === 0) return content;
  return buildSentInlineTokens(content, pastedTextRanges, [], agentReferences)
    .map((token) =>
      token.kind === 'pasted'
        ? token.display
        : token.kind === 'agent-reference'
          ? sentAgentReferenceDisplayLabel(token.reference)
          : token.text,
    )
    .join('');
}

/** Locate each parsed text island in the original quote wire text. */
export function locateChatQuoteTextSegmentStarts(
  content: string,
  segments: readonly ChatQuoteSegment[],
): Array<number | null> {
  let cursor = 0;
  return segments.map((segment) => {
    if (segment.kind === 'quote') {
      const encoded = formatQuoteForSend(segment.quote);
      const start = content.indexOf(encoded, cursor);
      if (start >= 0) cursor = start + encoded.length;
      return null;
    }
    const start = content.indexOf(segment.text, cursor);
    if (start < 0) return null;
    cursor = start + segment.text.length;
    return start;
  });
}

export function projectSentRanges<T extends { start: number; end: number }>(
  ranges: readonly T[],
  sourceStart: number | null,
  textLength: number,
): T[] {
  if (sourceStart === null) return [];
  const sourceEnd = sourceStart + textLength;
  return ranges
    .filter((range) => range.start >= sourceStart && range.end <= sourceEnd)
    .map((range) => ({
      ...range,
      start: range.start - sourceStart,
      end: range.end - sourceStart,
    }));
}

/** Replace persisted presentation ranges with read-only sent chips. */
export function renderContent(
  content: string,
  workingDir: string,
  onFileChipClick:
    ((abs: string, name: string, chip: HTMLElement) => void | Promise<void>) | undefined,
  onImageClick: ((xdtFileUrl: string) => void) | undefined,
  t: TFunction,
  sessionId?: string,
  remoteJoin = false,
  pastedTextRanges: readonly PastedTextRange[] = [],
  slashCommandRanges?: readonly SlashCommandRange[],
  sessionReferences?: readonly PersistedSessionReferenceMetadata[],
  /**
   * 粘贴段胶囊的点击入口(issue #946)。不传时胶囊退回不可交互,只剩 hover
   * tooltip —— 那正是"发出去就再也看不到全文"的旧行为,新调用点都应该传。
   */
  onPastedTextChipClick?: (text: string, chip: HTMLElement) => void,
  agentReferences: readonly AgentInputReference[] = [],
  interactive = true,
): React.ReactNode[] {
  const tokens = buildSentInlineTokens(
    content,
    pastedTextRanges,
    slashCommandRanges ?? [],
    agentReferences,
  );
  const useLegacySlashHeuristic = slashCommandRanges === undefined;
  return tokens.map((token, index) => {
    if (token.kind === 'slash') {
      return (
        <InlineReferenceChip
          key={`slash-chip-${index}`}
          label={token.text}
          tooltip={token.text}
          className="relative top-[-1px] -my-[1px] max-w-[min(240px,55vw)] align-middle text-[var(--msg-user-text)]"
        />
      );
    }
    if (token.kind === 'pasted') {
      return (
        <InlineReferenceChip
          key={`pasted-chip-${index}`}
          label={token.display}
          icon={<FileText aria-hidden />}
          tooltip={token.text}
          tooltipMono
          tooltipContentClassName="max-h-64 w-80 max-w-[70vw] overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]"
          ariaLabel={token.display}
          className="relative top-[-1px] -my-[1px] max-w-[min(240px,55vw)] align-middle"
          // 点击打开只读全文(与 composer 侧 pastedTextChip → ToolPayloadLightbox
          // 对齐)。hover tooltip 是 320×256 的小浮层,几百行日志在里面读不了,
          // 也无法选中复制,不能当作查看全文的唯一出口(issue #946)。
          {...(interactive && onPastedTextChipClick
            ? {
                onClick: (event) => onPastedTextChipClick(token.text, event.currentTarget),
              }
            : {})}
        />
      );
    }
    if (token.kind === 'agent-reference') {
      return (
        <SentAgentReferenceChip
          key={`agent-reference-chip-${index}`}
          interactive={interactive}
          reference={token.reference}
        />
      );
    }
    return (
      <span key={`text-${index}`}>
        {renderContentWithoutPastedText(
          token.text,
          workingDir,
          onFileChipClick,
          onImageClick,
          t,
          sessionId,
          remoteJoin,
          useLegacySlashHeuristic,
          sessionReferences,
          interactive,
        )}
      </span>
    );
  });
}

// 用户上传图统一走 ChatImageView('user-attached' variant),把样式规则、
// click→ImageLightbox、error→ImageMissingPlaceholder 都收敛到一处。
// 老 UserImageItemView 已迁出,见 ChatImageView.tsx。

export function UserMessage({
  workingDir,
  content,
  sessionReferences,
  quotesEncoded,
  agentReferences,
  pastedTextRanges,
  slashCommandRanges,
  images,
  files,
  createdAt,
  sessionId,
  agentKind,
  remoteHostId,
  messageClientId,
  sessionRunning,
  delivery,
  isFirstUserMessage,
  isLastUserMessage,
  automationOrigin,
  hookSource,
  goalBadge,
  blockedByGhost,
}: UserMessageProps) {
  const { t } = useTranslation();
  // Capability gate: 没传 agentKind (调用方未升级) → 默认两者都允许 (兼容旧路径)
  // 传了 agentKind → 按 capabilities.fork/rewind.supported 决定 icon 显示
  // renderer 'cc' ↔ maker 'claude-code' 别名映射 (DB / Session 用 'cc', maker IPC 用 'claude-code')
  const makerKind: MakerAgentKind =
    agentKind === 'codex' || agentKind === 'pi' ? agentKind : 'claude-code';
  // device-link 远程会话:fork/rewind 能力按被控端读(本机会话 deviceId undefined,行为不变)。
  // 媒体来源(device/ssh)用于把附件/文件预览 URL 改写到 cindy-remote-media://(入方向媒体)。
  // 取自 ChatSessionFileContext(MessageStream 顶层订阅式构造,deviceId 迟到注册时
  // context 更新会穿透 memo 触发重渲,替代旧的 render 期一次性读取)。
  const sessionFileCtx = useChatSessionFile();
  const remoteDeviceId = originDeviceId(sessionFileCtx.origin);
  const gitSafetyAutoSnapshotEnabled = useGitSafetyAutoSnapshotEnabledForDevice(remoteDeviceId);
  const remoteMediaOrigin = useMemo(
    () => toRemoteMediaOrigin(sessionFileCtx.origin, sessionFileCtx.workingDir),
    [sessionFileCtx],
  );
  const { capabilities } = useAgentCapabilities(makerKind, remoteDeviceId);
  // 远端 cc daemon 会话暂不支持 Fork/Rewind 依赖的 query rebuild (MVP),
  // remoteHostId 非空时直接关掉这两个能力, 避免点了落到后端错误。
  const isRemote = Boolean(remoteHostId);
  const codexRewindEntryAllowed = agentKind !== 'codex' || gitSafetyAutoSnapshotEnabled;
  const forkSupported = !isRemote && (!agentKind || (capabilities?.fork?.supported ?? true));
  const rewindSupported =
    codexRewindEntryAllowed &&
    !isRemote &&
    (!agentKind || (capabilities?.rewind?.supported ?? true));

  const hasImages = images && images.length > 0;
  const hasFiles = files && files.length > 0;
  // F5.7: Lightbox state for user message images (same pattern as MarkdownRenderer)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // text-lightbox F1: Chip-Row entry — clicking a file chip opens TextLightbox.
  const [textLightboxFile, setTextLightboxFile] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [orcaExpanded, setOrcaExpanded] = useState(false);
  const [longMessageExpanded, setLongMessageExpanded] = useState(false);
  // issue #946: 已发送消息里点粘贴段胶囊 → 只读全文 lightbox(无文件路径可给
  // TextLightbox,与 composer 侧一样走 ToolPayloadLightbox 的 text 模式)。
  const [pastedTextPreview, setPastedTextPreview] = useState<string | null>(null);
  // text-lightbox F6: ref to the chip currently driving the lightbox so
  // close can return focus to it (only one lightbox at a time per message).
  const activeFileChipRef = useRef<HTMLElement | null>(null);
  // 与 file chip 共用 activeFileChipRef 的"最近一次触发者胜出"语义:同一条消息
  // 同时只会开一个 lightbox,关闭后焦点回到真正点过的那个胶囊。
  const handlePastedTextChipClick = useCallback((text: string, chip: HTMLElement) => {
    activeFileChipRef.current = chip;
    setPastedTextPreview(text);
  }, []);

  // text-lightbox F1 replaces the old `@path` inline prepend. Files are now
  // rendered as a dedicated Chip-Row above the text bubble (per cc-agent-view
  // pen DLGJ9 / s2N4G). The text bubble itself only renders user-typed content.
  const orcaCommunication = parseOrcaCommunicationContent(content);
  // 显示文本推导(Orca JSON 解包 / hook 消息取 userText 或剥 <thread_context>)
  // 与提问导航条预览共用同一实现,规则见 userMessageDisplayText.ts;上面已
  // 解析过的 Orca 结果传入复用,渲染热路径不重复 JSON.parse(Copilot review)。
  const displayContent = resolveUserDisplayText({ content, hookSource }, orcaCommunication);
  const validAgentReferences = useMemo(
    () => readAgentInputReferences(agentReferences, content),
    [agentReferences, content],
  );
  // ghost-summon-card:意识指令/提示的机器追加段从气泡正文尾部剥离,交给
  // GhostSummonCard 渲染(splitGhostDirective 与 expandGhostCommand 同模板,
  // 对不上模板按普通文本原样显示)。copy / fork / rewind / 编辑预填全部用
  // 剥离后的正文——这些路径重发都走发送期再展开,带着旧指令会叠加双份。
  // orca / hook 消息不经意识展开,跳过解析。
  const ghostSplit =
    orcaCommunication || hookSource
      ? null
      : (splitGhostDirective(displayContent) ?? splitHostCapabilityDirective(displayContent));
  const ghostDirective = ghostSplit?.directive ?? null;
  const ghostBody = ghostSplit?.body ?? displayContent;
  // quotesEncoded 消息按正文顺序解析全部引用块,支持引用与回复交错。
  const quoteSegments = useMemo<ChatQuoteSegment[]>(
    () =>
      orcaCommunication || !quotesEncoded
        ? ghostBody
          ? [{ kind: 'text', text: ghostBody }]
          : []
        : parseChatQuoteSegments(ghostBody),
    [ghostBody, orcaCommunication, quotesEncoded],
  );
  const ghostBodySourceStart = useMemo(() => {
    const start = content.indexOf(ghostBody);
    return start >= 0 ? start : null;
  }, [content, ghostBody]);
  const quoteTextSegmentStarts = useMemo(
    () => locateChatQuoteTextSegmentStarts(ghostBody, quoteSegments),
    [ghostBody, quoteSegments],
  );
  // 意识指令等既有语义判断只看用户自己的正文,不把引用原文误识别成命令。
  const bubbleBody = useMemo(() => joinChatQuoteTextSegments(quoteSegments), [quoteSegments]);
  const inlineQuoteCount = quoteSegments.reduce(
    (count, segment) => count + (segment.kind === 'quote' ? 1 : 0),
    0,
  );
  const quoteDraftDocument = useMemo(
    () => (quotesEncoded ? quoteSegmentsToComposerDocument(quoteSegments) : undefined),
    [quoteSegments, quotesEncoded],
  );
  // $指令 开头且确认命中意识时,气泡正文渲剥掉指令 token 的余文($token 的
  // 语义由气泡内的召唤标注行承载,正文不重复报幕);普通消息里的 $word 不受
  // 影响。2026-07-29 起取消「卡片即消息」合并形态:正文永远回归文字气泡。
  const ghostCmdWord =
    ghostDirective?.kind === 'command' ? parseGhostCommandWord(bubbleBody) : null;
  // 触发符恒为 1 个字符($ 或全角变体),token = 触发符 + 指令词。
  const ghostCmdToken = ghostCmdWord ? bubbleBody.slice(0, 1 + ghostCmdWord.length) : null;
  const ghostPromptBody = ghostCmdToken ? bubbleBody.slice(ghostCmdToken.length).trim() : '';
  // 软提示兑现(语义调用):本条消息触发的那一轮 AI 真调了被提及的意识时,
  // 升级为与硬指令同形态的召唤标注行。判据来自 GhostFulfillmentContext
  // (MessageStream 从会话历史现算,重启幂等)。
  const ghostFulfillment = useContext(GhostFulfillmentContext);
  const ghostFulfilledIds = messageClientId ? ghostFulfillment.get(messageClientId) : undefined;
  const ghostMentionFulfilled =
    ghostDirective?.kind === 'mention' &&
    Boolean(
      ghostFulfilledIds && ghostDirective.ghosts.some((g) => ghostFulfilledIds.has(g.ghostId)),
    );
  // 语义自主召唤:消息一个触发词都没命中(无任何追加段),AI 本轮仍真调了
  // ghost_call → 合成 semantic 展示数据,渲染同一行召唤标注(与硬指令/兑现
  // 软提示渲染一致)。orca / hook 消息不参与(它们本就不经意识展开)。
  const ghostSemanticDisplay: GhostSummonDisplay | null =
    !ghostDirective &&
    !orcaCommunication &&
    !hookSource &&
    ghostFulfilledIds &&
    ghostFulfilledIds.size > 0
      ? { kind: 'semantic', ghostIds: [...ghostFulfilledIds] }
      : null;
  // 召唤展示数据(追加段解析优先;没有追加段才可能是 semantic),按形态分流:
  // - 标注行(chip):硬指令 / 软提示已兑现 / semantic → 嵌进气泡顶部;
  // - 胶囊(pill):软提示未兑现 → 保持原低调形态,留在气泡下方。
  const ghostCardDisplay: GhostSummonDisplay | null = ghostDirective ?? ghostSemanticDisplay;
  const ghostPillForm = ghostDirective?.kind === 'mention' && !ghostMentionFulfilled;
  const ghostChipDisplay = ghostPillForm ? null : ghostCardDisplay;
  const ghostPillDisplay = ghostPillForm ? ghostDirective : null;
  // 气泡实际显示的正文与其在原始 content 中的起点(粘贴块/斜杠命令高亮的
  // 偏移投影用):硬指令剥 $token,其余原样。
  const displayBubbleBody = ghostCmdToken ? ghostPromptBody : bubbleBody;
  const displayBubbleSourceStart = useMemo(() => {
    if (!ghostCmdToken) return ghostBodySourceStart;
    if (!ghostPromptBody || ghostBodySourceStart === null) return null;
    const localStart = ghostBody.indexOf(ghostPromptBody);
    return localStart >= 0 ? ghostBodySourceStart + localStart : null;
  }, [ghostCmdToken, ghostPromptBody, ghostBody, ghostBodySourceStart]);
  // 长消息收起以真实排版为准:粗筛命中的消息在气泡里挂隐藏镜像节点实测
  // 视觉行数,窗口缩放 / 侧栏开合导致气泡宽度变化时由 ResizeObserver 重算。
  // 自动化任务注入的消息(模板化调度 prompt,每轮重复出现)用更低的收起
  // 阈值,收起后也只留 3 行(手打消息 14 行阈值 / 收起留 10 行不变)。
  const collapseThreshold = automationOrigin
    ? AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD
    : LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD;
  // 粘贴段在气泡展示正文(displayBubbleBody)局部坐标下的 range(与下方
  // 富渲染同一份投影;硬指令剥 $token 后起点用 displayBubbleSourceStart)。
  const bubblePastedRanges = useMemo(
    () =>
      projectSentRanges(pastedTextRanges ?? [], displayBubbleSourceStart, displayBubbleBody.length),
    [displayBubbleBody.length, displayBubbleSourceStart, pastedTextRanges],
  );
  const bubbleAgentReferences = useMemo(
    () =>
      projectSentRanges(validAgentReferences, displayBubbleSourceStart, displayBubbleBody.length),
    [displayBubbleBody.length, displayBubbleSourceStart, validAgentReferences],
  );
  // 收起判定与测量镜像共用的投影正文:粘贴段按胶囊文案计量,不再拿被折叠掉的
  // 几百行原文去撞收起阈值(issue #946)。实际正文由同一套结构化 renderer 渲染,
  // 偏移只在 bubbleBody 与 ghostBody 同源
  // (无引用交错)时精确 —— quote 块被 join 掉的消息偏移会整体前移,保持原文
  // 测量;硬指令剥 $token 不影响精确性(displayBubbleSourceStart 已重定位)。
  const collapseMeasureBody = useMemo(
    () =>
      bubbleBody === ghostBody
        ? projectSentInlinePlainText(displayBubbleBody, bubblePastedRanges, bubbleAgentReferences)
        : displayBubbleBody,
    [bubbleAgentReferences, bubbleBody, bubblePastedRanges, displayBubbleBody, ghostBody],
  );
  const collapseMeasureEnabled =
    !orcaCommunication &&
    !hookSource &&
    mayExceedVisualLineThreshold(collapseMeasureBody, collapseThreshold);
  const { mirrorRef: collapseMirrorRef, shouldCollapse: shouldCollapseLongMessage } =
    useUserMessageAutoCollapse(collapseMeasureBody, collapseMeasureEnabled, collapseThreshold);
  const longMessageCollapsed = shouldCollapseLongMessage && !longMessageExpanded;

  // message-actions hover state — raw hover boolean, no debounce here.
  // The bar component owns its own fade lifecycle (250ms trailing debounce
  // + CSS opacity transition) so quick re-enters interpolate smoothly.
  const [hovered, setHovered] = useState(false);

  // copy text per V1.2: original text + (if files) "\n\n附件：a.md, b.md"
  // ghost-summon-card:copy 给用户的是"他自己的话"(剥离机器追加段);
  // 追加段原文在卡片展开区可查可选中。
  const copyBody = quotesEncoded ? stripChatQuoteMarkerLines(ghostBody) : ghostBody;
  const copyText = hasFiles
    ? `${copyBody}\n\n${t('chat.userMessage.attachmentPrefix')}${files!.map((f) => f.name).join(', ')}`
    : copyBody;
  // 远程会话的消息深链把归属设备冻进 `?device=`(粘滞解析,relay 重连窗口不丢),
  // 复制/「加入对话」产出的链接在任何时刻发送都能路由回来源设备。
  const messageDeepLink =
    sessionId && messageClientId
      ? buildSessionMessageDeepLink(sessionId, messageClientId, {
          deviceId: getStickySessionDeviceId(sessionId),
        })
      : undefined;
  const handleAddToChat = useCallback(() => {
    if (!sessionId || !messageDeepLink) return;
    insertSessionLinkIntoComposer({ targetSessionId: sessionId, href: messageDeepLink });
  }, [messageDeepLink, sessionId]);

  // 分享为图片:进入选择模式并预选本条(入口那条天然该已勾选,省一次点击)。
  const handleShareAsImage = useMemo(
    () =>
      sessionId && messageClientId
        ? () => shareSelectionStore.enter(sessionId, messageClientId)
        : undefined,
    [messageClientId, sessionId],
  );

  // fork-from-here: only wire when both sessionId + messageClientId are
  // present (older code paths that render UserMessage without these props
  // simply won't show the Fork button). 流程收敛在 useForkAtMessage —
  // user 消息分叉把提问文本预填进新会话 composer。
  // inline quote 消息用完整文档保留正文 / 引用的交错顺序。
  const handleFork = useForkAtMessage({
    sessionId,
    messageClientId,
    forkBlocked: shouldBlockUserFork(sessionRunning, delivery),
    draftText: quotesEncoded ? undefined : bubbleBody,
    draftDocument: quoteDraftDocument,
  });
  const handleDelete = useDeleteMessage({
    sessionId,
    messageClientId,
    blocked: sessionRunning || Boolean(blockedByGhost),
  });

  // 第一条 user 消息：fork 出来等价于复制整条 session（fork 点之前没东西），藏掉。
  // 同时按 capabilities.fork.supported gate (Codex 现支持; 未来若 agent 不支持自动隐藏)。
  const navigationMode = useSessionNavigationMode();
  const canFork =
    isInteractiveSessionNavigationMode(navigationMode) &&
    Boolean(sessionId && messageClientId) &&
    !isFirstUserMessage &&
    forkSupported &&
    !orcaCommunication &&
    !hookSource;

  // ── rewind ──────────────────────────────────────────────────────────────
  // Dialog open state lives here (UserMessage owns the in-flight period —
  // dialog opens → preview dryRun → user confirm → commit → close, the whole
  // span counts as "rewinding" for the action-bar Loader2). Reset on close.
  const [rewindOpen, setRewindOpen] = useState(false);

  const handleRewind = useCallback(() => {
    if (!sessionId || !messageClientId) return;
    setRewindOpen(true);
  }, [sessionId, messageClientId]);

  const handleRewindCommitted = useCallback(
    (session: Session) => {
      if (!sessionId) return;
      // Pre-fill composer with the rewound user message text — same UX as fork.
      // Rewind soft-deletes this row server-side (rewind_at set), so on next
      // reload it disappears from the list; the composer keeps the draft so
      // the user can edit and re-send.
      const draftText = quoteDraftDocument ?? textToTiptapDoc(bubbleBody);
      const draftAttachments = buildRewindDraftAttachments({ images, files });
      if (draftText || draftAttachments.length > 0) {
        saveComposerDraft(sessionId, {
          text: draftText,
          attachments: draftAttachments,
        });
      }
      // Patch sidebar: tokens reset, sdkSessionId may have changed, bump
      // updatedAt so this session sorts back to top.
      emitSessionPatch(sessionId, {
        sdkSessionId: session.sdkSessionId,
        contextTokens: 0,
        contextWindow: 0,
        updatedAt: session.updatedAt,
        userSendAt: session.userSendAt,
      });
      // Force chat store to re-fetch messages (server filters rewind_at).
      makerChatStore.reloadMessages(sessionId);
    },
    [sessionId, bubbleBody, quoteDraftDocument, images, files],
  );

  // 第一条 user 消息没有可作为锚点的 prior assistant uuid → 后端必抛
  // NO_PRIOR_ASSISTANT。直接藏掉按钮，避免无效点击。
  // 同时按 capabilities.rewind.supported gate；Codex 入口还要用户显式开启 Git safety。
  const canRewind =
    Boolean(sessionId && messageClientId) &&
    !isFirstUserMessage &&
    rewindSupported &&
    !orcaCommunication &&
    !hookSource;

  // ── edit-last-message ──────────────────────────────────────────────────
  // 编辑 = rewind 到本条 + 用编辑后的文本立即重发(见 UserMessageEditBox)。
  // 只在最后一条 user 消息开放;能力门控与 Rewind 完全一致(编辑走同一条
  // commit 链路,rewind 不可用则编辑必然也不可用),首条消息同样因缺
  // prior assistant 锚点而隐藏。进入编辑态零副作用,取消原样恢复。
  const [editing, setEditing] = useState(false);
  // 被意识钩子拦下的消息(订阅槽①):从未落库、无 turn 可 rewind,编辑走
  // 普通重发(onCommitOverride),故可编辑条件与 rewind 无关——只要有
  // session/clientId 就能改了重发。
  const isBlocked = Boolean(blockedByGhost);
  const canEdit = isBlocked
    ? Boolean(sessionId && messageClientId)
    : canRewind && Boolean(isLastUserMessage);

  // 中断运行中的 turn——Stop 语义与输入框的 Stop 按钮完全一致
  // (useCCAgentChat.stopSession):有排队消息时 keepQueue+pauseQueue(停当前 +
  // 暂停整个队列,防止 stop 落地后队列头在 rewind 之前抢跑新 turn),否则普通 stop。
  const stopForEdit = useCallback(() => {
    if (!sessionId) return;
    const snap = makerChatStore.getSnapshot(sessionId);
    if (snap.pendingQueue.length > 0) {
      makerChatStore.stopSession(sessionId, { keepQueue: true, pauseQueue: true });
    } else {
      makerChatStore.stopSession(sessionId);
    }
  }, [sessionId]);

  // 点编辑 = 立即中断运行中的 turn(产品决策,对齐 2026-07 的 Codex 调研:
  // 用户点编辑的意图就是"停下来我要改",且 interrupt 终止性、无恢复原语,
  // 取消编辑后 AI **不会**继续工作——Codex 同语义,用户已知悉接受)。
  // 发送侧不依赖这里的 stop 已完成:EditBox 会等 sessionRunning 翻 false 再
  // 提交(含超时兜底 + 发送时再补一次 stop 的保险),两端解耦。
  //
  // 队列门槛:有排队中的消息时拒绝进入编辑(toast 说明)。排队消息是针对
  // rewind 前的旧上下文写的,而编辑重发只会追加到 paused 队列尾部——Continue
  // 后陈旧消息会先于编辑内容重放进已被裁剪的对话(顺序反转)。与其静默产生
  // 错乱时间线,不如让用户先发送/清空队列再编辑。点击时读快照即可(非响应式):
  // mid-edit 队列突增的竞态由 commitEditAndResend 的同名硬守卫兜底。
  const handleEdit = useCallback(() => {
    if (sessionId && makerChatStore.getSnapshot(sessionId).pendingQueue.length > 0) {
      toast.error(t('chat.userMessage.editQueueNotEmpty'));
      return;
    }
    if (sessionRunning) stopForEdit();
    setEditing(true);
  }, [sessionId, sessionRunning, stopForEdit, t]);

  // 稳定引用:内联箭头会让 EditBox 的 doCommit(依赖 onSent)每次父组件
  // 重渲都重建,连带"等待停止接力" effect 无谓重跑(bot review 指出)。
  const exitEditing = useCallback(() => setEditing(false), []);

  // 分享选择模式只克隆已发送消息的只读 DOM。仅在本条实际处于编辑态时订阅
  // share store,避免让所有 user 消息都因选择模式切换而重渲染。
  useEffect(() => {
    if (!editing || !sessionId) return;
    const exitWhenSharing = () => {
      if (shareSelectionStore.isActive(sessionId)) exitEditing();
    };
    exitWhenSharing();
    return shareSelectionStore.subscribe(exitWhenSharing);
  }, [editing, exitEditing, sessionId]);

  // 编辑期间会话来了新消息(自动化任务注入等) → 本条不再是最后一条,继续
  // 发送会把那条新消息一起回退掉。直接退出编辑态(文本是从原消息预填的,
  // 退出无内容损失风险 —— 用户改到一半的文本被放弃,但这是极罕见路径,
  // 保数据正确性优先)。
  useEffect(() => {
    if (editing && !isLastUserMessage) setEditing(false);
  }, [editing, isLastUserMessage]);

  const orcaCardTitle =
    orcaCommunication?.orcaSource === 'lead'
      ? t('chat.userMessage.orcaFromLead')
      : t('chat.userMessage.orcaFromWorker');

  // Attachments belong to the user message independently of its visual shell.
  // Define each renderer once, then place it inside the hook / ordinary branch
  // so the ordinary message keeps its established badge-before-attachment order.
  const imageAttachmentNodes =
    !orcaCommunication && hasImages
      ? images.map((img, idx) => {
          const isUrlMode = 'url' in img;
          const src = isUrlMode ? img.url : `data:${img.mimeType};base64,${img.base64}`;
          const filename = isUrlMode ? img.originalName : (img.originalName ?? `image-${idx + 1}`);
          return (
            <ChatImageView
              key={`img-${idx}`}
              src={src}
              filename={filename ?? `image-${idx + 1}`}
              variant="user-attached"
              sessionId={sessionId}
              annotationSourceUrl={isUrlMode ? img.annotationSourceUrl : undefined}
              annotationStrokes={isUrlMode ? img.annotationStrokes : undefined}
            />
          );
        })
      : null;

  const fileAttachmentNodes =
    !orcaCommunication && hasFiles ? (
      <div
        className={cn(
          'flex flex-wrap items-end gap-1.5',
          hookSource ? 'justify-start' : 'justify-end',
        )}
      >
        {files.map((f, idx) => (
          <UserAttachmentChip
            key={`file-${idx}-${f.path}`}
            file={f}
            onOpenTextPreview={(chip) => {
              activeFileChipRef.current = chip;
              setTextLightboxFile({ path: f.path, name: f.name });
            }}
          />
        ))}
      </div>
    ) : null;

  // If there are images, use vertical layout: images on top, text bubble below, right-aligned
  // If no images, render the text bubble alone, right-aligned (existing behavior)
  return (
    <div
      // data-user-msg-id: PrevMessageJumpChip 的滚动锚点(usePrevUserMessageInView
      // 通过 querySelector 找当前在 viewport 之上的 user 消息,Chip 点击后
      // scrollIntoView 也以此为目标)。messageClientId 缺失时不挂属性,以免
      // querySelector 命中"data-user-msg-id" 空字符串。
      {...(messageClientId ? { 'data-user-msg-id': messageClientId } : {})}
      // 自己发送的消息不显示主动浮出的“添加到对话”；右键菜单仍可添加。
      data-selection-floating-quote-disabled=""
      className={cn(
        'flex w-full',
        orcaCommunication || hookSource ? 'justify-start' : 'justify-end',
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={cn(
          'flex flex-col gap-2',
          orcaCommunication || hookSource
            ? 'w-full max-w-[560px] items-start'
            : // 编辑态铺满可用宽度(上限 720px,Codex 同款"气泡展开成编辑器"观感);
              // 附件 chips 行保持右对齐不动。
              editing
              ? 'w-full max-w-[720px] items-end'
              : 'max-w-[488px] items-end',
        )}
      >
        {orcaCommunication ? (
          <div
            className={cn(
              'w-full rounded-[8px] border border-[var(--msg-tool-card-border)]',
              'bg-[var(--msg-tool-card-bg)] text-[var(--msg-tool-card-text)]',
              'overflow-hidden',
            )}
          >
            <button
              type="button"
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left',
                'text-13 font-medium leading-none',
                'hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
              )}
              aria-expanded={orcaExpanded}
              onClick={() => setOrcaExpanded((value) => !value)}
            >
              <Bot size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
              <span className="min-w-0 flex-1 truncate">{orcaCardTitle}</span>
              {orcaExpanded ? (
                <ChevronDown size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
              ) : (
                <ChevronRight size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
              )}
            </button>
            {orcaExpanded && (
              <div className="border-t border-[var(--msg-tool-card-border)] px-3 py-2">
                <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[length:calc(var(--app-code-font-size)_-_2px)] leading-[calc(var(--app-code-font-size)_+_4px)] text-[var(--foreground)]">
                  {displayContent}
                </pre>
              </div>
            )}
          </div>
        ) : hookSource ? (
          <>
            {/* hook 消息: Cindy 署名任务卡片(左对齐), 替代右对齐用户气泡 +
                automation 标签。图片 / 文件附件仍属于同一条入站消息。 */}
            {imageAttachmentNodes}
            {fileAttachmentNodes}
            <HookTaskCard
              im={hookSource.im}
              userText={displayContent}
              threadContext={hookSource.threadContext}
            />
          </>
        ) : (
          <>
            {/* 自动化任务注入的消息:气泡上方右对齐渲染来源标签(不进气泡、不入 copyText)。
            点击跳转自动化页并 focus 对应条目(与侧边栏自动化分组"编辑"同款 query
            机制);任务已删除时 SchedulerPage 的 focus 兜底会自动回退到列表首条。 */}
            {automationOrigin && <AutomationOriginBadge automationOrigin={automationOrigin} />}
            {/* /goal 目标设定/更新:气泡上方右对齐渲一个徽标(不进气泡、不入 copyText)。 */}
            {goalBadge && (
              <span
                className="inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium"
                style={{ backgroundColor: 'var(--surface-chip)', color: 'var(--text-secondary)' }}
              >
                <Target size={11} strokeWidth={2} aria-hidden className="shrink-0" />
                <span className="min-w-0 truncate">
                  {goalBadge.updated ? t('goal.objectiveBadgeUpdated') : t('goal.objectiveBadge')}
                </span>
              </span>
            )}
            {imageAttachmentNodes}
            {fileAttachmentNodes}
            {/* edit-last-message: 编辑态原地替换文本气泡 + 操作条(附件 chips 保持
            只读展示在上方);非编辑态走原有渲染。 */}
            {editing && sessionId && messageClientId ? (
              <UserMessageEditBox
                sessionId={sessionId}
                messageClientId={messageClientId}
                initialText={copyBody}
                initialSubmitText={quotesEncoded ? ghostBody : undefined}
                images={images}
                files={files}
                workingDir={workingDir}
                quotesEncoded={quotesEncoded}
                agentReferences={agentReferences}
                pastedTextRanges={pastedTextRanges}
                slashCommandRanges={slashCommandRanges}
                sessionRunning={sessionRunning}
                onRequestStop={stopForEdit}
                onCancel={exitEditing}
                onSent={exitEditing}
                {...(isBlocked
                  ? {
                      onCommitOverride: (submission) =>
                        makerChatStore.resendBlockedMessage(
                          sessionId,
                          messageClientId,
                          submission.text,
                          {
                            ...(submission.quotesEncoded ? { quotesEncoded: true } : {}),
                            ...(submission.agentReferences?.length
                              ? { agentReferences: submission.agentReferences }
                              : {}),
                            ...(submission.pastedTextRanges?.length
                              ? { pastedTextRanges: submission.pastedTextRanges }
                              : {}),
                            ...(submission.slashCommandRanges !== undefined
                              ? { slashCommandRanges: submission.slashCommandRanges }
                              : {}),
                          },
                        ),
                    }
                  : {})}
              />
            ) : (
              <>
                {/* 召唤标注行(chip)嵌进气泡顶部;正文永远回归文字气泡(2026-07-29
            取消合并形态)。气泡在有标注、有引用或有正文任一时渲染——$指令
            无余文时气泡只剩标注行。 */}
                {(inlineQuoteCount > 0 || displayBubbleBody.trim() || ghostChipDisplay) && (
                  <div
                    className={cn(
                      // overflow-wrap:anywhere（不是 break-words）才能让超长无空格序列
                      // 在任意字符处断行，并把内容的 min-content 缩小到一个字符宽。
                      // min-w-0 解除 flex item 默认的 min-width:auto，否则父容器的
                      // max-w-[488px] 会被超长 token 顶穿。两者缺一不可。
                      'relative min-w-0 max-w-full rounded-[12px]',
                      'border border-[var(--msg-user-border)]',
                      'bg-[var(--msg-user-bg)]',
                      'px-4 py-3',
                      'text-15 font-normal leading-[1.6]',
                      'text-[var(--msg-user-text)]',
                      'select-text',
                    )}
                  >
                    {ghostChipDisplay && (
                      /* ghost-summon-chip:标注行(法阵 + 意识名 + 状态 + 展开
                 caret)。running = 本条消息触发的 turn 仍在执行(最后一条
                 user 消息 + 会话流式中),期间法阵旋转,turn 结束播终态编舞。
                 下方有正文/引用时加分隔线,单独成泡时不加。 */
                      <GhostSummonCard
                        directive={ghostChipDisplay}
                        running={Boolean(sessionRunning) && Boolean(isLastUserMessage)}
                        {...(messageClientId ? { messageClientId } : {})}
                        className={
                          inlineQuoteCount > 0 || displayBubbleBody.trim()
                            ? 'mb-2.5 border-b border-[var(--msg-user-border)] pb-2.5'
                            : undefined
                        }
                      />
                    )}
                    {collapseMeasureEnabled && (
                      /* 收起判定的测量镜像:与正文同宽(inset-x-4 对应 px-4)、同字号
                 同换行规则的纯文本。max-h-0 + overflow-hidden 让它不占布局、
                 不产生幽灵滚动区,但 scrollHeight 仍是完整排版高度。 */
                      <div
                        ref={collapseMirrorRef}
                        aria-hidden="true"
                        className={cn(
                          'invisible absolute inset-x-4 top-0 max-h-0 overflow-hidden',
                          'whitespace-pre-wrap [overflow-wrap:anywhere]',
                        )}
                      >
                        {collapseMeasureBody}
                      </div>
                    )}
                    {inlineQuoteCount > 0 ? (
                      <div
                        className={cn(
                          'min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]',
                          longMessageCollapsed &&
                            (automationOrigin ? 'line-clamp-3' : 'line-clamp-10'),
                        )}
                      >
                        {quoteSegments.map((segment, index) =>
                          segment.kind === 'quote' ? (
                            <span
                              // biome-ignore lint/suspicious/noArrayIndexKey: 已发送消息内容不可变,顺序稳定。
                              key={index}
                              className="mx-1 inline-flex max-w-[min(240px,55vw)] select-none align-middle"
                            >
                              <QuoteChip quote={segment.quote} />
                            </span>
                          ) : (
                            <span
                              // biome-ignore lint/suspicious/noArrayIndexKey: 已发送消息内容不可变,顺序稳定。
                              key={index}
                            >
                              {renderContent(
                                segment.text,
                                workingDir,
                                longMessageCollapsed
                                  ? undefined
                                  : async (abs, name, chip) => {
                                      if (
                                        !(await shouldOpenTextLightboxForOrigin(
                                          sessionFileCtx,
                                          abs,
                                        ))
                                      )
                                        return;
                                      activeFileChipRef.current = chip;
                                      setTextLightboxFile({ path: abs, name });
                                    },
                                longMessageCollapsed
                                  ? undefined
                                  : (xdtFileUrl) => setLightboxSrc(xdtFileUrl),
                                t,
                                sessionId,
                                isRemoteFileOrigin(sessionFileCtx.origin),
                                projectSentRanges(
                                  pastedTextRanges ?? [],
                                  quoteTextSegmentStarts[index] === null ||
                                    ghostBodySourceStart === null
                                    ? null
                                    : ghostBodySourceStart + quoteTextSegmentStarts[index]!,
                                  segment.text.length,
                                ),
                                slashCommandRanges === undefined
                                  ? undefined
                                  : projectSentRanges(
                                      slashCommandRanges,
                                      quoteTextSegmentStarts[index] === null ||
                                        ghostBodySourceStart === null
                                        ? null
                                        : ghostBodySourceStart + quoteTextSegmentStarts[index]!,
                                      segment.text.length,
                                    ),
                                sessionReferences,
                                longMessageCollapsed ? undefined : handlePastedTextChipClick,
                                projectSentRanges(
                                  validAgentReferences,
                                  quoteTextSegmentStarts[index] === null ||
                                    ghostBodySourceStart === null
                                    ? null
                                    : ghostBodySourceStart + quoteTextSegmentStarts[index]!,
                                  segment.text.length,
                                ),
                                !longMessageCollapsed,
                              )}
                            </span>
                          ),
                        )}
                      </div>
                    ) : displayBubbleBody.trim() ? (
                      <div
                        className={cn(
                          'whitespace-pre-wrap [overflow-wrap:anywhere]',
                          longMessageCollapsed &&
                            (automationOrigin ? 'line-clamp-3' : 'line-clamp-10'),
                        )}
                      >
                        {longMessageCollapsed
                          ? renderContent(
                              displayBubbleBody,
                              workingDir,
                              undefined,
                              undefined,
                              t,
                              sessionId,
                              isRemoteFileOrigin(sessionFileCtx.origin),
                              bubblePastedRanges,
                              slashCommandRanges === undefined
                                ? undefined
                                : projectSentRanges(
                                    slashCommandRanges,
                                    displayBubbleSourceStart,
                                    displayBubbleBody.length,
                                  ),
                              sessionReferences,
                              undefined,
                              bubbleAgentReferences,
                              false,
                            )
                          : renderContent(
                              displayBubbleBody,
                              workingDir,
                              async (abs, name, chip) => {
                                if (!(await shouldOpenTextLightboxForOrigin(sessionFileCtx, abs)))
                                  return;
                                // F2 / F6: stash the clicked chip so the lightbox can
                                // return focus on close. State + ref are shared with the
                                // Chip-Row above ("most recent trigger wins" semantics).
                                activeFileChipRef.current = chip;
                                setTextLightboxFile({ path: abs, name });
                              },
                              (xdtFileUrl) => setLightboxSrc(xdtFileUrl),
                              t,
                              sessionId,
                              isRemoteFileOrigin(sessionFileCtx.origin),
                              bubblePastedRanges,
                              slashCommandRanges === undefined
                                ? undefined
                                : projectSentRanges(
                                    slashCommandRanges,
                                    displayBubbleSourceStart,
                                    displayBubbleBody.length,
                                  ),
                              sessionReferences,
                              handlePastedTextChipClick,
                              bubbleAgentReferences,
                            )}
                      </div>
                    ) : null}
                    {shouldCollapseLongMessage && (
                      <button
                        type="button"
                        aria-expanded={longMessageExpanded}
                        onClick={() => setLongMessageExpanded((expanded) => !expanded)}
                        className={cn(
                          'mt-2 inline-flex items-center gap-1 rounded-full px-1 py-0.5',
                          'text-12 font-medium leading-5',
                          'text-[var(--msg-user-text)] opacity-65 transition-opacity',
                          'hover:opacity-100',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                        )}
                      >
                        {longMessageExpanded
                          ? t('chat.userMessage.collapseLongMessage')
                          : t('chat.userMessage.expandLongMessage')}
                        {longMessageExpanded ? (
                          <ChevronUp size={13} className="shrink-0" />
                        ) : (
                          <ChevronDown size={13} className="shrink-0" />
                        )}
                      </button>
                    )}
                  </div>
                )}
                {/* ghost-summon-pill:未兑现的软提示保持低调胶囊,留在气泡下方
            (chip 标注行形态见气泡内部;提示原文仍可点开查看)。 */}
                {ghostPillDisplay && (
                  <GhostSummonCard
                    directive={ghostPillDisplay}
                    {...(messageClientId ? { messageClientId } : {})}
                  />
                )}
                {/* 订阅槽①:被意识钩子拦下 —— 气泡照常显示(未发出),下方渲一条
            error 红条,内容 = 意识返回的文本(直接显示,主机不加框不署名);
            用户用下方的编辑铅笔改了重发(普通重发,不 rewind)。 */}
                {blockedByGhost && (
                  <div className="mt-1.5">
                    <ErrorMessageCard
                      message={blockedByGhost.reason || t('chat.ghostHook.blockedFallback')}
                    />
                  </div>
                )}
                {/* message-actions V1.2: hover-revealed bar below the bubble,
                right-aligned, order [time][copy][fork][edit][undo][more]。被拦消息只保留
            编辑和链接复制,fork/rewind/delete 对未发消息无意义。 */}
                <MessageActionBar
                  createdAt={createdAt}
                  copyText={copyText}
                  copyLinkText={messageDeepLink}
                  align="right"
                  hovered={hovered}
                  onFork={!isBlocked && canFork ? handleFork : undefined}
                  onAddToChat={!isBlocked && messageDeepLink ? handleAddToChat : undefined}
                  onShareAsImage={handleShareAsImage}
                  onDelete={!isBlocked && sessionId && messageClientId ? handleDelete : undefined}
                  onEdit={canEdit ? handleEdit : undefined}
                  onRewind={!isBlocked && canRewind ? handleRewind : undefined}
                  rewindInFlight={rewindOpen}
                />
              </>
            )}
          </>
        )}
      </div>
      {/* F5.7: Image Lightbox for user message images */}
      {lightboxSrc && (
        <ImageLightbox
          src={rewriteToRemoteMediaOrigin(lightboxSrc, remoteMediaOrigin)}
          onClose={() => setLightboxSrc(null)}
        />
      )}
      {/* text-lightbox F1: Text Lightbox for file chip click */}
      {textLightboxFile && (
        <TextLightbox
          filePath={textLightboxFile.path}
          fileName={textLightboxFile.name}
          triggerRef={activeFileChipRef}
          onClose={() => setTextLightboxFile(null)}
        />
      )}
      {/* issue #946: 粘贴段全文(只读)。不传 textEdit —— 已发送的消息不可改。
          标题用当前语言的 previewTitle,不复用随消息落库的 display(那是发送时刻
          的语言,切换界面语言后会变成旧语种);行数仍在胶囊标签上可见。 */}
      {pastedTextPreview !== null && (
        <ToolPayloadLightbox
          payload={{
            kind: 'text',
            title: t('newChat.pastedText.previewTitle'),
            text: pastedTextPreview,
          }}
          triggerRef={activeFileChipRef}
          onClose={() => setPastedTextPreview(null)}
        />
      )}
      {/* rewind-session: Preview Dialog. Only mounted while open so dryRun
          re-runs cleanly each time (key on clientId for safety). */}
      {rewindOpen && sessionId && messageClientId && (
        <RewindPreviewDialog
          key={messageClientId}
          open={rewindOpen}
          onOpenChange={setRewindOpen}
          sessionId={sessionId}
          clientId={messageClientId}
          sessionRunning={sessionRunning === true}
          onCommitted={handleRewindCommitted}
        />
      )}
    </div>
  );
}
