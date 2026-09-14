import { piEditReplacements } from './toolUseDescriptor.js';
import { presentationText, type PresentationLocalizer } from './presentationLocalization.js';

export type PayloadKind = 'text' | 'diff' | 'media' | 'mermaid' | 'file';

export interface PayloadToolDiffLike {
  filePath: string;
  segments: Array<{ key: string; oldString: string; newString: string; label?: string }>;
  insertions: number;
  deletions: number;
}

export interface PayloadMediaActionButtonLike {
  customId: string;
  label?: string;
  emoji?: string;
}

export interface PayloadMediaActionsLike {
  provider: string;
  jobId: string;
  buttons: PayloadMediaActionButtonLike[];
}

export interface ExtractedPayloadToolMediaActionsLike {
  provider: 'mivo';
  jobId: string;
  buttons: PayloadMediaActionButtonLike[];
}

export interface PayloadMediaLike {
  kind: 'image' | 'video' | 'audio';
  url: string;
  title?: string;
  previewable: boolean;
  actions?: PayloadMediaActionsLike;
}

export interface ExtractedPayloadToolMediaLike {
  kind: 'image' | 'video' | 'audio';
  url: string;
  title?: string;
  previewable: boolean;
  actions?: ExtractedPayloadToolMediaActionsLike;
}

export interface PayloadAttachmentLike {
  kind: 'image' | 'file';
  name: string;
  uri?: string;
  path?: string;
  mimeType?: string;
  previewable: boolean;
}

export interface PayloadAttachmentMediaLike {
  kind: 'image' | 'video' | 'audio';
  url: string;
  title: string;
  previewable: boolean;
}

export type SharedMessagePayload<
  Diff extends PayloadToolDiffLike = PayloadToolDiffLike,
  Media extends PayloadMediaLike = PayloadMediaLike,
> =
  | {
      kind: 'text';
      title: string;
      body: string;
    }
  | {
      kind: 'diff';
      title: string;
      diff: Diff;
      body: string;
    }
  | {
      kind: 'media';
      title: string;
      media: Media;
      body: string;
    }
  | {
      kind: 'mermaid';
      title: string;
      body: string;
    }
  | {
      kind: 'file';
      title: string;
      body: string;
      sourcePath?: string;
    };

export type AttachmentMessagePayload =
  | Extract<SharedMessagePayload<PayloadToolDiffLike, PayloadAttachmentMediaLike>, { kind: 'media' }>
  | Extract<SharedMessagePayload, { kind: 'file' }>;

export interface MessagePayloadSummary {
  kind: PayloadKind;
  kindLabel: string;
  title: string;
  subtitle?: string;
  copyableText?: string;
  sourcePath?: string;
  openTarget?: {
    kind: 'url' | 'file';
    value: string;
  };
}

export interface MessagePayloadBodyPresentation {
  bodyText: string;
  emptyText: string;
  kind: PayloadKind;
  textMonospace: boolean;
  diff?: {
    filePath: string;
    sectionCount: number;
    stats: string;
  };
  file?: {
    displayPath: string;
    sourcePath: string;
  };
  media?: {
    canDirectOpen: boolean;
    canInlineDirectImage: boolean;
    canInlineDirectPlayer: boolean;
    directPreviewable: boolean;
    kindLabel: string;
    needsRemoteFetch: boolean;
    placeholderText: string;
    remoteIdleText: string;
    unsupportedText: string;
  };
  mermaid?: {
    source: string;
  };
}

export type MessagePayloadPreviewSeverity = 'neutral' | 'info' | 'warning';

export type MessagePayloadPreviewActionKind =
  | 'view'
  | 'copy'
  | 'fetch-remote-media'
  | 'open-url'
  | 'preview-file';

export interface MessagePayloadPreviewOptions {
  maxPreviewChars?: number;
}

export interface MessagePayloadPreview {
  kind: PayloadKind;
  title: string;
  detail: string;
  previewText: string;
  severity: MessagePayloadPreviewSeverity;
  actionKind: MessagePayloadPreviewActionKind;
  actionLabel: string;
  meta: string[];
  canInlinePreview: boolean;
  needsRemoteFetch: boolean;
  shouldUseMonospacePreview: boolean;
}

export type FormattedDiffPayloadRowKind = 'header' | 'stats' | 'segment' | 'delete' | 'add';

export interface FormattedDiffPayloadRow {
  key: string;
  kind: FormattedDiffPayloadRowKind;
  text: string;
}

export interface FormattedDiffPayloadLine {
  key: string;
  lineNumber: number;
  text: string;
}

