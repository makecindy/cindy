/**
 * AgentActionRow
 * ---------------------------------------------------------------------------
 * F2 / F11 / F12 (cc-agent-compact-blocks v2) — single tool call rendered as
 * a compact row inside the expanded AgentActionsBlock container.
 *
 * Visual contract (sourced from `.pen` reference frame `1Tnsk` — Light
 * expanded Tool Block, e.g. node `UXwq7` "Item Edited 1"):
 *   - Row chrome: cornerRadius 6, padding [4,8], gap 6, hover lifts to
 *     `--msg-code-inline-bg`.
 *   - Status icon (issue #450): 固定 16px 首槽位,running = LoaderCircle
 *     spin / done = Check,同色 `--msg-tool-card-chevron`。
 *   - Verb label: Inter 14 / weight normal / `--msg-tool-card-chevron`,
 *     capitalized ("Edited", "Ran"),i18n 化;command 行有模型 description
 *     时隐藏(description 独立成句,见 extractDisplayParam)。
 *   - Display param:
 *       Edit / Write / MultiEdit / Read → rendered as a real **file chip**
 *         (chat-input-chip-* tokens), file icon + basename, click triggers
 *         the appropriate Lightbox.
 *       Bash / Grep / Glob / WebFetch / WebSearch → plain neutral text
 *         (`--msg-tool-card-chevron`, same as the verb label) inline; row or
 *         chevron activation toggles inline input + tool_result details.
 *         (v8 2026-04-20: was `--info-700` blue —— docs/design-rules/cindy-design-system.md §2 严禁 chromatic
 *         color，secondary 文本只允许 Stone/Mid Gray/Silver 三档纯灰，蓝色违规。
 *         改用 `--msg-tool-card-chevron` (#525252 Light / #a3a3a3 Dark) 与动词
 *         同色，保持 docs/design-rules/cindy-design-system.md 要求的纯灰色系。)
 *   - +N / -N stats: JetBrains Mono 13 / weight 500 / `--diff-add-fg` and
 *     `--diff-del-fg`. Rendered for Edit / Write / MultiEdit (ADR-5).
 *   - Trailing chevron: lucide ChevronRight 13 / `--msg-tool-card-chevron`,
 *     a click target that opens file/diff lightboxes for file path tools, or
 *     toggles inline details for command tools.
 *
 * Current detail behavior:
 *   - File path tools keep the v2 Lightbox contract.
 *   - Command tools use the v10 inline detail view; they do not open the
 *     payload Lightbox.
 *   - File chips reuse the shared chip token system (--chat-input-chip-*),
 *     bringing visual parity with the input-mention chip and the user-message
 *     attachment chip.
 */

import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown, ChevronRight, File as FileIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  describeToolUse,
  normalizeDisplayCommand,
  piEditReplacements,
  type CommandIntent,
  type ToolUseDescriptor,
} from '@cindy/maker-shared';

