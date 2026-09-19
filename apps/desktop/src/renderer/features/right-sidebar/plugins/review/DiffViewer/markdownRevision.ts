/**
 * markdownRevision — 审查页 Markdown 富文本预览的「词级修订」生成器。
 *
 * 对 1:1 配对的修改块（或纯新增 / 纯删除块）做词级 diff，把改动注入成
 * `{++新增++}` / `{--删除--}` 标记，产出单块修订源码；MarkdownRenderer 打开
 * `reviewAnnotations` 后渲染为 <ins>/<del>，观感对齐 Word 修订模式。
 *
 * 安全边界（任何一条不满足就返回 null，由调用方回退整块装饰）：
 *  - 源码体积超过 REVISION_MAX_SOURCE_CHARS；
 *  - 改动片段含 `{` / `}`（标记语法吃不了花括号）；
 *  - 两版保留文本占比低于 REVISION_MIN_UNCHANGED_RATIO（整块改写没有词级价值）；
 *  - 注入后校验失败：按**与渲染同源**的解析链跑完插件后仍有未消费的标记
 *    残留（跨块标记不包裹；`$...$` / `$$...$$` 里的标记会被 remarkMath 吃成
 *    math 节点），或修订版的顶层块结构与参照版本不一致。
 *
 * 校验链必须与 MarkdownRenderer 一致（共享 markdownPluginPipeline，并且要跑完
 * transformer 而不只是 parse），否则会出现「校验认为能消费、渲染时变成字面量」
 * （KaTeX 乱码事故的根因），或「校验看到的结构与折叠时不同、行内节点被丢掉」
 * （裸路径在渲染链里会变成 link）。
 */

import { normalizeMathDelimiters } from '@cindy/maker-shared/math-markdown';
import { diffWordsWithSpace } from 'diff';
import type { Root } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { MARKDOWN_REMARK_PLUGINS } from '@/components/chat/markdownPluginPipeline';
import {
  hasUnconsumedReviewMarks,
  remarkReviewAnnotations,
} from '@/components/chat/remarkReviewAnnotations';

/** 参与词级修订的单块源码上限（两版合计）。 */
export const REVISION_MAX_SOURCE_CHARS = 200_000;
/** 两版保留文本占比低于该值时视为整块改写，词级标记没有阅读价值。 */
export const REVISION_MIN_UNCHANGED_RATIO = 0.3;

/**
 * 任务列表标记（`- [ ]` / `- [x]`）。勾选态变化不能词级：标记落在方括号里会把
 * `- [x]` 拆成 `- [ {++x++}]`，remark-gfm 就不再把它当任务清单——复选框消失、
 * 退化成字面文字。这类变化回退整块装饰（两版各自完整渲染，复选框正常）。
 */
const TASK_MARKER_PATTERN = /^[\t ]*[-*+] +\[([ xX])\]/gm;

/**
 * 任务标记序列（无任务列表时返回 null）。序列不一致就放弃词级。
 *
 * ⚠️ 按**原始字符**比较，不做大小写归一：`- [x]` → `- [X]` 也是勾选态写法变化，
 * 归一后会误判成「标记未变」放行，词级标记同样会把复选框拆掉（`- [{--x--} ]`）。
 */
export function taskMarkers(source: string): string | null {
  const markers = [...source.matchAll(TASK_MARKER_PATTERN)].map((match) => match[1] ?? '');
  return markers.length > 0 ? markers.join('') : null;
}

/** CriticMarkup 定界符：作者原文里字面出现时与折叠器同形，碰到就整块回退。 */
const CRITIC_MARK_DELIMITER = /\{\+\+|\+\+\}|\{--|--\}/;

const parser = unified().use(remarkParse).use(MARKDOWN_REMARK_PLUGINS);

/**
 * 生成修订版源码。返回 null 表示该块对不适合词级修订。
 * `referenceSource` 由调用方决定：配对修改 / 纯新增用新版块，纯删除用旧版块。
 */
