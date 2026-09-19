/**
 * Markdown 解析链（remark 插件）的单一事实源。
 *
 * MarkdownRenderer（实际渲染）与需要「与渲染同源解析」的消费方共用。当前
 * 消费方是审查页的 markdownRevision 校验：注入 `{++ ++}` / `{-- --}` 标记后
 * 必须按渲染链解析，才能判断标记是否真的会被消费——只按裸 remarkParse 校验
 * 会漏掉 remarkMath / remarkStrictInlineMath 这类「把整段文本吃成单个节点」的
 * 插件：`${--A1--}{++A3++}$` 在渲染链里是 inlineMath，标记永远不消费，会以
 * KaTeX 乱码形式泄漏给用户。
 *
 * 顺序约束与说明以此文件为准；MarkdownRenderer 只做 re-export，不再自行
 * 维护第二份清单。
 *
 * Module-level constants — defined once, never recreated across renders.
 * Passing inline arrays ([remarkGfm], [rehypeHighlight]) would create a new
 * array reference on every render, causing react-markdown to re-parse the
 * entire markdown AST every time even when content hasn't changed.
 * remarkTruncateCjkUrls 必须排在 remarkGfm 之后:gfm 的 autolink literal 会把
 * 「https://x.com/foo（中文」整体当成 url(spec 故意如此, 不修), 我们在 ast 层
 * 后处理一刀, 把误吞的 CJK / 全角字符切回 link 后面的 text 节点。
 * remarkHtmlImages 必须在 skipHtml 生效前把安全的单 <img> HTML 节点转成 mdast
 * image,否则模型在表格里输出的 `<img src="...">` 会被整段过滤掉。
 * remarkLocalPathLinks 排在 remarkGfm 之后:gfm 已把裸 URL autolink 成 link 节点,
 * 路径 tokenizer 只扫剩下的纯 text 节点,天然不会去碰已成链接的 URL。
 * remarkSessionLinks 只进受信任内容(privileged)的插件链:把正文裸写的
 * cindy://session/(+ 历史 xdt-maker://)深链切成 link 节点 → `a` 渲染器升级成 SessionLinkChip。
 * 顺序:在 remarkTruncateCjkUrls 之后(它只回收 gfm autolink 的 CJK 误吞,不碰
 * 之后生成的 link)、remarkLocalPathLinks 之前(session URL 先成 link,路径插件
 * 跳过 link 内 text,不会把 `session/<uuid>` 误当相对路径)。两个数组都是模块级
 * 常量,引用稳定,不破坏 react-markdown 的 re-parse 优化。
 * remarkMath: `$...$` / `$$...$$` → inlineMath / math 节点(micromark 语法扩展,
 * parse 阶段生效,与其它 transformer 的相对顺序无关)。`\(...\)` / `\[...\]` 定界
 * 符在 parse 前由 normalizeMathDelimiters 归一化成 dollar 形式(desktop / mobile
 * 共用实现,见 @cindy/maker-shared 的 mathMarkdown.ts)。remarkStrictInlineMath
 * 紧随其后,把松散配对的 inlineMath(货币文本、跨 code span)降级回原文,
 * 规则与 mobile parser 对齐。
 * remarkGfm singleTilde:false — 删除线只认标准 GFM 的 `~~text~~`,单个 `~` 保持
 * 字面量。默认 singleTilde:true 会把「4~6……4~6」这类区间写法中间整段划成删除线,
 * mobile 自研 parser(messageMarkdown.ts)本就只匹配 `~~`,此处对齐。
 * remarkCjkFriendly 紧随 remarkGfm 注册(官方示例顺序):放宽 CommonMark 加粗
 * 定界的侧翼(flanking)规则——CJK 全角标点(。：，“”（）等)不再被当作
 * 「标点」参与判定。原生规则下 `**` 内侧挨全角标点时开/闭侧翼不成立,整对
 * 星号退化成字面量(AI 高频写法「**小标题：**正文」「**“术语”**」「**（注）**」
 * 全中招);mobile 自研 parser 用正则配对本就能渲染这些写法,此处对齐。只放宽
 * emphasis/strong 的定界判定,不碰 `~~` 删除线(gfm strikethrough 有独立定界
 * 逻辑,行为不变),也不影响带空格的 `2 ** 3 ** 4` 这类本应保持字面量的写法。
 * remarkPreserveRawLocalDestinations 必须排在**链尾**:它给 image / link 节点存原始
 * 本地目的地(见该文件头部说明),必须在所有会新建这两类节点的插件之后运行——
 * remarkHtmlImages(<img> HTML → mdast image)与 remarkLocalPathLinks(正文裸路径
 * → link)。remarkSessionLinks 产出的 cindy:// 深链带 scheme,被它的判据跳过,
 * 顺序无关。
 */