import { cn, basename } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import type { ChatMessage } from '@/lib/makerChatStore';
import { verbForTool, verbLabelKeyForIntent, verbLabelKeyForRow } from '@/lib/agent-actions/verbAggregator';
import { statsForToolCall } from '@/lib/agent-actions/diffStats';
import { extractDisplayParam } from '@/lib/agent-actions/actionPresentation';
import { SUPPORTED_IMAGE_EXTS, extractExt } from '@/lib/fileTypes';
import { toLocalFileUrl, resolveToolFilePath } from '@/lib/localPathResolver';
import { isBrowserOpenablePath } from '../../../shared/browserOpenableExts';
import { isGhostCallToolName } from '../../../shared/ghost';
import { shouldOpenTextLightboxForOrigin } from '@/lib/filePreview';
import { toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import { rewriteToRemoteMediaOrigin } from '../../../shared/remoteMediaUrl';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { useChatSessionFile } from './ChatSessionFileContext';
import { ImageLightbox } from './ImageLightbox';
import { TextLightbox } from './TextLightbox';
import { ToolPayloadLightbox, type ToolPayloadMode } from './ToolPayloadLightbox';
import { useFileChipContextMenu } from './useFileChipContextMenu';

/**
 * 点击走「文件类」交互(diff / 文稿 / 图片 lightbox)的工具:CC 大写 + pi 小写
 * (pi 内置工具名全小写、文件字段为 path,见 toolUseDescriptor.ts)。
 *
 * 注意这**不是**「所有 kind='file' 描述符」的集合:pi 的 `ls` 也被归一化成
 * kind='file'(读取语义)并渲染文件 chip,但**刻意不列入本集合** —— 它的目标是
 * 目录,开文稿/图片 lightbox 没有意义,因此点击仍走命令类的就地展开路径
 * (isInlineExpand)。新增工具时按「点击后该看到什么」判断是否入列,别按
 * 描述符 kind 判断。
 */
const FILE_PATH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Read', 'edit', 'write', 'read']);

/**
 * v10 (2026-04-20): 命令类工具(Bash/Grep/Glob/WebFetch/WebSearch/...)的
 * 二级查看从 lightbox 改为就地展开 — 用户反馈:文稿浏览器只该用于"打开
 * 文件",命令的 input/output 这种短小内容用全屏弹窗杀鸡用牛刀。
 *
 * 文件类工具(FILE_PATH_TOOLS)保持 v2 契约 — chip 点击/行点击都开 lightbox
 * (TextLightbox 看文件 / DiffView 看 diff),因为这些内容真的需要大空间。
 *
 * 把 Bash 单独 input 拼一段、把 Grep 多 key 拼成多行的格式化逻辑收在这里。
 */
/**
 * 从 tool_result 文本里提取要渲染的媒体(图/视频)。
 *
 * 支持四种字段(都可以同时存在):
 *   - `xdt_image_url`(单张) — feishu media_download 单图下载注入
 *   - `xdt_image_urls`(多张) — feishu read_by_url / lizi_art 出图
 *   - `xdt_video_urls`(多个) — lizi_art video_generate / video_edit 出视频
 *   - `xdt_video_url`(单个)  — 兼容未来单视频工具
 *
 * Sentinel:
 *   - `_xdt_render_image: false` — server 显式要求"不要把任何媒体推到聊天气泡",
 *     image / video 都跳过。
 *   - 缺失或 true → 推流到气泡。
 *
 * 安全:每个 URL 必须带正确 scheme 前缀(xdt-image:// 或 xdt-video://),否则丢弃。
 */
export type ToolMediaKind = 'image' | 'video' | 'audio';

/**
 * 3D 模型文件元数据 (来自 poll_3d_result 的 _xdt_model_files)。
 *
 * 携带在对应预览图 ToolMediaItem 上 — ChatImageView 看到 modelFile 时
 * 点击路由到 ModelLightbox(3D 查看器),右键菜单从"复制图片 / 打开图片
 * 所在目录"换成"打开模型 / 打开模型所在目录" — 操作的是模型文件本体,
 * 不是预览图。与预览图按位配对(每任务 1 预览 + 1 模型)。
 *
 * 来源:意识链路(provider 'cindy'),GLB 已由意识落进媒体总仓,url 直接加载。
 * (老 lizi_mivo MCP 的 mivo provider 已随 MCP 退役下线,2026-07-13:历史
 * 消息里的 mivo 3D 预览降级为普通图片,不再懒下载模型文件。)
 */
export interface ToolMediaModelFileCindy {
  provider: 'cindy';
  /** cindy-media://blobs/<指纹>.glb — <model-viewer> 可直接 fetch 的总仓地址。 */
  url: string;
  /** 模型格式(意识链路当前总是 'GLB')。 */
  format: string;
}

export type ToolMediaModelFile = ToolMediaModelFileCindy;

/**
 * Audio track metadata surfaced to ChatAudioCard / ChatSoundEffectCard.
 * Carried per audio entry by `xdt_audio_tracks`(ghost 世界,意识 result 经
 * cindy-tools hoist 上提)or the legacy renderer-only `_xdt_audio_tracks`
 * (退役 lizi_mivo MCP 的历史消息).
 *
 * `kind` drives which card variant renders the entry:
 *   - 'music'        → ChatAudioCard          (cover + tags + lyrics + player)
 *   - 'sound_effect' → ChatSoundEffectCard    (compact, no cover, title + player)
 *
 * For 'music' the optional cover URL falls back to a music-icon placeholder
 * inside ChatAudioCard when absent. For 'sound_effect' cover / tags / lyrics
 * are always empty (server strips them) so the compact card only needs title +
 * audio URL.
 */
export interface ToolAudioTrack {
  /**
   * Card variant selector. Defaults to 'music' when parser sees a legacy entry
   * without `kind` (e.g. pre-sound-effect Suno results), so the existing
   * ChatAudioCard path stays binary-compatible.
   */
  kind: 'music' | 'sound_effect';
  /** `<audio>` src:cindy-media://blobs/…或历史 xdt-audio://local/?path=…。 */
  audioUrl: string;
  /** xdt-image://... cover art (Suno gives one per track); optional. */
  coverUrl?: string;
  title: string;
  tags: string;
  lyrics: string;
  durationSeconds: number;
  sunoId?: string;
}

export interface ToolMediaItem {
  kind: ToolMediaKind;
  url: string;
  /** Optional 3D 模型文件引用 — image 类型且来自 mivo 3D 任务时存在。 */
  modelFile?: ToolMediaModelFile;
  /** Audio-only: full Suno track metadata for ChatAudioCard rendering. */
  audioTrack?: ToolAudioTrack;
  /** Audio-only: 结果带 xdt_audio_in_card 令牌(意识声明播放器已画进自己的
   *  卡)。**待验证声明**,不在提取层裁决——MessageStream 锚到同意识卡并
   *  确认其 html 真含对应 data-ghost-audio 插槽才压基座渲染;验证不过
   *  (远程控制端无卡 / card-update 被拒 / 老渲染层)照常渲染基座播放器。 */
  audioInCard?: boolean;
  /** Image-only: 结果带 xdt_images_in_card 令牌(意识声明图片已画进自己的
   *  卡)。语义同 audioInCard:待验证声明,MessageStream 确认锚卡 html 真含
   *  对应图片地址才压基座渲染;验证不过照常渲染,图片永不消失。 */
  imageInCard?: boolean;
}

function parseModelFiles(raw: unknown): ToolMediaModelFile[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolMediaModelFile[] = [];
  for (const m of raw) {
    if (typeof m !== 'object' || m === null) continue;
    const mo = m as Record<string, unknown>;
    if (mo.provider === 'cindy') {
      // 意识链路:模型已在媒体总仓。只认 cindy-media 的 .glb 地址 —
      // model-viewer 仅原生支持 glTF 系,且总仓扩展名白名单当前只收 .glb
      // (.gltf 不在白名单,协议取件必失败,放行只会产出坏查看器)。
      const url = typeof mo.url === 'string' ? mo.url : null;
      if (!url?.startsWith('cindy-media://')) continue;
      if (!url.toLowerCase().endsWith('.glb')) continue;
      const format = typeof mo.format === 'string' && mo.format ? mo.format : 'GLB';
      out.push({ provider: 'cindy', url, format });
    }
  }
  return out;
}

/**
 * Parse the renderer-only `_xdt_audio_tracks` array from the tool result JSON
 * (emitted by mivo Suno poll_result). Coerces shapes and drops malformed
 * entries so the caller never sees half-built tracks. Returns [] on missing /
 * non-array input.
 */
function parseAudioTracks(raw: unknown): ToolAudioTrack[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolAudioTrack[] = [];
  for (const t of raw) {
    if (typeof t !== 'object' || t === null) continue;
    const obj = t as Record<string, unknown>;
    const audioUrl = typeof obj.xdt_audio_url === 'string' ? obj.xdt_audio_url : null;
    if (!audioUrl || !isToolAudioUrl(audioUrl)) continue;
    const coverUrl =
      typeof obj.cover_url === 'string' &&
      (obj.cover_url.startsWith('xdt-image://') || obj.cover_url.startsWith('cindy-media://'))
        ? obj.cover_url
        : undefined;
    // kind 字段是新增 — 老版本 server / 历史 message 没带,默认按 'music' 渲染保
    // 持兼容(那条路径自带 cover placeholder,不会因 missing kind 走崩)。
    const kind: 'music' | 'sound_effect' =
      obj.kind === 'sound_effect' ? 'sound_effect' : 'music';
    out.push({
      kind,
      audioUrl,
      ...(coverUrl ? { coverUrl } : {}),
      title: typeof obj.title === 'string' ? obj.title : '',
      tags: typeof obj.tags === 'string' ? obj.tags : '',
      lyrics: typeof obj.lyrics === 'string' ? obj.lyrics : '',
      durationSeconds: typeof obj.duration_seconds === 'number' ? obj.duration_seconds : 0,
      ...(typeof obj.suno_id === 'string' && obj.suno_id ? { sunoId: obj.suno_id } : {}),
    });
  }
  return out;
}

/**
 * 图卡接受的取件协议:历史 xdt-image://(只读)+ 媒体总仓
 * cindy-media://(媒体总仓,内容寻址;意识 gen_image 等新链路的产物)。
 * cindy-media 是图还是视频由落盘后缀定,放进 xdt_image_urls 字段即当图渲染。
 */
function isToolImageUrl(url: string): boolean {
  return url.startsWith('xdt-image://') || url.startsWith('cindy-media://');
}

/** 视频卡接受的取件协议(与图卡同款双世界;cindy-media 后缀即视频的才会被塞进 xdt_video_urls)。 */
function isToolVideoUrl(url: string): boolean {
  return url.startsWith('xdt-video://') || url.startsWith('cindy-media://');
}

/**
 * 音频卡接受的取件协议:历史 xdt-audio://(退役 lizi_mivo MCP 的历史消息,
 * 只读)+ 媒体总仓 cindy-media://(意识 xd-mivo 等当前链路的产物)。
 */
function isToolAudioUrl(url: string): boolean {
  return url.startsWith('xdt-audio://') || url.startsWith('cindy-media://');
}

/**
 * 从 ghost_call 的 tool_result JSON 里提取卡片配对令牌(卡槽③):顶层
 * xdt_card_id(主机仅在该次调用真供过卡时注入,值 = 管子 callId)。
 * renderer 据此从 ghostCardStore 取卡渲染;取不到令牌 = 走今日 generic 路径。
 */
export function extractGhostCardId(toolResult: string): string | null {
  if (!toolResult || typeof toolResult !== 'string') return null;
  if (!toolResult.includes('xdt_card_id')) return null;
  try {
    const parsed = JSON.parse(toolResult) as { xdt_card_id?: unknown };
    return typeof parsed.xdt_card_id === 'string' && parsed.xdt_card_id.length > 0
      ? parsed.xdt_card_id
      : null;
  } catch {
    return null;
  }
}

/**
 * 从 ghost_call 的 tool_result JSON 里提取媒体回锚令牌:顶层 xdt_anchor_card_id
 * (意识自己填,值 = 此前开卡调用的管子 callId)。用于"提交开卡 → 轮询出媒体"
 * 的跨调用任务:轮询结果的媒体据此挂回提交卡正下方(替换"生成中"占位),
 * 而不是渲染在轮询调用的位置。MessageStream 只在锚到**同一意识**已上屏的卡时
 * 采纳,锚不上回退本调用位置渲染(老意识/坏锚零影响)。
 */
export function extractAnchorCardId(toolResult: string): string | null {
  if (!toolResult || typeof toolResult !== 'string') return null;
  if (!toolResult.includes('xdt_anchor_card_id')) return null;
  try {
    const parsed = JSON.parse(toolResult) as { xdt_anchor_card_id?: unknown };
    return typeof parsed.xdt_anchor_card_id === 'string' && parsed.xdt_anchor_card_id.length > 0
      ? parsed.xdt_anchor_card_id
      : null;
  } catch {
    return null;
  }
}

export function extractToolResultMedia(toolResult: string): ToolMediaItem[] {
  if (!toolResult || typeof toolResult !== 'string') return [];
  // 快速否定:不含任何 xdt_*_url 字面量直接 short-circuit。
  if (
    !toolResult.includes('xdt_image_url') &&
    !toolResult.includes('xdt_video_url') &&
    !toolResult.includes('xdt_audio_url')
  ) {
    return [];
  }
  try {
    const parsed = JSON.parse(toolResult) as {
      xdt_image_url?: unknown;
      xdt_image_urls?: unknown;
      xdt_video_url?: unknown;
      xdt_video_urls?: unknown;
      xdt_audio_urls?: unknown;
      xdt_audio_tracks?: unknown;
      xdt_audio_in_card?: unknown;
      xdt_images_in_card?: unknown;
      _xdt_render_image?: unknown;
      _xdt_model_files?: unknown;
      _xdt_audio_tracks?: unknown;
    };
    if (parsed._xdt_render_image === false) return [];
    const modelFiles = parseModelFiles(parsed._xdt_model_files);
    // Track which image index we're at across xdt_image_url + xdt_image_urls
    // so positional pairing with modelFiles works for both shapes.
    let imageIdx = 0;
    const nextModelFile = (): ToolMediaModelFile | undefined => {
      const m = modelFiles[imageIdx];
      imageIdx += 1;
      return m;
    };
    const items: ToolMediaItem[] = [];
    // 图片入卡令牌(xdt_images_in_card):与音频令牌同款「待验证声明」——
    // 提取层只打标不裁决,压不压基座由 MessageStream 验证锚卡真含对应图片
    // 后决定(验证不过照常渲染,图片永不消失)。手机端提取器不认该令牌。
    const imagesInCard = parsed.xdt_images_in_card === true;
    if (
      typeof parsed.xdt_image_url === 'string' &&
      isToolImageUrl(parsed.xdt_image_url)
    ) {
      const modelFile = nextModelFile();
      items.push({
        kind: 'image',
        url: parsed.xdt_image_url,
        ...(modelFile ? { modelFile } : {}),
        ...(imagesInCard ? { imageInCard: true } : {}),
      });
    }
    if (Array.isArray(parsed.xdt_image_urls)) {
      for (const u of parsed.xdt_image_urls) {
        if (typeof u === 'string' && isToolImageUrl(u)) {
          const modelFile = nextModelFile();
          items.push({
            kind: 'image',
            url: u,
            ...(modelFile ? { modelFile } : {}),
            ...(imagesInCard ? { imageInCard: true } : {}),
          });
        }
      }
    }
    // 协议白名单与图卡同款双世界:老 xdt-video://(遗产只读)+ 新
    // cindy-media://(意识 gen_video 等新链路产物)。
    if (
      typeof parsed.xdt_video_url === 'string' &&
      isToolVideoUrl(parsed.xdt_video_url)
    ) {
      items.push({
        kind: 'video',
        url: parsed.xdt_video_url,
      });
    }
    if (Array.isArray(parsed.xdt_video_urls)) {
      for (const u of parsed.xdt_video_urls) {
        if (typeof u === 'string' && isToolVideoUrl(u)) {
          items.push({
            kind: 'video',
            url: u,
          });
        }
      }
    }
    // Audio: mivo Suno music. Track metadata (cover, title, tags, lyrics,
    // duration) rides on `xdt_audio_tracks` (ghost 世界,cindy-tools hoist 上提)
    // 或老字段 `_xdt_audio_tracks`(退役 lizi_mivo MCP 的历史消息);
    // `xdt_audio_urls` is a parallel quick-lookup array — we drive items off
    // the tracks since ChatAudioCard needs the metadata anyway. Tracks-less
    // entries (defensive: server somehow shipped xdt_audio_urls but no tracks)
    // fall back to a bare audio item with empty metadata so playback works.
    // 音频入卡令牌(xdt_audio_in_card):只打标不裁决——提取层是纯函数拿不到
    // 卡片上下文,压不压基座由 MessageStream 验证"锚到的同意识卡真含对应
    // data-ghost-audio 插槽"后决定(验证不过照常渲染,音频永不消失)。手机端
    // 提取器(payloadSummary)不认该令牌:手机没有卡片体系,基座是唯一出口。
    const audioInCard = parsed.xdt_audio_in_card === true;
    const audioTracks = parseAudioTracks(parsed.xdt_audio_tracks ?? parsed._xdt_audio_tracks);
    if (audioTracks.length > 0) {
      for (const t of audioTracks) {
        items.push({
          kind: 'audio',
          url: t.audioUrl,
          audioTrack: t,
          ...(audioInCard ? { audioInCard: true } : {}),
        });
      }
    } else if (Array.isArray(parsed.xdt_audio_urls)) {
      for (const u of parsed.xdt_audio_urls) {
        if (typeof u === 'string' && isToolAudioUrl(u)) {
          items.push({
            kind: 'audio',
            url: u,
            ...(audioInCard ? { audioInCard: true } : {}),
            audioTrack: {
              kind: 'music',
              audioUrl: u,
              title: '',
              tags: '',
              lyrics: '',
              durationSeconds: 0,
            },
          });
        }
      }
    }
    // De-dup by url, preserve insertion order.
    const seen = new Set<string>();
    return items.filter((it) => {
      if (seen.has(it.url)) return false;
      seen.add(it.url);
      return true;
    });
  } catch {
    // 不是合法 JSON → 不渲染媒体(text 摘要照常显示)
  }
  return [];
}

/**
 * 旧接口的兼容包装。新代码请用 `extractToolResultMedia`。
 * 保留是因为 IM 路径 / streamingText 等地方也读这个名字。
 */
export function extractToolResultImageUrls(toolResult: string): string[] {
  return extractToolResultMedia(toolResult)
    .filter((m) => m.kind === 'image')
    .map((m) => m.url);
}

function commandDisplayText(inp: Record<string, unknown>): string {
  if (typeof inp.displayCommand === 'string') return inp.displayCommand;
  if (typeof inp.command !== 'string') return '';
  return normalizeDisplayCommand(inp.command) ?? inp.command;
}

function formatInlineInput(
  toolName: string,
  inp: Record<string, unknown> | null,
): string {
  if (!inp) return '';
  switch (toolName) {
    case 'Bash':
    case 'bash':
    case 'exec': {
      // description 已上移为行主文案(issue #450),这里只展示命令原文 + cwd,
      // 避免同一句话在折叠行和展开区重复出现。
      const cmd = commandDisplayText(inp);
      const cwd = typeof inp.cwd === 'string' && inp.cwd ? `cwd: ${inp.cwd}` : '';
      return cwd ? `${cmd}\n${cwd}` : cmd;
    }
    case 'Grep':
    case 'grep': {
      const pattern = typeof inp.pattern === 'string' ? inp.pattern : '';
      const path = typeof inp.path === 'string' ? inp.path : '';
      const glob = typeof inp.glob === 'string' ? inp.glob : '';
      const type = typeof inp.type === 'string' ? inp.type : '';
      const output_mode = typeof inp.output_mode === 'string' ? inp.output_mode : '';
      return [
        `pattern: ${pattern}`,
        path && `path: ${path}`,
        glob && `glob: ${glob}`,
        type && `type: ${type}`,
        output_mode && `output_mode: ${output_mode}`,
      ]
        .filter(Boolean)
        .join('\n');
    }
    case 'Glob':
    case 'find': {
      const pattern = typeof inp.pattern === 'string' ? inp.pattern : '';
      const path = typeof inp.path === 'string' ? inp.path : '';
      return path ? `${pattern}\nin: ${path}` : pattern;
    }
    case 'ls': {
      // pi ls:path 可缺省(默认当前目录)。
      const path = typeof inp.path === 'string' ? inp.path : '';
      return path;
    }
    case 'WebFetch': {
      const url = typeof inp.url === 'string' ? inp.url : '';
      const prompt = typeof inp.prompt === 'string' ? inp.prompt : '';
      return prompt ? `${url}\n---\n${prompt}` : url;
    }
    case 'WebSearch': {
      const query = typeof inp.query === 'string' ? inp.query : '';
      return query;
    }
    default:
      try {
        return JSON.stringify(inp, null, 2);
      } catch {
        return String(inp);
      }
  }
}

type FileChangeDescriptor = Extract<ToolUseDescriptor, { kind: 'fileChange' }>;

/**
 * Normalize Claude Edit/Write/MultiEdit and Codex file_change into the same
 * file-oriented lightbox payload. The outer interaction and presentation stay
 * provider-agnostic; only the diff source differs (old/new strings vs unified
 * diff text).
 */
function buildDiffPayload(
  descriptor: ToolUseDescriptor,
  inp: Record<string, unknown> | null,
): ToolPayloadMode | null {
  if (descriptor.kind === 'fileChange') {
    return {
      kind: 'diff',
      files: descriptor.changes.map((change, index) => ({
        key: `${change.path}:${change.movePath ?? ''}:${index}`,
        filePath: change.movePath ?? change.path,
        diffs: change.diff.trim() ? [{ key: `file-change:${index}`, rawDiff: change.diff }] : [],
      })),
    };
  }
  if (descriptor.kind !== 'file' || descriptor.action === 'read' || !inp) return null;

  const { filePath, toolName } = descriptor;
  if (toolName === 'Edit') {
    const o = typeof inp.old_string === 'string' ? inp.old_string : '';
    const n = typeof inp.new_string === 'string' ? inp.new_string : '';
    return {
      kind: 'diff',
      files: [
        {
          key: filePath,
          filePath,
          diffs: [{ key: 'edit:0', oldString: o, newString: n }],
        },
      ],
    };
  }
  if (toolName === 'Write' || toolName === 'write') {
    const c = typeof inp.content === 'string' ? inp.content : '';
    return {
      kind: 'diff',
      files: [
        {
          key: filePath,
          filePath,
          diffs: [{ key: 'write:0', oldString: '', newString: c }],
        },
      ],
    };
  }
  // pi edit:声明 schema 的 edits[] 与 legacy 顶层 {oldText,newText} 两种形态,
  // 由共享的 piEditReplacements 归一化(只认一种会让另一种退化成空 diff)。
  if (toolName === 'edit') {
    return {
      kind: 'diff',
      files: [
        {
          key: filePath,
          filePath,
          diffs: piEditReplacements(inp).map((edit, index) => ({
            key: `edit:${index}`,
            oldString: edit.oldText,
            newString: edit.newText,
          })),
        },
      ],
    };
  }
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(inp.edits) ? inp.edits : [];
    return {
      kind: 'diff',
      files: [
        {
          key: filePath,
          filePath,
          diffs: edits.map((e, index) => {
            const er = e as Record<string, unknown> | null;
            const o = er && typeof er.old_string === 'string' ? er.old_string : '';
            const n = er && typeof er.new_string === 'string' ? er.new_string : '';
            return { key: `edit:${index}`, oldString: String(o), newString: String(n) };
          }),
        },
      ],
    };
  }
  return null;
}

