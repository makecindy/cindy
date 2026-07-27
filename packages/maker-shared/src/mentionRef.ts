/**
 * mentionRef.ts —— inline `@mention` token 的**识别侧**(切词 + 解析)。
 * ---------------------------------------------------------------------------
 * composer 里的 mention chip 发送时被序列化成纯文本 `@<path>`,path 含空格 / 引号
 * 时用 `@"<path>"` 引号形式(见 ChatInput.serializeEditorContent →
 * `renderer/lib/mentionRefFormat.formatMentionRef`)。
 *
 * 自动起名要在 main 侧判断"用户有没有真正打字":mention chip 是点选出来的资源,
 * 不是散文,判定前必须把这些 token 剔除。`apps/desktop/src/shared` 按依赖方向不能
 * 反向 import renderer,所以识别侧放在共享包里。
 *
 * **为什么只放识别侧、不把序列化一起搬过来**:序列化的转义规则(只转义 `"`、
 * 不转义 `\`)与 maker-core 的 `quotedMentionText` 逐字节对齐,并有单测锁定 Windows
 * 含空格路径的确切产物(`@"C:\Users\My Documents\file.md"`)。动它就是改 agent 看到
 * 的 prompt 文本,按 `docs/dev-rules/maker-core-and-agent-behavior.md` §3 需要实测
 * 四项数据指标,不该由一个自动起名的改动顺带承担。因此序列化留在原处不动,这里只
 * 镜像与之对称的识别逻辑;两边的转义约定改动时必须一起改。
 */

/**
 * 切词正则：同时识别引号形式 `@"a b.md"` 与裸形式 `@a.md`，配合 String.split
 * 使用（带捕获组以保留分隔片段）。引号分支优先，保证含空格的引用整体命中。
 * 不带 `g` 标志：String.split 本身就是全局拆分，且模块级共享的 `g` 正则带
 * 有状态 lastIndex，将来若有人误用 test()/exec() 会踩坑。
 */
export const MENTION_TOKEN_SPLIT = /(@"(?:\\.|[^"\\])*"|@\S+)/;

/**
 * 解析一个以 `@` 开头的 mention token，取出干净的 path 引用（去引号、反转义）。
 * @returns ref 为不含 `@` 与外层引号的原始 path；quoted 标识是否来自引号形式。
 *
 * 反转义与序列化侧严格对称：序列化只把 `"` 转义成 `\"`，所以这里只还原 `\"`,
 * **不能**把 `\` 当通用转义前缀 —— 否则 Windows 含空格路径（如
 * `C:\Users\My Documents\file.md`，会被加引号）里的反斜杠会被吞掉，得到
 * `C:UsersMy Documentsfile.md` 这种静默损坏的路径。
 */
export function parseMentionToken(token: string): { ref: string; quoted: boolean } {
  if (token.startsWith('@"') && token.endsWith('"') && token.length >= 3) {
    return { ref: token.slice(2, -1).replace(/\\"/g, '"'), quoted: true };
  }
  return { ref: token.slice(1), quoted: false };
}
