/**
 * 「这段文本对用户来说看得见吗」—— main 与 renderer **共用**的一份判定。
 *
 * 为什么必须共用而不是各写一份：中断自愈用它回答「模型这次到底有没有产出」，main 据此决定
 * 连续失败计数要不要归零（也就是 5 次上限拦不拦得住），renderer 据此决定聊天流里的重连行要
 * 不要折叠成一行。两边分叉的后果不会抛异常，只会表现成「自动重连绕过上限」或「一次中断堆
 * 出多行」这类静默不一致——#1071 的 review 里这一族连着被抓出好几轮，所以判定收敛成一处。
 *
 * 判据：去掉所有**不可见**字符后还剩东西，就算用户看得见。不可见包括三类：
 *  - 空白（`\s`：空格 / 制表 / 换行 / NBSP / U+2000–U+200A / U+FEFF …）；
 *  - Unicode 格式字符（`\p{Cf}`：U+200B 零宽空格、U+200C/200D 零宽连接符、U+2060 word
 *    joiner、U+00AD 软连字符 …）。**`trim()` 挡不住这一类**——它只认 `\s`，而零宽字符不在
 *    其中，于是「只有零宽字符的文本」会被误判成产出（greptile P2）；
 *  - 控制字符（`\p{Cc}`：C0/C1，如裸 `\x00`、`\x1b`）。
 *
 * 刻意**不**排除的：盲文空白 U+2800、Hangul filler U+3164 这类"看着空但确实是字形"的字符。
 * 本判定服务的是「上游流式产出里夹了不可见填充」这个真实场景，不是对抗刻意构造的输入；把
 * 合法字形也算成不可见反而会把真实产出误判成空。
 */

/** 所有不可见字符：空白 + Unicode 格式字符 + 控制字符。 */
const INVISIBLE_PATTERN = /[\s\p{Cf}\p{Cc}]/gu;

/** 这段文本去掉不可见字符后还有内容吗（非字符串一律 false）。 */
export function hasUserVisibleText(text: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return text.replace(INVISIBLE_PATTERN, '').length > 0;
}