export interface AgentActionRowProps {
  message: ChatMessage;
  toolResult?: string;
  /** 工作过程展开 / live preview 使用：仅无法识别的命令另显原文兜底。 */
  showRawCommand?: boolean;
  /** Codex 一个 commandExecution 拆出的结构化展示子动作。 */
  intentOverride?: CommandIntent;
  /**
   * 行级执行状态(issue #450)— 由 AgentActionsBlock 依据 result / settled /
   * isSessionStreaming 计算后传入;缺省按已完成渲染(历史消息路径)。
   */
  status?: 'running' | 'done';
}

type LightboxState =
  | { kind: 'none' }
  | { kind: 'file'; path: string; name: string }
  | { kind: 'image'; src: string }
  | { kind: 'payload'; payload: ToolPayloadMode };

function fileChangeVerbKey(descriptor: FileChangeDescriptor): string {
  if (descriptor.changes.length !== 1) return 'chat.agentActionRow.verb.updated';
  switch (descriptor.changes[0].action) {
    case 'add':
      return 'chat.agentActionRow.verb.created';
    case 'delete':
      return 'chat.agentActionRow.fileChange.deleted';
    case 'move':
      return 'chat.agentActionRow.fileChange.renamed';
    case 'update':
      return 'chat.agentActionRow.verb.edited';
    default:
      return 'chat.agentActionRow.verb.updated';
  }
}