export function buildMarkdownRevision(before: string, after: string): string | null {
  const hasBefore = before.trim().length > 0;
  const hasAfter = after.trim().length > 0;
  if (!hasBefore && !hasAfter) return null;
  if (before === after) return null;
  if (before.length + after.length > REVISION_MAX_SOURCE_CHARS) return null;
  // 任务标记（勾选态或数量）有任何变化都回退：词级标记会拆掉 `- [x]` 语法。
  if (taskMarkers(before) !== taskMarkers(after)) return null;
  // 原文里字面的 CriticMarkup 定界符（如文档在讲解这套语法）也会被修订折叠器一并消费：
  // 在同一份预览里，含改动的块会把它渲染成删除线/下划线，未改动的块却按字面量渲染。
  // 保守回退整块（块级装饰不跑折叠器，两版都按字面渲染）。
  if (CRITIC_MARK_DELIMITER.test(before) || CRITIC_MARK_DELIMITER.test(after)) return null;

  if (!hasBefore || !hasAfter) {
    return buildWholeBlockRevision(
      hasAfter ? after : before,
      hasAfter ? after : before,
      hasAfter ? 'insert' : 'delete',
    );
  }

  const parts = diffWordsWithSpace(before, after);
  let injected = '';
  let markCount = 0;
  let unchangedChars = 0;
  for (const part of parts) {
    if (part.added || part.removed) {
      if (/[{}]/.test(part.value)) return null;
      // 纯空白改动（换行/空格）不挂标记：标记只会产生空的下划线/删除线噪声，
      // 直连保留在输出里即可（渲染上等价于未改）。
      if (part.value.trim() === '') {
        injected += part.value;
        continue;
      }
      injected += part.added ? `{++${part.value}++}` : `{--${part.value}--}`;
      markCount += 1;
      continue;
    }
    injected += part.value;
    unchangedChars += part.value.length;
  }
  if (markCount === 0) return null;
  if (unchangedChars / Math.max(before.length, after.length) < REVISION_MIN_UNCHANGED_RATIO) {
    return null;
  }
  return validateRevision(injected, after) ? injected : null;
}

function buildWholeBlockRevision(
  body: string,
  reference: string,
  kind: 'insert' | 'delete',
): string | null {
  if (/[{}]/.test(body)) return null;
  const injected = kind === 'insert' ? `{++${body}++}` : `{--${body}--}`;
  return validateRevision(injected, reference) ? injected : null;
}

/**
 * 校验注入结果可被 MarkdownRenderer 的修订插件完整消费：
 *  - 插件跑完后没有未消费的标记残留（跨块边界不匹配的情况会留下残留）；
 *  - 修订版顶层块结构与参照版本一致（块前缀没被卷进标记）。
 * 校验直接跑与渲染同一个插件函数，避免两侧规则漂移。
 */
function validateRevision(injected: string, referenceSource: string): boolean {
  const injectedTree = parseRevisionTree(injected);
  const referenceTree = parseRevisionTree(referenceSource);
  if (!injectedTree || !referenceTree) return false;
  remarkReviewAnnotations()(injectedTree);
  if (hasUnconsumedReviewMarks(injectedTree)) return false;
  return topLevelSignature(injectedTree) === topLevelSignature(referenceTree);
}

/**
 * 按**与渲染同源**的解析链把源码解成 mdast（parse + 全量 transformer），
 * 供修订校验与表格结构级注入共用。任何异常都收敛为 null。
 */
export function parseRevisionTree(source: string): Root | null {
  try {
    // 输入归一化 + 插件链与 MarkdownRenderer 同源：`\(...\)` / `\[...\]` 会在
    // 渲染前被 normalizeMathDelimiters 转成 dollar 形式，remarkMath 再把整段
    // 文本吃成 inlineMath / math 节点。只按裸 remarkParse 校验会漏掉这类节点，
    // 标记会以 KaTeX 乱码形式泄漏给用户。
    const tree = parser.parse(
      normalizeMathDelimiters(source, { preserveLineCount: false }),
    ) as Root;
    // 再跑完整链的 transformer：渲染链在 parse 之后还会新建 / 改造行内节点
    // （remarkLocalPathLinks 把裸路径切成 link、remarkHtmlImages 把单 <img>
    // 转成 image…）。只比 parse 结果的话，校验看到的结构与折叠时看到的可能
    // 不同，这些「洞」会被静默丢弃。
    parser.runSync(tree);
    return tree;
  } catch {
    return null;
  }
}

/** 顶层块类型签名：用于比对修订版与参照版本的结构是否一致。 */
export function topLevelSignature(tree: Root): string {
  return tree.children.map((child) => child.type).join('|');
}
