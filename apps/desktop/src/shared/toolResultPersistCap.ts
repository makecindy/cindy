/**
 * tool_result 落库正文上限(chat-data perf):全文不再无界写进 messages.content。
 *
 * 背景:7GB 级本地库里 tool_result 占了绝对大头(单条可达 MB 级、177 万行里
 * 4.5GB),而它既不进 FTS、不进嵌入、不做侧栏预览,device-link 同步到手机也早已
 * 截到 8KB(dispatch.ts REMOTE_TOOL_RESULT_CONTENT_LIMIT)。本地持久化对齐同一
 * 阈值:重开任务仍能看到开头 8K 字符,当前 turn 的完整内容继续走内存
 * resolvedContent,Agent 续跑走 SDK transcript,不依赖这张表。
 *
 * 媒体挂账契约:截断丢弃的尾部可能含首次出现的 cindy-media blob URL,调用方
 * 必须**先对原文扫 URL 挂账、再截断**(见 messagePersistBroadcaster 的
 * persistableToolResultContent),否则生成产物会被 recycler 判零引用回收。
 *
 * 纯函数、无依赖:main 侧 broadcaster、Claude 导入准备层与 DB worker importer
 * (tx.ts / inline worker fallback)共用同一份,保证所有写入口一个口径。
 * 导入路径的媒体挂账在 main 侧对原文执行(worker 碰不到 cindy-media ledger)。
 */

export const TOOL_RESULT_PERSIST_CONTENT_LIMIT = 8 * 1024;

export const TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX =
  '\n\n[tool result truncated: stored first 8KB]';

/**
 * 把 tool_result 正文截到落库上限,超限时带截断后缀。按字符数截(不是字节):
 * 上限的意义是"有界",不追求与 device-link 的字节口径逐字节一致。切点回退一位
 * 避免劈开 surrogate pair。幂等:已截断的文本长度必然 <= 上限,不会二次截断。
 */
export function capToolResultTextForPersist(
  text: string,
  limit = TOOL_RESULT_PERSIST_CONTENT_LIMIT,
): string {
  if (text.length <= limit) return text;
  let cut = Math.max(0, limit - TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length);
  const lastKept = text.charCodeAt(cut - 1);
  if (cut > 0 && lastKept >= 0xd800 && lastKept <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}${TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX}`;
}

/** 导入行与 live 落库同一上限:只有字符串 tool_result 会被截;其它 role 原样返回。 */
export function capImportedToolResultContent(role: string, content: unknown): unknown {
  if (role !== 'tool_result' || typeof content !== 'string') return content;
  return capToolResultTextForPersist(content);
}