/** True when the file extension is one ImageLightbox can render via xdt-file://. */
function isImagePath(filePath: string): boolean {
  const ext = extractExt(filePath).toLowerCase();
  return ext !== '' && SUPPORTED_IMAGE_EXTS.has(ext);
}

export function AgentActionRow({
  message,
  toolResult,
  showRawCommand = false,
  intentOverride,
  status = 'done',
}: AgentActionRowProps) {
  const { t } = useTranslation();
  // 会话文件来源:remote 时 Read 图片走远程媒体改写、文件打开走远程分流。
  const fileCtx = useChatSessionFile();
  const toolName = message.toolName ?? '';
  const inp = (message.toolInput as Record<string, unknown> | null) ?? null;

  // 意识召唤行(ghost_call):以意识身份渲染(「名字」· 工具名),
  // 两条触发路径($硬指令 / 花名册语义召回)在**调用点**获得统一可视化
  // ——语义召回时用户消息上没有任何标记,这里是唯一的看见处。
  const installedGhosts = useInstalledGhosts();
  const ghostInfo = useMemo(() => {
    if (!isGhostCallToolName(toolName) || !inp) return null;
    const gid = typeof inp.ghost_id === 'string' ? inp.ghost_id : '';
    const hit = installedGhosts.find((g) => g.manifest.id === gid);
    return {
      name: hit?.manifest.name ?? (gid || 'ghost'),
      tool: typeof inp.tool === 'string' ? inp.tool : '',
    };
  }, [toolName, inp, installedGhosts]);

  const descriptor = useMemo(() => {
    const resolved = describeToolUse(toolName, inp);
    if (!intentOverride || resolved.kind !== 'command' || resolved.description) return resolved;
    return { ...resolved, intent: intentOverride };
  }, [toolName, inp, intentOverride]);
  const isFileChange = descriptor.kind === 'fileChange';
  // command 类带模型 description 时,description 自含动词语义("查看工作区
  // 状态"),再渲染英文动词 label 会变成"Ran 查看工作区状态"的中英混排 —
  // 隐藏动词,让 description 独立成句(Claude App 同款形态)。
  const hideVerb = descriptor.kind === 'command' && !!descriptor.description;
  // command intent(codex commandActions / 本地规则解析)命中时,动词换成意图
  // 动词("读取"/"运行测试"),否则走工具名静态映射。description 存在时 intent
  // 不参与(hideVerb 已隐藏动词)。
  const intentAction =
    descriptor.kind === 'command' && !descriptor.description
      ? descriptor.intent?.action
      : undefined;
  const isRawCommandFallback =
    descriptor.kind === 'command' && !descriptor.description && !descriptor.intent && showRawCommand;
  const verbLabel = t(
    intentAction
      ? verbLabelKeyForIntent(intentAction)
      : isRawCommandFallback
        ? 'chat.agentActionRow.verb.ranCommand'
        : isFileChange
          ? fileChangeVerbKey(descriptor)
          : verbLabelKeyForRow(verbForTool(toolName)),
  );
  // 意识行动词固定"召唤意识"(与其它工具的 Ran/Read 语系并列)。
  const rowVerbLabel = ghostInfo ? t('chat.ghostCall.verb') : verbLabel;
  const displayParam = useMemo(
    () => extractDisplayParam(descriptor, { hideRawCommandFallback: showRawCommand }),
    [descriptor, showRawCommand],
  );
  const fileChangeCountText = isFileChange && descriptor.changes.length > 1
    ? t('chat.agentActionRow.fileChange.files', { count: descriptor.changes.length })
    : null;
  const rawCommand =
    showRawCommand &&
    descriptor.kind === 'command' &&
    !descriptor.description &&
    !descriptor.intent &&
    descriptor.command
      ? descriptor.command
      : null;
  const stats = useMemo(
    () => statsForToolCall(toolName, inp),
    [toolName, inp],
  );
  const isFilePathTool = FILE_PATH_TOOLS.has(toolName);
  const filePath = descriptor.kind === 'file' ? descriptor.filePath : '';
  const singleFileChange =
    isFileChange && descriptor.changes.length === 1 ? descriptor.changes[0] : null;
  const chipFilePath = filePath || singleFileChange?.movePath || singleFileChange?.path || '';
  // v10:命令类工具走就地展开；Claude/Codex 文件编辑统一走 diff lightbox。
  const isInlineExpand = !isFilePathTool && !isFileChange;

  const [lightbox, setLightbox] = useState<LightboxState>({ kind: 'none' });
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const fileChipRef = useRef<HTMLSpanElement | null>(null);

  /**
   * 行/chevron 激活时的分流:
   *   - 命令类(isInlineExpand) → toggle 就地展开,绝不开 lightbox
   *   - Claude/Codex 文件编辑 → 同一个 diff lightbox
   *   - Read → 文稿/图片 lightbox
   */
  const onActivate = async (anchor: HTMLElement) => {
    const diffPayload = buildDiffPayload(descriptor, inp);
    if (diffPayload) {
      triggerRef.current = anchor;
      setLightbox({ kind: 'payload', payload: diffPayload });
      return;
    }
    if (isInlineExpand) {
      setExpanded((prev) => !prev);
      return;
    }
    triggerRef.current = anchor;
    if ((toolName === 'Read' || toolName === 'read') && filePath) {
      // 模型可能给相对路径(runtime 按会话工作目录解析后 Read 照样成功),而
      // 预览 / 定位 IPC 一律要求绝对路径 —— 先按 workingDir 补齐,镜像 runtime
      // 语义,保证 chip 打开的就是 agent 实际读到的那个文件。
      const absPath = resolveToolFilePath(filePath, fileCtx.workingDir);
      // 按扩展名分流:图片 → ImageLightbox(xdt-file:// 协议直接渲染),
      // 其他 → TextLightbox(文稿浏览器)。镜像 MarkdownRenderer / UserMessage
      // 里 image-local vs text-local 的同款决策(见 localPathResolver.classifyMarkdownHref)。
      if (isImagePath(absPath)) {
        // remote 会话:xdt-file://?path= 经 origin 改写走远程媒体管线(device 全量 /
        // ssh 限 workdir 内);本地 no-op。
        setLightbox({
          kind: 'image',
          src: rewriteToRemoteMediaOrigin(
            toLocalFileUrl(absPath),
            toRemoteMediaOrigin(fileCtx.origin, fileCtx.workingDir),
          ),
        });
      } else {
        if (!(await shouldOpenTextLightboxForOrigin(fileCtx, absPath))) return;
        setLightbox({ kind: 'file', path: absPath, name: basename(absPath) });
      }
      return;
    }
    // 兜底:文件类工具但拿不到 file_path 时,降级走就地展开 — 不再无意义
    // 地把 JSON 塞进全屏 lightbox。
    setExpanded((prev) => !prev);
  };

  const closeLightbox = () => setLightbox({ kind: 'none' });

  // 就地展开时要展示的 input 文本(已按 tool 名做了人类可读的格式化)。
  const inlineInputText = useMemo(
    () => (isInlineExpand ? formatInlineInput(toolName, inp) : ''),
    [isInlineExpand, toolName, inp],
  );

  // v12: 文件 chip 右键菜单 (复制 / 复制文件路径 / 打开文件所在目录)。
  // Claude 取 file_path，Codex 单文件 change 取目标路径 —— 模型可能给相对
  // 路径(见 onActivate 注释),菜单动作统一经 resolveToolFilePath 补成绝对路径。
  const fileChipMenu = useFileChipContextMenu({
    getAbsPath: () => resolveToolFilePath(chipFilePath, fileCtx.workingDir),
    canOpenInBrowser: isBrowserOpenablePath(chipFilePath),
  });

  // ── Display-param cell variants ──────────────────────────────────────────
  // Claude Edit/Write/MultiEdit/Read + Codex 单文件 file_change → real chip.
  // Other tools → plain neutral text inline; row/chevron click toggles inline
  //   details.
  // v6: chip 本体不再 hover tooltip — 文件名已在 chip 上显示，点击又能开
  //   lightbox 看完整内容，重复 tooltip 是噪音。
  const displayCell = (() => {
    // 意识召唤行:「名字」· 工具名。不放头像——16px 下什么都看不清只添噪,
    // 身份视觉(头像/印记)由结果位的意识卡片头部承担(2026-07-12 Lizi 定案)。
    if (ghostInfo) {
      return (
        <span className="truncate text-14 font-medium text-[var(--msg-tool-card-chevron)]">
          「{ghostInfo.name}」· {ghostInfo.tool}
        </span>
      );
    }
    if (fileChangeCountText) {
      return (
        <span className="min-w-0 truncate text-14 font-medium text-[var(--msg-tool-card-chevron)]">
          {fileChangeCountText}
        </span>
      );
    }
    if (!displayParam) return null;
    if (chipFilePath) {
      return (
        <span
          ref={fileChipRef}
          data-agent-action-file-chip="true"
          className={cn(
            'inline-flex items-center gap-[3px] px-[5px] py-[0.5px]',
            'rounded-[4px] border',
            'bg-[var(--chat-input-chip-bg)]',
            'border-[var(--chat-input-chip-border)]',
            'text-[var(--chat-input-chip-text)]',
            'font-mono text-13 leading-[1.385] whitespace-nowrap',
            'cursor-pointer transition-colors',
            'group-hover:bg-[var(--cmd-palette-item-hover)]',
            'min-w-0 max-w-full',
          )}
        >
          <FileIcon size={12} className="shrink-0 text-[var(--chat-input-chip-icon)]" />
          <span className="truncate">{displayParam.text}</span>
        </span>
      );
    }
    return (
      <span
        className="text-14 font-medium text-[var(--msg-tool-card-chevron)] truncate min-w-0 cursor-pointer"
        title={displayParam.fullTitle}
      >
        {displayParam.text}
      </span>
    );
  })();

  const onRowContextMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!chipFilePath) return;
    if (!(e.target instanceof Element)) return;
    if (!e.target.closest('[data-agent-action-file-chip="true"]')) return;
    fileChipMenu.onContextMenu(e);
  };

  const onRowKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!chipFilePath) return;
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    e.preventDefault();
    e.stopPropagation();
    const chipRect = fileChipRef.current?.getBoundingClientRect();
    const rowRect = e.currentTarget.getBoundingClientRect();
    const rect = chipRect ?? rowRect;
    fileChipMenu.openAt(rect.left, rect.bottom + 2);
  };

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={(e) => void onActivate(e.currentTarget)}
        onContextMenu={onRowContextMenu}
        onKeyDown={onRowKeyDown}
        aria-expanded={isInlineExpand ? expanded : undefined}
        aria-label={
          ghostInfo
            ? `${rowVerbLabel} ${ghostInfo.name} ${ghostInfo.tool}`
            : displayParam || fileChangeCountText
              ? hideVerb
                ? displayParam?.text ?? fileChangeCountText ?? ''
                : `${rowVerbLabel} ${displayParam?.text ?? fileChangeCountText ?? ''}`
              : rowVerbLabel
        }
        className={cn(
          'group flex w-full items-center gap-[6px]',
          'rounded-[6px] px-2 py-[3px]',
          'hover:bg-[var(--msg-code-inline-bg)] transition-colors',
          'cursor-pointer select-none outline-none',
          'focus-visible:ring-2 focus-visible:ring-[var(--info-700)]/40',
          'text-left',
        )}
      >
        {/* 状态图标(issue #450):固定 16px 槽位,所有行统一对齐。running→done
            只在同槽位内换图标,零布局位移(规则 7 视觉连续性)。灰色方案对齐
            AgentTaskCard 先例 — Thinking Orange 仅限 Running Status Bar。 */}
        <span
          role="img"
          aria-label={
            status === 'running'
              ? t('chat.agentActionRow.status.running')
              : t('chat.agentActionRow.status.done')
          }
          className="inline-flex h-[18px] w-4 items-center justify-center shrink-0 text-[var(--msg-tool-card-chevron)]"
        >
          {status === 'running' ? (
            <Spinner size={13} />
          ) : (
            <Check size={13} />
          )}
        </span>
        {!hideVerb && (
          <span className="text-14 text-[var(--msg-tool-card-chevron)] shrink-0">
            {rowVerbLabel}
          </span>
        )}
        {displayCell}
        <span className="flex-1" />
        {stats && (
          <span className="font-mono text-13 font-medium shrink-0 flex gap-1">
            <span className="text-[var(--diff-add-fg)]">+{stats.add}</span>
            <span className="text-[var(--diff-del-fg)]">-{stats.del}</span>
          </span>
        )}
        {/* v9: 移除 chevron 上的"查看详情" Tooltip。整行 button 已经是
            统一激活目标，末尾 chevron 只保留视觉提示。 */}
        <span
          aria-hidden="true"
          className={cn(
            'flex h-[18px] w-[18px] items-center justify-center rounded-[4px] shrink-0',
            'text-[var(--msg-tool-card-chevron)]',
            'group-hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
          )}
        >
          {isInlineExpand && expanded ? (
            <ChevronDown size={13} />
          ) : (
            <ChevronRight size={13} />
          )}
        </span>
      </button>
      {rawCommand && !expanded && (
        <div
          data-agent-action-raw-command="true"
          title={rawCommand}
          className="min-w-0 truncate px-2 pb-[3px] pl-[30px] font-mono text-12 leading-[1.5] text-[var(--msg-tool-card-chevron)]"
        >
          {rawCommand}
        </div>
      )}
      {chipFilePath ? fileChipMenu.menu : null}

      {/* v10 就地展开内容:命令类工具(Bash/Grep/Glob/WebFetch/WebSearch/...)
          点击行/chevron 后展示 input + tool_result。Claude/Codex 文件编辑
          共用 diff lightbox,这里不渲染。布局:cornerRadius 6, padding [8,10], 字号 13/mono。
          v11 (2026-04-20):背景色 + 边框对齐"用户输入气泡"
          (`--msg-user-bg` + `--msg-user-border`),与 hover 嵌入式 inline-code
          灰区分开,把就地展开视觉上提升为一个独立"卡片"。 */}
      {isInlineExpand && expanded && (
        <div
          // 行按钮本身是 select-none,这里必须显式 select-text,让用户能复制
          // grep pattern、bash command 这种关键文本。
          className={cn(
            'mx-2 mt-1 mb-1 rounded-[6px] px-[10px] py-2',
            'bg-[var(--msg-user-bg)]',
            'border border-[var(--msg-user-border)]',
            'font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[calc(var(--app-code-font-size)_+_4px)]',
            'text-[var(--foreground)]',
            'select-text cursor-text',
          )}
        >
          {inlineInputText && (
            <pre className="whitespace-pre-wrap break-words m-0">
              {inlineInputText}
            </pre>
          )}
          {toolResult && (
            <>
              {inlineInputText && (
                <div className="my-2 h-px bg-[var(--msg-tool-card-chevron)]/20" />
              )}
              <pre className="whitespace-pre-wrap break-words m-0 text-[var(--msg-tool-card-chevron)]">
                {toolResult}
              </pre>
            </>
          )}
          {!inlineInputText && !toolResult && (
            <span className="text-[var(--msg-tool-card-chevron)]">{t('chat.agentActionRow.noContent')}</span>
          )}
        </div>
      )}

      {/*
        tool 返回 JSON 里若带 xdt_image_url(单张) / xdt_image_urls(多张)的图片,
        不在这里渲染——MessageStream Pass 2 会把它们提取出来作为独立的
        'tool_image' RenderItem,渲染在 tool_segment 卡片之后,跳出折叠态,
        作为聊天流里独立的视觉消息。这样图片生成工具(lizi_art)的产物,以及
        飞书拉图,都能被用户一眼看到,而不是埋在 tool_segment 折叠卡里。
      */}

      {lightbox.kind === 'file' && (
        <TextLightbox
          filePath={lightbox.path}
          fileName={lightbox.name}
          triggerRef={triggerRef}
          onClose={closeLightbox}
        />
      )}
      {lightbox.kind === 'image' && (
        <ImageLightbox src={lightbox.src} onClose={closeLightbox} />
      )}
      {lightbox.kind === 'payload' && (
        <ToolPayloadLightbox
          payload={lightbox.payload}
          triggerRef={triggerRef}
          onClose={closeLightbox}
        />
      )}
    </div>
  );
}
