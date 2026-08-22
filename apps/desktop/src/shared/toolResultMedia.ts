/**
 * shared/toolResultMedia.ts —— 「工具结果里哪些字段装着媒体」这一份真相。
 *
 * ## 为什么要抽出来
 *
 * 伙伴做出来的图片和视频**不是文件写入**:它们从工具结果的 `xdt_image_urls` /
 * `xdt_video_urls` 里回来,落在 `tool_result` 消息的正文里。这份判定原来只存在于
 * renderer(AgentActionRow),于是主进程侧的作品集投影根本够不着 —— 结果就是
 * 「对话里图好好地显示着,作品集里一张都没有」。
 *
 * 抽出来之后两边共用同一份键名与协议判定:renderer 继续在它上面叠自己的卡片
 * 锚定、模型文件配对等展示逻辑,主进程只取 URL。**再有新的媒体字段,只改这里。**
 *
 * 本文件是纯数据 + 纯函数,不 import 任何 Electron / React,两侧都能用。
 */

/** 媒体类别。音频没有独立的作品卡,但同样是伙伴做出来的东西,一并认出来。 */
export type ToolResultMediaKind = 'image' | 'video' | 'audio';

/**
 * 取件协议。
 *
 * `xdt-*://` 是各媒体域的历史地址(只读);`cindy-media://` 是内容寻址的媒体总仓,
 * **它本身不区分图/视频/音频** —— 到底是什么由它出现在哪个字段里决定。所以下面
 * 每种 kind 的判定都是「自己的历史 scheme」或「媒体总仓」。
 */
export function isToolImageUrl(url: string): boolean {
  return url.startsWith('xdt-image://') || url.startsWith('cindy-media://');
}

export function isToolVideoUrl(url: string): boolean {
  return url.startsWith('xdt-video://') || url.startsWith('cindy-media://');
}

export function isToolAudioUrl(url: string): boolean {
  return url.startsWith('xdt-audio://') || url.startsWith('cindy-media://');
}

/**
 * 每种媒体的承载字段:单个 + 复数两种形态都要收。
 *
 * 顺序有意义:先单后复,与 renderer 的提取顺序一致,同一条结果在两侧得到的
 * URL 次序相同(去重口径才对得上)。
 */
export const TOOL_RESULT_MEDIA_FIELDS: Readonly<
  Record<ToolResultMediaKind, readonly string[]>
> = {
  image: ['xdt_image_url', 'xdt_image_urls'],
  video: ['xdt_video_url', 'xdt_video_urls'],
  audio: ['xdt_audio_url', 'xdt_audio_urls'],
};

const ACCEPTS: Readonly<Record<ToolResultMediaKind, (url: string) => boolean>> = {
  image: isToolImageUrl,
  video: isToolVideoUrl,
  audio: isToolAudioUrl,
};

/**
 * 快速否定用的字面量。整段结果文本里连这些子串都没有,就不必 JSON.parse ——
 * 工具结果动辄几十 KB,而带媒体的是少数。
 */
export const TOOL_RESULT_MEDIA_HINTS: readonly string[] = [
  'xdt_image_url',
  'xdt_video_url',
  'xdt_audio_url',
];

export interface ToolResultMediaUrl {
  url: string;
  kind: ToolResultMediaKind;
}

/**
 * 从已解析的工具结果对象里取出媒体地址。
 *
 * `_xdt_render_image === false` 是「这次别当媒体渲染」的显式声明(某些工具用它
 * 回传地址但不想上屏),照样跳过 —— 不上屏的东西也不该进作品集。
 *
 * 同一个地址在多个字段里重复出现时只保留第一次,并按**首次出现的 kind** 归类:
 * `cindy-media://` 可能同时通过图与视频两个判定,先到者说了算。
 */
export function extractToolResultMediaUrls(
  parsed: Record<string, unknown> | null | undefined,
): ToolResultMediaUrl[] {
  if (!parsed || typeof parsed !== 'object') return [];
  if ((parsed as { _xdt_render_image?: unknown })._xdt_render_image === false) return [];
  const out: ToolResultMediaUrl[] = [];
  const seen = new Set<string>();
  for (const kind of ['image', 'video', 'audio'] as const) {
    for (const field of TOOL_RESULT_MEDIA_FIELDS[kind]) {
      const raw = parsed[field];
      const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
      for (const value of values) {
        if (typeof value !== 'string') continue;
        const url = value.trim();
        if (!url || seen.has(url)) continue;
        if (!ACCEPTS[kind](url)) continue;
        seen.add(url);
        out.push({ url, kind });
      }
    }
  }
  return out;
}

/** 结果文本里可能有媒体吗。用于在 JSON.parse 之前短路。 */
export function toolResultMayHaveMedia(text: string): boolean {
  return TOOL_RESULT_MEDIA_HINTS.some((hint) => text.includes(hint));
}