export interface FormattedDiffPayloadSection {
  key: string;
  label: string;
  oldLines: FormattedDiffPayloadLine[];
  newLines: FormattedDiffPayloadLine[];
}

export interface FormattedDiffPayloadView {
  filePath: string;
  stats: string;
  sections: FormattedDiffPayloadSection[];
}

export function buildTextPayload(title: string, body: string): Extract<SharedMessagePayload, { kind: 'text' }> {
  return { kind: 'text', title, body };
}

export function buildDiffPayload<Diff extends PayloadToolDiffLike>(
  diff: Diff,
  localizer?: PresentationLocalizer,
): Extract<SharedMessagePayload<Diff>, { kind: 'diff' }> {
  return {
    kind: 'diff',
    title: diff.filePath,
    diff,
    body: formatDiffPayload(diff, localizer),
  };
}

export function formatPayloadToolUseSummary(toolName: string, input: unknown): string {
  const inp = readPayloadRecord(input);
  if (!inp) return `${toolName}()`;
  const keyParamMap: Record<string, string[]> = {
    Read: ['file_path', 'path'],
    Edit: ['file_path'],
    Write: ['file_path'],
    Bash: ['command'],
    Glob: ['pattern'],
    Grep: ['pattern'],
    // pi 内置工具:名字全小写、文件参数为 path(见 toolUseDescriptor.ts 数据来源约定)。
    read: ['path'],
    edit: ['path'],
    write: ['path'],
    ls: ['path'],
    bash: ['command'],
    grep: ['pattern'],
    find: ['pattern'],
  };
  const keys = keyParamMap[toolName];
  if (!keys) return `${toolName}()`;
  for (const key of keys) {
    const value = inp[key];
    if (value == null || value === '') continue;
    const raw = String(value);
    const display = raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
    return `${toolName}(${display})`;
  }
  return `${toolName}()`;
}

export function buildPayloadToolDiff(toolName: string, input: unknown): PayloadToolDiffLike | undefined {
  const inp = readPayloadRecord(input);
  if (!inp) return undefined;
  const filePath = readPayloadString(inp.file_path) ?? readPayloadString(inp.path);
  if (!filePath) return undefined;

  if (toolName === 'Edit') {
    const oldString = typeof inp.old_string === 'string' ? inp.old_string : '';
    const newString = typeof inp.new_string === 'string' ? inp.new_string : '';
    return createPayloadToolDiff(filePath, [{ key: 'edit:0', oldString, newString }]);
  }
  if (toolName === 'Write' || toolName === 'write') {
    const newString = typeof inp.content === 'string' ? inp.content : '';
    return createPayloadToolDiff(filePath, [{ key: 'write:0', oldString: '', newString }]);
  }
  // pi edit:两种入参形态由 piEditReplacements 统一归一化(edits[] + legacy 顶层单段)。
  if (toolName === 'edit') {
    const replacements = piEditReplacements(inp);
    return createPayloadToolDiff(filePath, replacements.map((edit, index) => ({
      key: `edit:${index}`,
      oldString: edit.oldText,
      newString: edit.newText,
      // 单段时不标 1/1 —— 顶层 legacy 形态就是单段,标号只是噪音。
      ...(replacements.length > 1 ? { label: `Edit ${index + 1}/${replacements.length}` } : {}),
    })));
  }
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(inp.edits) ? inp.edits : [];
    return createPayloadToolDiff(filePath, edits.map((edit, index) => {
      const record = readPayloadRecord(edit);
      return {
        key: `edit:${index}`,
        oldString: typeof record?.old_string === 'string' ? record.old_string : '',
        newString: typeof record?.new_string === 'string' ? record.new_string : '',
        label: `Edit ${index + 1}/${edits.length}`,
      };
    }));
  }
  return undefined;
}

export function buildMediaPayload<Media extends PayloadMediaLike>(
  media: Media,
  label: string,
  localizer?: PresentationLocalizer,
): Extract<SharedMessagePayload<PayloadToolDiffLike, Media>, { kind: 'media' }> {
  const actionNotice = formatMediaActionNotice(media, localizer);
  return {
    kind: 'media',
    title: label,
    media,
    body: [
      media.previewable
        ? media.url
        : `${payloadPresentationText(localizer, 'remoteFetchBody', '移动端会尝试从远程电脑取回媒体。')}\n\n${media.url}`,
      actionNotice,
    ].filter(Boolean).join('\n\n'),
  };
}

