/**
 * feishu/incomingContent.ts
 * ---------------------------------------------------------------------------
 * 解析飞书 im.message.receive_v1 事件的 message.content（JSON 字符串），
 * 把不同 msg_type 统一成 `{ text, attachments, unsupported }`。
 *
 * 路由器只关心三件事：
 *   - text         有没有文本（拼进 prompt）
 *   - attachments  有没有可下载的资源（image_key / file_key）
 *   - unsupported  有没有用户**显式**发了但模型一定处理不了的（音频/视频）
 *
 * 设计取舍：
 *   1. 解析阶段**不**判断附件文件能否进模型——那需要扩展名判断 + 下载后落盘
 *      路径，是 attachmentDownloader 的事。这里 audio/media 这种"消息类型本身
 *      就是音视频"才直接进 unsupported。
 *   2. sticker/location 这种用户大概率是**误发**或仅为表达情绪 → silently drop。
 *   3. post（富文本）按"扁平化"处理。
 */

export type AttachmentRef =
  | { kind: 'image'; imageKey: string }
  | { kind: 'file'; fileKey: string; fileName: string; fileSize?: number };

export interface UnsupportedEntry {
  type: string;
  label: string;
}

export interface ParsedIncoming {
  text: string;
  attachments: AttachmentRef[];
  unsupported: UnsupportedEntry[];
}

const EMPTY_RESULT: ParsedIncoming = {
  text: '',
  attachments: [],
  unsupported: [],
};

export function parseIncoming(
  msgType: string,
  rawContent: string,
): ParsedIncoming {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return EMPTY_RESULT;
  }
  if (!parsed || typeof parsed !== 'object') return EMPTY_RESULT;
  const c = parsed as Record<string, unknown>;

  switch (msgType) {
    case 'text': {
      const text = typeof c.text === 'string' ? c.text.trim() : '';
      return { text, attachments: [], unsupported: [] };
    }
    case 'image': {
      const imageKey = typeof c.image_key === 'string' ? c.image_key : '';
      if (!imageKey) return EMPTY_RESULT;
      return {
        text: '',
        attachments: [{ kind: 'image', imageKey }],
        unsupported: [],
      };
    }
    case 'file': {
      const fileKey = typeof c.file_key === 'string' ? c.file_key : '';
      const fileName = typeof c.file_name === 'string' ? c.file_name : '';
      if (!fileKey) return EMPTY_RESULT;
      let fileSize: number | undefined;
      if (typeof c.file_size === 'number') fileSize = c.file_size;
      else if (typeof c.file_size === 'string') {
        const n = Number(c.file_size);
        if (Number.isFinite(n)) fileSize = n;
      }
      return {
        text: '',
        attachments: [
          { kind: 'file', fileKey, fileName: fileName || fileKey, fileSize },
        ],
        unsupported: [],
      };
    }
    case 'audio': {
      return {
        text: '',
        attachments: [],
        unsupported: [{ type: 'audio', label: '语音消息' }],
      };
    }
    case 'media': {
      const fileName =
        typeof c.file_name === 'string' ? c.file_name : '视频';
      return {
        text: '',
        attachments: [],
        unsupported: [{ type: 'media', label: `视频文件 ${fileName}` }],
      };
    }
    case 'post': {
      return parsePost(c);
    }
    case 'sticker':
    case 'location':
    case 'share_chat':
    case 'share_user':
    case 'system':
    case 'merge_forward': {
      return EMPTY_RESULT;
    }
    case 'card':
    case 'interactive': {
      return parseInteractive(c);
    }
    default: {
      return {
        text: '',
        attachments: [],
        unsupported: [{ type: msgType, label: `未知类型 ${msgType}` }],
      };
    }
  }
}

function parsePost(c: Record<string, unknown>): ParsedIncoming {
  const title = typeof c.title === 'string' ? c.title.trim() : '';
  const lines: string[] = [];
  const attachments: AttachmentRef[] = [];
  const unsupported: UnsupportedEntry[] = [];

  if (title) lines.push(title);

  const content = Array.isArray(c.content) ? c.content : [];
  for (const para of content) {
    if (!Array.isArray(para)) continue;
    const lineParts: string[] = [];
    for (const node of para) {
      if (!node || typeof node !== 'object') continue;
      const n = node as Record<string, unknown>;
      const tag = typeof n.tag === 'string' ? n.tag : '';
      const text = typeof n.text === 'string' ? n.text : '';
      switch (tag) {
        case 'text':
        case 'md':
        case 'a':
        case 'code_inline':
        case 'code_block':
          if (text) lineParts.push(text);
          break;
        case 'img': {
          const imageKey = typeof n.image_key === 'string' ? n.image_key : '';
          if (imageKey) attachments.push({ kind: 'image', imageKey });
          break;
        }
        case 'media': {
          const fileName =
            typeof n.file_name === 'string' ? n.file_name : '视频';
          unsupported.push({
            type: 'post.media',
            label: `视频文件 ${fileName}`,
          });
          break;
        }
        default:
          break;
      }
    }
    if (lineParts.length > 0) lines.push(lineParts.join(''));
  }

  return {
    text: lines.join('\n').trim(),
    attachments,
    unsupported,
  };
}

/**
 * Bot 答案走 interactive 卡片(v2 markdown / v1 lark_md)。引用回复需要把卡片
 * 正文抽出来,抽不出(模板卡等)就留空,让 resolveReplyMessage 返回 null 走群历史。
 * 卡片图只当上下文标记,不当可下载附件——image_key 在卡片里,下载协议与消息图不同。
 */
function parseInteractive(c: Record<string, unknown>): ParsedIncoming {
  const parts: string[] = [];
  const body = c.body;
  if (body && typeof body === 'object') {
    const elements = (body as Record<string, unknown>).elements;
    if (Array.isArray(elements)) collectCardElementText(elements, parts);
  }
  if (Array.isArray(c.elements)) collectCardElementText(c.elements, parts);
  const text = parts.join('\n').trim();
  if (!text) return EMPTY_RESULT;
  return { text, attachments: [], unsupported: [] };
}

function collectCardElementText(elements: unknown[], parts: string[]): void {
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const n = el as Record<string, unknown>;
    const tag = typeof n.tag === 'string' ? n.tag : '';
    if (tag === 'markdown') {
      const content = typeof n.content === 'string' ? n.content.trim() : '';
      if (content) parts.push(content);
      continue;
    }
    if (tag === 'img') {
      parts.push('[图片]');
      continue;
    }
    if (tag === 'div') {
      const textObj = n.text;
      if (textObj && typeof textObj === 'object') {
        const content = (textObj as Record<string, unknown>).content;
        if (typeof content === 'string' && content.trim()) parts.push(content.trim());
      }
      continue;
    }
    if (tag === 'action') continue;
  }
}
