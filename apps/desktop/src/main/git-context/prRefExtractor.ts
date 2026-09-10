export { extractPrRefs, type PrRef } from '@cindy/maker-shared';

/**
 * 把一条消息的 content(string 或结构化对象)转成可扫描的文本。
 * 结构化 content 用 JSON.stringify 兜底——URL 出现在嵌套字段里也能命中。
 */
export function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}