export function buildFilePayload(
  title: string,
  sourcePath: string,
  localizer?: PresentationLocalizer,
): Extract<SharedMessagePayload, { kind: 'file' }> {
  return {
    kind: 'file',
    title,
    body: sourcePath || payloadPresentationText(localizer, 'missingRemotePath', '没有可展示的远程路径'),
    sourcePath: sourcePath || undefined,
  };
}

export function buildAttachmentPayload(
  attachment: PayloadAttachmentLike,
  localizer?: PresentationLocalizer,
): AttachmentMessagePayload {
  if (attachment.kind === 'image' && attachment.uri) {
    return buildMediaPayload({
      kind: 'image',
      previewable: attachment.previewable,
      title: attachment.name,
      url: attachment.uri,
    }, attachment.name, localizer);
  }

  const sourcePath = attachment.path || attachment.uri || '';
  const mimeType = attachment.mimeType?.trim().toLowerCase().split(';', 1)[0] ?? '';
  const mediaKind =
    mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : null;
  // User-message persistence historically has only images[] and files[].
  // Audio/video therefore remain files on disk, but a managed-media URL plus
  // its MIME is enough to route mobile playback through remote-media fetch.
  if (mediaKind && isPayloadDesktopLocalMediaUrl(sourcePath)) {
    return buildMediaPayload(
      {
        kind: mediaKind,
        previewable: attachment.previewable,
        title: attachment.name,
        url: sourcePath,
      },
      attachment.name,
      localizer,
    );
  }
  return buildFilePayload(attachment.name, sourcePath, localizer);
}