import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import type { PluggableList } from 'unified';

import { rehypeFencedCodeMarker } from './rehypeFencedCodeMarker';
import { rehypeMathBlockMarker } from './rehypeMathBlockMarker';
import rehypeReviewMathMarks from './rehypeReviewMathMarks';
import remarkHtmlImages from './remarkHtmlImages';
import remarkLocalPathLinks from './remarkLocalPathLinks';
import remarkPreserveRawLocalDestinations from './remarkPreserveRawLocalDestinations';
import remarkSessionLinks from './remarkSessionLinks';
import remarkStrictInlineMath from './remarkStrictInlineMath';
import remarkTruncateCjkUrls from './remarkTruncateCjkUrls';

export const MARKDOWN_REMARK_PLUGINS: PluggableList = [
  [remarkGfm, { singleTilde: false }],
  remarkCjkFriendly,
  remarkMath,
  remarkStrictInlineMath,
  remarkTruncateCjkUrls,
  remarkHtmlImages,
  remarkLocalPathLinks,
  remarkPreserveRawLocalDestinations,
];

export const MARKDOWN_REMARK_PLUGINS_PRIVILEGED: PluggableList = [
  [remarkGfm, { singleTilde: false }],
  remarkCjkFriendly,
  remarkMath,
  remarkStrictInlineMath,
  remarkTruncateCjkUrls,
  remarkHtmlImages,
  remarkSessionLinks,
  remarkLocalPathLinks,
  remarkPreserveRawLocalDestinations,
];

/**
 * rehype 侧的装配也收在这里：审查页与聊天页**必须**共用同一份插件清单与顺序，只在
 * 是否插入 rehypeReviewMathMarks 上分叉。历史上两份数组在 MarkdownRenderer 里各写一份，
 * 任何新增插件只加其中一边，都会让审查页与聊天页的渲染链静默分叉。
 *
 * 顺序约束（改前先读）：
 *  - rehypeSlug：给标题挂 id，否则文档内锚点链接是死链。
 *  - rehypeKatex 必须排在 rehypeHighlight 之前：remark-math 产出的 hast 是
 *    `<code class="language-math ...">`，先让 katex 消费掉，否则 highlight 会往里面
 *    塞 hljs span 破坏纯文本结构。strict:'ignore' 静默非致命 LaTeX 告警；解析失败的
 *    公式回落为正文色原文，避免模型格式错误把普通聊天染成错误红。
 *  - rehypeReviewMathMarks 必须**紧跟** rehypeKatex：它处理的正是 KaTeX 生成的节点
 *    （把 `\textcolor` 写下的哨兵色换成 <del> / <ins> 的 diff token 类）。
 *  - rehypeMathBlockMarker 紧随其后：把裸 `<span class="katex-display">` 包进
 *    `<div data-math-block>`，让 div 渲染器能挂「复制为图片」工具栏
 *    （components 映射只认 tagName，认不了 class）。
 *  - rehypeFencedCodeMarker 必须排在最后：katex 已消费掉 `$$…$$` 的 `<pre><code>`、
 *    highlight 已注入 hljs span，此时剩下的 `pre > code` 就是真正的代码块。
 */
function buildRehypePlugins(withReviewMathMarks: boolean): PluggableList {
  return [
    rehypeSlug,
    [rehypeKatex, { strict: 'ignore', errorColor: 'inherit' }],
    ...(withReviewMathMarks ? [rehypeReviewMathMarks] : []),
    rehypeMathBlockMarker,
    rehypeHighlight,
    rehypeFencedCodeMarker,
  ];
}

// 模块级常量：引用稳定，不破坏 react-markdown 的 re-parse 优化。
export const MARKDOWN_REHYPE_PLUGINS: PluggableList = buildRehypePlugins(false);
/** 审查页专用（多一个 rehypeReviewMathMarks）；普通聊天行为完全不变。 */
export const MARKDOWN_REHYPE_PLUGINS_REVIEW: PluggableList = buildRehypePlugins(true);