export function extractPayloadToolResultMedia(toolResult: string): ExtractedPayloadToolMediaLike[] {
  if (!toolResult || typeof toolResult !== 'string') return [];
  if (
    !toolResult.includes('xdt_image_url')
    && !toolResult.includes('xdt_video_url')
    && !toolResult.includes('xdt_audio_url')
  ) {
    return [];
  }
  const parsed = parsePayloadJsonObject(toolResult);
  if (!parsed || parsed._xdt_render_image === false) return [];

  const items: ExtractedPayloadToolMediaLike[] = [];
  const actions = parsePayloadToolMediaActions(parsed._xdt_actions);
  const push = (
    kind: ExtractedPayloadToolMediaLike['kind'],
    url: string,
    title?: string,
    mediaActions?: ExtractedPayloadToolMediaActionsLike,
  ) => {
    items.push({
      kind,
      url,
      title,
      previewable: isPayloadDirectPreviewableUrl(url),
      ...(mediaActions ? { actions: mediaActions } : {}),
    });
  };

  // 图片/视频双协议:老 xdt-image/xdt-video(历史消息)+ 新 cindy-media(媒体总仓
  // 迁移后 art/mivo/codex 生成产物的地址形态,字段名不变、值换协议)。
  const isManagedImageUrl = (url: string): boolean =>
    url.startsWith('xdt-image://') || url.startsWith('cindy-media://');
  const isManagedVideoUrl = (url: string): boolean =>
    url.startsWith('xdt-video://') || url.startsWith('cindy-media://');
  if (typeof parsed.xdt_image_url === 'string' && isManagedImageUrl(parsed.xdt_image_url)) {
    push('image', parsed.xdt_image_url, undefined, actions);
  }
  if (Array.isArray(parsed.xdt_image_urls)) {
    for (const url of parsed.xdt_image_urls) {
      if (typeof url === 'string' && isManagedImageUrl(url)) {
        push('image', url, undefined, actions);
      }
    }
  }
  if (typeof parsed.xdt_video_url === 'string' && isManagedVideoUrl(parsed.xdt_video_url)) {
    push('video', parsed.xdt_video_url, undefined, actions);
  }
  if (Array.isArray(parsed.xdt_video_urls)) {
    for (const url of parsed.xdt_video_urls) {
      if (typeof url === 'string' && isManagedVideoUrl(url)) {
        push('video', url, undefined, actions);
      }
    }
  }

  // 音频双世界:老 _xdt_audio_tracks + xdt-audio://(退役 lizi_mivo MCP 历史消息)
  // + 新 xdt_audio_tracks + cindy-media://(意识 xd-mivo 等,cindy-tools hoist 上提)。
  const isManagedAudioUrl = (url: string): boolean =>
    url.startsWith('xdt-audio://') || url.startsWith('cindy-media://');
  const rawAudioTracks = parsed.xdt_audio_tracks ?? parsed._xdt_audio_tracks;
  const audioTracks = Array.isArray(rawAudioTracks) ? rawAudioTracks : [];
  for (const raw of audioTracks) {
    const track = readPayloadRecord(raw);
    const audioUrl = readPayloadString(track?.xdt_audio_url) ?? readPayloadString(track?.audioUrl);
    if (audioUrl && isManagedAudioUrl(audioUrl)) {
      push('audio', audioUrl, readPayloadString(track?.title) ?? undefined);
    }
  }
  if (items.every((item) => item.kind !== 'audio') && Array.isArray(parsed.xdt_audio_urls)) {
    for (const url of parsed.xdt_audio_urls) {
      if (typeof url === 'string' && isManagedAudioUrl(url)) push('audio', url);
    }
  }

  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

export function buildMermaidPayload(
  source: string,
  localizer?: PresentationLocalizer,
): Extract<SharedMessagePayload, { kind: 'mermaid' }> {
  return {
    kind: 'mermaid',
    title: payloadPresentationText(localizer, 'mermaidSourceTitle', 'Mermaid 图表源码'),
    body: source,
  };
}

export function summarizeMessagePayload(
  payload: SharedMessagePayload,
  localizer?: PresentationLocalizer,
): MessagePayloadSummary {
  switch (payload.kind) {
    case 'diff':
      return {
        kind: 'diff',
        kindLabel: 'DIFF',
        title: payload.title,
        subtitle: formatDiffStats(payload.diff, localizer),
        copyableText: formatDiffPayload(payload.diff, localizer),
        sourcePath: payload.diff.filePath,
        openTarget: { kind: 'file', value: payload.diff.filePath },
      };
    case 'file': {
      const sourcePath = payload.sourcePath ?? '';
      return {
        kind: 'file',
        kindLabel: 'FILE',
        title: payload.title,
        subtitle: sourcePath || undefined,
        copyableText: sourcePath || payload.body,
        sourcePath: sourcePath || undefined,
        openTarget: sourcePath ? { kind: 'file', value: sourcePath } : undefined,
      };
    }
    case 'media':
      return {
        kind: 'media',
        kindLabel: payload.media.kind.toUpperCase(),
        title: payload.title,
        subtitle: payload.media.previewable
          ? payloadPresentationText(localizer, 'directPreview', '可直接预览')
          : payloadPresentationText(localizer, 'remoteFetchRequired', '需要远程取件'),
        copyableText: payload.media.url,
        openTarget: payload.media.previewable ? { kind: 'url', value: payload.media.url } : undefined,
      };
    case 'mermaid':
      return {
        kind: 'mermaid',
        kindLabel: 'MERMAID',
        title: payload.title,
        subtitle: payloadPresentationText(localizer, 'chartSource', '图表源码'),
        copyableText: payload.body,
      };
    case 'text':
      return {
        kind: 'text',
        kindLabel: 'TEXT',
        title: payload.title,
        copyableText: payload.body,
      };
  }
}

export function summarizeMessagePayloadBody(
  payload: SharedMessagePayload,
  localizer?: PresentationLocalizer,
): MessagePayloadBodyPresentation {
  switch (payload.kind) {
    case 'diff': {
      const view = formatDiffPayloadView(payload.diff, localizer);
      return {
        bodyText: payload.body,
        diff: {
          filePath: view.filePath,
          sectionCount: view.sections.length,
          stats: view.stats,
        },
        emptyText: payloadPresentationText(localizer, 'noDiffContent', '没有 diff 内容。'),
        kind: 'diff',
        textMonospace: true,
      };
    }
    case 'file': {
      const sourcePath = payload.sourcePath ?? '';
      return {
        bodyText: payload.body || sourcePath,
        emptyText: payloadPresentationText(localizer, 'missingRemotePathSentence', '没有可展示的远程路径。'),
        file: {
          displayPath: sourcePath || payload.body || payloadPresentationText(localizer, 'missingRemotePath', '没有可展示的远程路径'),
          sourcePath,
        },
        kind: 'file',
        textMonospace: true,
      };
    }
    case 'media': {
      const directPreviewable = payload.media.previewable && isPayloadDirectPreviewableUrl(payload.media.url);
      const needsRemoteFetch = !payload.media.previewable && isPayloadDesktopLocalMediaUrl(payload.media.url);
      const canInlineDirectImage = payload.media.kind === 'image' && directPreviewable;
      const canInlineDirectPlayer = (payload.media.kind === 'video' || payload.media.kind === 'audio') && directPreviewable;
      const bodyText = formatMediaPayloadDisplayText(payload, localizer);
      return {
        bodyText,
        emptyText: payloadPresentationText(localizer, 'noMediaAddress', '没有媒体地址。'),
        kind: 'media',
        media: {
          canDirectOpen: isPayloadDirectPreviewableUrl(payload.media.url),
          canInlineDirectImage,
          canInlineDirectPlayer,
          directPreviewable,
          kindLabel: payloadMediaKindLabel(payload.media.kind, localizer),
          needsRemoteFetch,
          placeholderText: needsRemoteFetch
            ? payloadPresentationText(localizer, 'remoteMediaPreparing', '正在准备远程媒体取件')
            : payload.media.previewable
              ? payloadPresentationText(localizer, 'mediaAddressOnlySentence', '当前媒体类型暂以地址形式展示。')
              : payloadPresentationText(localizer, 'mediaCannotPreviewSentence', '当前媒体暂不能直接预览。'),
          remoteIdleText: payloadPresentationText(localizer, 'remoteMediaPreparing', '正在准备远程媒体取件'),
          unsupportedText: payload.media.previewable
            ? payloadPresentationText(localizer, 'mediaAddressOnlySentence', '当前媒体类型暂以地址形式展示。')
            : payloadPresentationText(localizer, 'mediaCannotPreviewSentence', '当前媒体暂不能直接预览。'),
        },
        textMonospace: false,
      };
    }
    case 'mermaid':
      return {
        bodyText: payload.body,
        emptyText: payloadPresentationText(localizer, 'emptyMermaid', '空 Mermaid 图表。'),
        kind: 'mermaid',
        mermaid: { source: payload.body },
        textMonospace: true,
      };
    case 'text':
      return {
        bodyText: payload.body,
        emptyText: payloadPresentationText(localizer, 'noTextContent', '没有可展示的文本内容。'),
        kind: 'text',
        textMonospace: false,
      };
  }
}

export function summarizeMessagePayloadPreview(
  payload: SharedMessagePayload,
  options: MessagePayloadPreviewOptions = {},
  localizer?: PresentationLocalizer,
): MessagePayloadPreview {
  const maxPreviewChars = Math.max(24, options.maxPreviewChars ?? 220);

  switch (payload.kind) {
    case 'diff': {
      const stats = formatDiffStats(payload.diff, localizer);
      const editCount = payload.diff.segments.length;
      return {
        actionKind: 'view',
        actionLabel: payloadPresentationText(localizer, 'viewDiff', '查看 diff'),
        canInlinePreview: false,
        detail: `${payload.diff.filePath} · ${stats}`,
        kind: 'diff',
        meta: [stats, payloadPresentationText(localizer, 'editCount', `${editCount} 处编辑`, { count: editCount })],
        needsRemoteFetch: false,
        previewText: trimPayloadPreviewText(formatDiffPreviewText(payload.diff, localizer), maxPreviewChars)
          || payloadPresentationText(localizer, 'noDiffContent', '没有 diff 内容。'),
        severity: payload.diff.insertions > 0 || payload.diff.deletions > 0 ? 'info' : 'neutral',
        shouldUseMonospacePreview: true,
        title: payload.title,
      };
    }
    case 'file': {
      const sourcePath = payload.sourcePath ?? '';
      const hasSourcePath = !!sourcePath.trim();
      return {
        actionKind: hasSourcePath ? 'preview-file' : 'view',
        actionLabel: hasSourcePath
          ? payloadPresentationText(localizer, 'previewFile', '预览文件')
          : payloadPresentationText(localizer, 'viewDetails', '查看详情'),
        canInlinePreview: false,
        detail: hasSourcePath ? sourcePath : payloadPresentationText(localizer, 'noRemotePath', '没有远程路径'),
        kind: 'file',
        meta: [hasSourcePath ? sourcePath : payloadPresentationText(localizer, 'remotePathMissing', '缺少远程路径')],
        needsRemoteFetch: false,
        previewText: trimPayloadPreviewText(
          payload.body || sourcePath || payloadPresentationText(localizer, 'missingRemotePathSentence', '没有可展示的远程路径。'),
          maxPreviewChars,
        ),
        severity: hasSourcePath ? 'neutral' : 'warning',
        shouldUseMonospacePreview: true,
        title: payload.title,
      };
    }
    case 'media': {
      const directPreviewable = payload.media.previewable && isPayloadDirectPreviewableUrl(payload.media.url);
      const needsRemoteFetch = !payload.media.previewable && isPayloadDesktopLocalMediaUrl(payload.media.url);
      const canInlinePreview = directPreviewable
        && (payload.media.kind === 'image' || payload.media.kind === 'video' || payload.media.kind === 'audio');
      const kindLabel = payloadMediaKindLabel(payload.media.kind, localizer);
      const actionNotice = formatMediaActionNotice(payload.media, localizer);
      if (needsRemoteFetch) {
        return {
          actionKind: 'fetch-remote-media',
          actionLabel: payloadPresentationText(localizer, 'fetchMedia', '取回媒体'),
          canInlinePreview: false,
          detail: payloadPresentationText(localizer, 'fetchMediaFromDesktop', '需要从电脑端取回媒体'),
          kind: 'media',
          meta: [kindLabel, payloadPresentationText(localizer, 'pendingFetch', '待取件')],
          needsRemoteFetch: true,
          previewText: trimPayloadPreviewText([payload.media.url, actionNotice].filter(Boolean).join('\n'), maxPreviewChars),
          severity: 'info',
          shouldUseMonospacePreview: false,
          title: payload.title,
        };
      }
      if (directPreviewable) {
        const displayText = formatMediaPayloadDisplayText(payload, localizer);
        return {
          actionKind: 'open-url',
          actionLabel: payloadPresentationText(localizer, 'previewMedia', '预览媒体'),
          canInlinePreview,
          detail: payloadPresentationText(localizer, 'directPreview', '可直接预览'),
          kind: 'media',
          meta: [kindLabel, payloadPresentationText(localizer, 'previewable', '可预览')],
          needsRemoteFetch: false,
          previewText: trimPayloadPreviewText(displayText, maxPreviewChars),
          severity: 'neutral',
          shouldUseMonospacePreview: false,
          title: payload.title,
        };
      }
      return {
        actionKind: payload.media.previewable ? 'open-url' : 'view',
        actionLabel: payload.media.previewable
          ? payloadPresentationText(localizer, 'openMedia', '打开媒体')
          : payloadPresentationText(localizer, 'viewDetails', '查看详情'),
        canInlinePreview: false,
        detail: payload.media.previewable
          ? payloadPresentationText(localizer, 'mediaAddressOnly', '当前媒体以地址形式展示')
          : payloadPresentationText(localizer, 'mediaCannotPreview', '当前媒体暂不能直接预览'),
        kind: 'media',
        meta: [
          kindLabel,
          payload.media.previewable
            ? payloadPresentationText(localizer, 'addressDisplay', '地址展示')
            : payloadPresentationText(localizer, 'notPreviewable', '不可预览'),
        ],
        needsRemoteFetch: false,
        previewText: trimPayloadPreviewText([payload.media.url, actionNotice].filter(Boolean).join('\n'), maxPreviewChars),
        severity: payload.media.previewable ? 'info' : 'warning',
        shouldUseMonospacePreview: false,
        title: payload.title,
      };
    }
    case 'mermaid':
      return {
        actionKind: 'view',
        actionLabel: payloadPresentationText(localizer, 'viewChart', '查看图表'),
        canInlinePreview: true,
        detail: payloadPresentationText(localizer, 'mermaidSourceTitle', 'Mermaid 图表源码'),
        kind: 'mermaid',
        meta: [payloadPresentationText(localizer, 'chartSource', '图表源码')],
        needsRemoteFetch: false,
        previewText: trimPayloadPreviewText(
          payload.body || payloadPresentationText(localizer, 'emptyMermaid', '空 Mermaid 图表。'),
          maxPreviewChars,
        ),
        severity: 'neutral',
        shouldUseMonospacePreview: true,
        title: payload.title,
      };
    case 'text':
      return {
        actionKind: 'view',
        actionLabel: payloadPresentationText(localizer, 'viewContent', '查看内容'),
        canInlinePreview: false,
        detail: payloadPresentationText(localizer, 'textOutput', '文本输出'),
        kind: 'text',
        meta: [payloadPresentationText(localizer, 'text', '文本')],
        needsRemoteFetch: false,
        previewText: trimPayloadPreviewText(
          payload.body || payloadPresentationText(localizer, 'noTextContent', '没有可展示的文本内容。'),
          maxPreviewChars,
        ),
        severity: 'neutral',
        shouldUseMonospacePreview: false,
        title: payload.title,
      };
  }
}

export function payloadMediaKindLabel(
  kind: PayloadMediaLike['kind'],
  localizer?: PresentationLocalizer,
): string {
  if (kind === 'image') return payloadPresentationText(localizer, 'image', '图片');
  if (kind === 'video') return payloadPresentationText(localizer, 'video', '视频');
  return payloadPresentationText(localizer, 'audio', '音频');
}

function formatMediaPayloadDisplayText(
  payload: Extract<SharedMessagePayload, { kind: 'media' }>,
  localizer?: PresentationLocalizer,
): string {
  const dataImage = describeDataImageUrl(payload.media.url);
  if (!dataImage) return payload.body || payload.media.url;
  return [
    payloadPresentationText(localizer, 'inlineMediaData', `内联${payloadMediaKindLabel(payload.media.kind, localizer)}数据`, {
      kind: payloadMediaKindLabel(payload.media.kind, localizer),
    }),
    dataImage.mimeLabel,
    dataImage.sizeLabel,
    formatMediaActionNotice(payload.media, localizer),
  ].filter(Boolean).join(' · ');
}

function describeDataImageUrl(url: string): { mimeLabel: string; sizeLabel: string } | null {
  const match = /^data:image\/([^;,]+)(?:;[^,]*)?,([a-zA-Z0-9+/=\s]+)$/.exec(url);
  if (!match) return null;
  const subtype = match[1]?.trim().toUpperCase() || 'IMAGE';
  const encoded = (match[2] ?? '').replace(/\s/g, '');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
  return {
    mimeLabel: subtype,
    sizeLabel: formatPayloadByteSize(bytes),
  };
}

function formatPayloadByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

export function isPayloadDesktopLocalMediaUrl(url: unknown): url is string {
  return (
    typeof url === 'string'
    && (
      url.startsWith('xdt-image://')
      || url.startsWith('xdt-video://')
      || url.startsWith('xdt-file://')
      || url.startsWith('xdt-audio://')
      // 媒体总仓内容寻址 blob(cindy-media://blobs/<指纹>.<ext>):desktop 的
      // device-link mediaFetch 已支持按此协议解析取件,手机端同样走 resolver。
      || url.startsWith('cindy-media://')
    )
  );
}

export function isPayloadDirectPreviewableUrl(url: unknown): url is string {
  return (
    typeof url === 'string'
    && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:image/'))
  );
}

export function formatDiffPayload(
  diff: PayloadToolDiffLike,
  localizer?: PresentationLocalizer,
): string {
  const head = [
    diff.filePath,
    formatDiffStats(diff, localizer),
  ];
  const segments = diff.segments.map((segment, index) => {
    const label = segment.label ?? `Edit ${index + 1}/${diff.segments.length}`;
    const oldBlock = formatChangedBlock('-', segment.oldString);
    const newBlock = formatChangedBlock('+', segment.newString);
    return [label, oldBlock, newBlock].filter(Boolean).join('\n');
  });
  return [...head, ...segments].join('\n\n');
}

export function formatDiffPayloadRows(
  diff: PayloadToolDiffLike,
  localizer?: PresentationLocalizer,
): FormattedDiffPayloadRow[] {
  const rows: FormattedDiffPayloadRow[] = [
    { key: 'header', kind: 'header', text: diff.filePath },
    { key: 'stats', kind: 'stats', text: formatDiffStats(diff, localizer) },
  ];
  diff.segments.forEach((segment, index) => {
    const label = segment.label ?? `Edit ${index + 1}/${diff.segments.length}`;
    rows.push({ key: `${segment.key}:label`, kind: 'segment', text: label });
    for (const [lineIndex, line] of splitChangedLines(segment.oldString).entries()) {
      rows.push({
        key: `${segment.key}:old:${lineIndex}`,
        kind: 'delete',
        text: `- ${line}`,
      });
    }
    for (const [lineIndex, line] of splitChangedLines(segment.newString).entries()) {
      rows.push({
        key: `${segment.key}:new:${lineIndex}`,
        kind: 'add',
        text: `+ ${line}`,
      });
    }
  });
  return rows;
}

export function formatDiffPayloadView(
  diff: PayloadToolDiffLike,
  localizer?: PresentationLocalizer,
): FormattedDiffPayloadView {
  return {
    filePath: diff.filePath,
    stats: formatDiffStats(diff, localizer),
    sections: diff.segments.map((segment, index) => ({
      key: segment.key,
      label: segment.label ?? `Edit ${index + 1}/${diff.segments.length}`,
      oldLines: splitChangedLines(segment.oldString).map((line, lineIndex) => ({
        key: `${segment.key}:old:${lineIndex}`,
        lineNumber: lineIndex + 1,
        text: line,
      })),
      newLines: splitChangedLines(segment.newString).map((line, lineIndex) => ({
        key: `${segment.key}:new:${lineIndex}`,
        lineNumber: lineIndex + 1,
        text: line,
      })),
    })),
  };
}

export function formatMediaActionNotice(
  media: PayloadMediaLike,
  localizer?: PresentationLocalizer,
): string {
  const actions = media.actions;
  if (!actions?.buttons.length) return '';
  const labels = actions.buttons.map(formatMediaActionButtonLabel).join(' / ');
  return [
    payloadPresentationText(localizer, 'mediaActionsAvailable', '桌面端为这个媒体提供了后续操作。'),
    payloadPresentationText(localizer, 'availableActions', `可用操作：${labels}`, { actions: labels }),
    payloadPresentationText(
      localizer,
      'mediaActionsDesktopOnly',
      '手机版 V1 只安全展示这些操作，暂不远程触发。请回到电脑端点击。',
    ),
  ].join('\n');
}

function formatChangedBlock(prefix: '-' | '+', value: string): string {
  if (!value) return '';
  return splitChangedLines(value).map((line) => `${prefix} ${line}`).join('\n');
}

function splitChangedLines(value: string): string[] {
  if (!value) return [];
  return value.split('\n');
}

function formatDiffPreviewText(
  diff: PayloadToolDiffLike,
  localizer?: PresentationLocalizer,
): string {
  const firstSegment = diff.segments[0];
  if (!firstSegment) return '';
  const label = firstSegment.label ?? `Edit 1/${diff.segments.length}`;
  const oldLines = splitChangedLines(firstSegment.oldString).slice(0, 2).map((line) => `- ${line}`);
  const newLines = splitChangedLines(firstSegment.newString).slice(0, 2).map((line) => `+ ${line}`);
  const more = diff.segments.length > 1
    ? [payloadPresentationText(localizer, 'moreEdits', `…还有 ${diff.segments.length - 1} 处编辑`, {
        count: diff.segments.length - 1,
      })]
    : [];
  return [label, ...oldLines, ...newLines, ...more].filter(Boolean).join('\n');
}

function formatDiffStats(
  diff: Pick<PayloadToolDiffLike, 'insertions' | 'deletions'>,
  localizer?: PresentationLocalizer,
): string {
  return payloadPresentationText(
    localizer,
    'diffStats',
    `+${diff.insertions} / -${diff.deletions} 行`,
    { insertions: diff.insertions, deletions: diff.deletions },
  );
}

function payloadPresentationText(
  localizer: PresentationLocalizer | undefined,
  key: string,
  fallback: string,
  values?: Readonly<Record<string, string | number | boolean | null | undefined>>,
): string {
  return presentationText(localizer, `message.payloadPresentation.${key}`, fallback, values);
}

function trimPayloadPreviewText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatMediaActionButtonLabel(button: PayloadMediaActionButtonLike): string {
  if (button.label?.trim()) return button.label;
  if (button.emoji?.trim()) return button.emoji;
  const parts = button.customId.split('::');
  if (parts.length >= 4 && parts[1] === 'JOB') {
    if (parts[2] === 'upsample') return `U${parts[3]}`;
    if (parts[2] === 'variation') return `V${parts[3]}`;
    if (parts[2] === 'reroll') return 'Reroll';
    return parts[2].slice(0, 12);
  }
  return button.customId.slice(0, 16);
}

function parsePayloadToolMediaActions(raw: unknown): ExtractedPayloadToolMediaActionsLike | undefined {
  const record = readPayloadRecord(raw);
  if (!record || record.provider !== 'mivo') return undefined;
  const jobId = readPayloadString(record.jobId);
  if (!jobId || !Array.isArray(record.buttons)) return undefined;

  const buttons = record.buttons.flatMap((rawButton): PayloadMediaActionButtonLike[] => {
    const button = readPayloadRecord(rawButton);
    const customId = readPayloadString(button?.customId);
    if (!customId) return [];
    return [{
      customId,
      label: readPayloadString(button?.label) ?? undefined,
      emoji: readPayloadString(button?.emoji) ?? undefined,
    }];
  });
  return buttons.length > 0 ? { provider: 'mivo', jobId, buttons } : undefined;
}

function parsePayloadJsonObject(value: string): Record<string, unknown> | null {
  try {
    return readPayloadRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function readPayloadRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPayloadString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function createPayloadToolDiff(
  filePath: string,
  segments: Array<{ key: string; oldString: string; newString: string; label?: string }>,
): PayloadToolDiffLike {
  return {
    filePath,
    segments,
    insertions: segments.reduce((sum, segment) => sum + countPayloadChangedLines(segment.newString), 0),
    deletions: segments.reduce((sum, segment) => sum + countPayloadChangedLines(segment.oldString), 0),
  };
}

function countPayloadChangedLines(value: string): number {
  if (!value) return 0;
  return value.split('\n').filter((line) => line.length > 0).length || 1;
}
