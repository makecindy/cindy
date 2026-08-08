/**
 * 术语表 guard 的纯规则函数。
 *
 * 抽成独立模块是为了可测:这里每一条边界都是踩过的坑(见各函数注释),回归代价很高,
 * 必须有单测钉住。check-i18n-glossary.mjs 只做编排与 IO。
 */

/**
 * ASCII 术语的词边界字符集。
 *
 * 连字符 / 下划线**必须**算作边界:否则 `ssh-agent`(SSH 密钥代理,与产品的 Agent 是
 * 两个概念)会被判成「agent 大小写不统一」。引入本脚本时这一条制造了 60 处假阳性中的
 * 大半,`user-agent`、`sub-agent`、`agent_id` 同理。
 */
export const WORD_BOUNDARY = 'A-Za-z0-9_-';

/** CJK 全角句读与括号。出现即说明 URL / 邮箱已经结束、后面是正文。 */
const CJK_PUNCT = '，。；：！？、（）「」【】《》“”‘’…';
/** 汉字 + 假名 + 谚文。用于「半角分隔符后面是不是中文正文」的判定。 */
const CJK_CHAR = '\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af';

/**
 * URL / 邮箱这类「不参与术语匹配的 token」的收尾规则。
 *
 * **不能**用 \S+ 收尾:中文正文常紧跟在它们后面且中间没有空格,\S+ 会把标点连同后面
 * 整句正文一起吞掉,于是之后的禁用词、大小写、标点问题全部检测不到,门禁静默放行。
 *
 * 两级截断:
 *  - 全角句读:一律截断——URL 里不会出现全角标点;
 *  - 半角 , ; : ! ?:**仅当其后(允许一个空格)是 CJK 字符时**截断。允许空格是因为中英混排
 *    常写成 `https://x.test, 返回…`;只认紧邻的话逗号会被当成 URL 的一部分吃掉,
 *    后面的标点违规随之漏检。不能无条件截,否则会切坏合法的
 *    query string(`?a=1&ids=1,2`)与端口号(`:8080`);而 `https://x.test,返回…`
 *    这种半角逗号后直接接中文的写法,逗号显然是正文标点而非 URL 的一部分。
 *  - 连续三个点:一律截断。`Open https://x.test...` / `联系 a@x.com...然后重试` 里的
 *    `...` 是正文省略号,被 token 吃掉后省略号门禁就查不到了。URL 里不会出现连续三个点
 *    (路径分隔与单个点不受影响)。
 *  - CJK 字符本身:一律截断。中英混排常把正文直接贴在地址后面且**连标点都没有**
 *    (`访问 https://x.test返回worker操作`、`联系 a@x.com然后worker操作`),此时上面按
 *    标点截断的两条都用不上,\S 会把整句正文吞掉,里面小写的 worker 违规随之消失。
 *    URL / 邮箱里不会出现裸 CJK——国际化域名与路径在文案里都以 punycode 或
 *    percent-encoding 形式书写,实测 desktop 与 mobile 语料里 0 例外。
 */
const TOKEN_TAIL = `(?:(?![${CJK_PUNCT}${CJK_CHAR}])(?!\\.\\.\\.)(?![,;:!?](?=\\s*[${CJK_CHAR}]))\\S)+`;

const URL_TOKEN = new RegExp(`\\b[a-z][\\w-]*://${TOKEN_TAIL}`, 'gi');

/**
 * 邮箱片段。
 *
 * 收尾用 TOKEN_TAIL,理由同 URL——原先的 `\S+@\S+\.\S+` 连全角标点都不截,
 * 「联系 a@x.com，返回worker操作」会被整段剥成「联系 」。
 *
 * local part(@ 前面那段)必须限定在邮箱合法字符里,**不能**用「除空白与全角标点之外的
 * 一切」:那样会把紧贴在地址前面的中文正文一起吃掉——`返回worker联系a@x.com` 整条被剥成
 * 一个空格,里面小写的 worker 违规随之消失。中文文案里地址常与正文无空格相接。
 */
const EMAIL_TOKEN = new RegExp(`[A-Za-z0-9._%+-]+@${TOKEN_TAIL}`, 'g');

/**
 * 文件名片段。
 *
 * 原先用扩展名白名单(json|ts|tsx|…),漏掉 `plugin.py`、`worker.go`、`Agent.java` 这类
 * ——它们会被当成正文里的产品术语,报「plugin 应为 Plugin」这种假阳性并阻断 CI。
 * 白名单永远补不全,改成通用形态。
 *
 * 两个约束防止误伤:
 *  - 扩展名必须是纯小写字母 → `1.5`、`v1.0`、`2.0 GB` 不会被当成文件名吃掉
 *    (那会让「1.5,上限」这类半角标点违规漏检);**不设长度上限**——仓库实际支持的
 *    扩展名里有 `.webmanifest`(11)、`.gitattributes`(13)、`.browserslistrc`(14)、
 *    `.prettierignore`(14)(见 packages/maker-shared/src/filePreview.ts),任何具体数字
 *    都会随支持列表变化而失准,只靠「纯小写字母」这一条约束即可;
 *  - 词干必须含至少一个字母 → 纯数字的 `12.34` 同理排除。
 */
const FILENAME_TOKEN = /\b[A-Za-z0-9_-]*[A-Za-z][A-Za-z0-9_-]*\.[a-z]+\b/g;

/**
 * 剥离不该参与术语匹配的片段,避免误报:
 *  - {{var}} / {{var, format}}  i18next 插值(变量名常与术语同形,如 {{project}})
 *  - <0>…</0>                   Trans 组件占位
 *  - $t(...)                    i18next 嵌套引用
 *  - URL、邮箱、带扩展名的文件名(project.json)
 */
export function stripNonProse(text) {
  return text
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/<\/?\d+>/g, ' ')
    .replace(/\$t\([^)]*\)/g, ' ')
    .replace(URL_TOKEN, ' ')
    .replace(EMAIL_TOKEN, ' ')
    .replace(FILENAME_TOKEN, ' ');
}

/**
 * 术语命中判定。
 * 纯 ASCII 词(Agent / Plugin)按词边界匹配,允许紧跟复数 s;
 * 含 CJK 的词(代理 / 插件)没有词边界概念,用子串。
 */
export function occursIn(text, term) {
  if (!term) return false;
  if (/^[\x20-\x7e]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![${WORD_BOUNDARY}])${escaped}s?(?![${WORD_BOUNDARY}])`).test(text);
  }
  return text.includes(term);
}

/**
 * 英文源里「是否提到某个概念」的判定,供 forbidden 的条件禁用(whenEn)使用。
 *
 * 词边界复用 WORD_BOUNDARY,口径必须与 occursIn / findCaseMismatch 一致,否则边界规则
 * 演进时两处会悄悄漂移,出现「术语命中了但条件禁用没生效」这种最难查的不一致。
 *
 * 复数**不能**只认「加 s」:Proxy 的复数是 proxies,`Proxy` + `s?` 认不出来,于是英文源写
 * `system proxies` 时 Proxy 条目那条「代理」的条件禁用整个跳过,门禁放行了本该拦下的
 * 误译。这里按英语规则展开真实复数形态:
 *  - 辅音 + y → ies(proxy → proxies);
 *  - s / x / z / ch / sh 结尾 → es(process → processes);
 *  - 其余 → 可选 s。
 * 大小写不敏感——英文源里同一个概念可能出现在句首或句中。
 *
 * 抽成共享函数还有一层用途:guard 与三份影子 catalog 单测原先各自抄了一份同样的正则,
 * 抄本之间早晚会失配。
 */
export function makeSourceTermMatcher(word) {
  if (!word) return null;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let forms;
  if (/[^aeiou]y$/i.test(word)) {
    forms = `(?:${escaped}|${escaped.replace(/y$/i, '')}ies)`;
  } else if (/(?:s|x|z|ch|sh)$/i.test(word)) {
    forms = `(?:${escaped}(?:es)?)`;
  } else {
    forms = `(?:${escaped}s?)`;
  }
  return new RegExp(`(?<![${WORD_BOUNDARY}])${forms}(?![${WORD_BOUNDARY}])`, 'i');
}

/** 英文源是否提到 whenEn 指代的概念(含真实复数形态)。 */
export function sourceMentions(source, word) {
  const re = makeSourceTermMatcher(word);
  return re ? re.test(source) : false;
}

/**
 * 某语言下该术语要不要做大小写检查,要的话返回标准形态,否则返回 null。
 *
 * 两条触发路径:
 *  - translations[locale] 就是英文原词(Agent 的 zh-CN 写 "Agent");
 *  - **alsoAllowed[locale] 里允许了英文原词**。这条原先漏了:Skill 的 zh-CN 首选译法是
 *    「技能」,但 alsoAllowed 允许技术语境保留英文 `Skill`——于是 translations 值不等于
 *    term.en,大小写检查被整条跳过,skillhub 里 10 处小写 `skill` 一路放行。既然允许
 *    保留英文,保留的就该是规范形态,与 Agent / Worker 同一口径。
 *    只认**恰好等于 term.en** 的条目:thread 的 `thread`、credits 的 `credits` 是故意
 *    小写的外部系统叫法,大小写不受本产品约束,靠这个相等条件天然排除。
 *
 * checkCase === false 一律不检查:Issue / Session 这类词同时是常用英语单词。
 * 源语言(en)不检查:glossary 把英文存在 term.en 而非 translations.en,天然返回 null
 * ——英文句子里 agent / worker 作普通名词小写本就是正确英语,实测开启会产生 84 处假阳性。
 */
export function caseStandardFor(term, locale) {
  if (term.checkCase === false) return null;
  if (term.translations?.[locale] === term.en) return term.en;
  const also = term.alsoAllowed?.[locale] ?? [];
  return also.some((e) => e?.text === term.en) ? term.en : null;
}

/**
 * 术语在文案里出现的次数。
 *
 * fingerprint 需要它:光靠「locale + key + 规则 + 词」无法区分同一个 key 里命中 1 次还是
 * 3 次。某个 key 的一处「会话」被冻进 baseline 后,再往同一条文案里加一处「会话」会产出
 * 完全相同的 fingerprint,新违规就被 baseline 掩盖、CI 照过——这违反 baseline「只减不增」
 * 的契约。把次数编进 fingerprint,增加一处就是一条新指纹。
 */
export function countOccurrences(text, term, { caseInsensitive = false } = {}) {
  // 空串必须先挡掉:走到下面的 CJK 分支时 `indexOf('', from)` 永远返回 from、
  // `term.length` 为 0,循环不推进——门禁会**挂死**而不是报错。CI 里
  // check:i18n-glossary 排在单测之前,一个手滑的 "" 就能让整条流水线卡住。
  // schema 那边也加了 minLength: 1,这里是第二道防线:任何调用路径都不该挂住。
  if (!term) return 0;
  if (/^[\x20-\x7e]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 默认**大小写敏感**,与 occursIn 同口径。禁用译法的判定必须如此:术语表里
    // project 只禁大写 Project、plugin 则把两种大小写各列一条,说明设计意图就是
    // 逐形态声明。若在这里用 /i,「只禁 Project」会被悄悄扩成连小写 project 也禁。
    // 大小写检查(term-case)反过来需要数出所有形态,那里显式传 caseInsensitive。
    const re = new RegExp(
      `(?<![${WORD_BOUNDARY}])${escaped}s?(?![${WORD_BOUNDARY}])`,
      caseInsensitive ? 'gi' : 'g',
    );
    return [...text.matchAll(re)].length;
  }
  // CJK 词用不重叠的子串计数
  let n = 0;
  let from = 0;
  for (;;) {
    const i = text.indexOf(term, from);
    if (i < 0) return n;
    n += 1;
    from = i + term.length;
  }
}

/**
 * 半角标点在文案里出现的次数(同 countOccurrences,供标点规则的 fingerprint 用)。
 * 两组形态都要数:只数其中一组的话,另一组新增一处违规不会改变指纹,已冻结的 baseline
 * 就把它一起掩盖了,违反 baseline「只减不增」的契约。
 */
export function countHalfWidthPunct(text) {
  let n = [...text.matchAll(new RegExp(HALF_WIDTH_AFTER_HAN.source, 'g'))].length;
  if (HAS_CJK.test(text)) {
    // 刻意不加 m 标志:`$` 必须只表示整串末尾,与 findHalfWidthPunct 同口径。加了 m
    // 会把多行文案的每个换行处都算成句末,两个函数对同一条文案给出不同答案。
    n += [...text.matchAll(new RegExp(HALF_WIDTH_IN_CJK_PROSE.source, 'g'))].length;
  }
  return n;
}

/**
 * 剥掉匹配尾部那个「可选复数 s」——**只在匹配确实比标准长时才剥**。
 *
 * 匹配用的正则带 `s?`,于是标准词本身以 s 结尾时(`Credits`、`Full access`),
 * 无条件 `replace(/s$/, '')` 会把词固有的那个 s 也削掉,拼写完全正确的文案反被判成
 * 违规(实测 findCaseMismatch('Full access', 'Full access') 返回 'Full acces')。
 * 目前保留英文的术语恰好都不以 s 结尾,所以还没爆——但只要有人加一条以 s 结尾的
 * 术语,正确文案就会被门禁全面拒绝。
 */
function stripPluralSuffix(match, standard) {
  return match.length > standard.length ? match.replace(/s$/, '') : match;
}

/**
 * 大小写形态检查:命中术语但拼写形态与标准不符时返回**第一个不符的**实际拼写,否则 null。
 *
 * 必须扫描全部匹配,不能只看第一个:一条文案里常先出现正确形态、后出现错误形态
 * (「创建 Worker 后,该 worker 会自动启动」)。用非全局 match 时,第一个匹配正确就直接
 * 返回 null,后面的错误形态永远查不出来——两位 reviewer 在 #389 都把这条标为 P1。
 */
export function findCaseMismatch(text, standard) {
  if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(standard)) return null;
  const escaped = standard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![${WORD_BOUNDARY}])${escaped}s?(?![${WORD_BOUNDARY}])`, 'gi');
  for (const m of text.matchAll(re)) {
    const hit = stripPluralSuffix(m[0], standard);
    if (hit !== standard) return hit;
  }
  return null;
}

/**
 * 大小写形态不符的**次数**(而非术语出现的总次数)。
 *
 * fingerprint 必须用这个:数总次数的话,`worker … Worker` 与 `worker … worker` 产出同一个
 * `worker×2` 指纹——前者冻进 baseline 后,把那个原本正确的 Worker 也改成小写,新增的违规
 * 会被静默掩盖。指纹要反映「错了几处」,不是「这个词出现了几次」。
 */
export function countCaseMismatches(text, standard) {
  if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(standard)) return 0;
  const escaped = standard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![${WORD_BOUNDARY}])${escaped}s?(?![${WORD_BOUNDARY}])`, 'gi');
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (stripPluralSuffix(m[0], standard) !== standard) n += 1;
  }
  return n;
}

/**
 * 构造某术语的豁免判定。
 * 支持完整路径精确匹配,以及以 `.` 结尾的子树前缀(用于整段同形异义,例如
 * SSH agent 与产品 Agent,`desktop:settings.remote.` 整段豁免)。
 * 刻意**不支持**按末段 key 名匹配——那会让任意同名嵌套 key 被静默放过。
 */
export function makeExemptChecker(list) {
  const exact = new Set();
  const prefixes = [];
  for (const item of list ?? []) {
    if (item.endsWith('.')) prefixes.push(item);
    else exact.add(item);
  }
  return (key) => exact.has(key) || prefixes.some((p) => key.startsWith(p));
}

// ---------------------------------------------------------------------------
// 标点规则
// ---------------------------------------------------------------------------

/**
 * 规则边界由现状数据定,不靠直觉(比例为引入本脚本时实测的 desktop locale):
 *  - 全角逗号 / 冒号:zh-CN 全角是主流(逗号 566:218、冒号 153:61)，zh-TW 生成语料也统一
 *    使用全角中文标点→ 规则成立。
 *    **ja 不适用**——日文 UI 惯例本就用半角冒号,实测半角 124:78 反而是主流,
 *    套用中文规则会制造 124 处假阳性。ko 同理不适用。
 *  - 省略号:zh-CN 140:44、ja 138:46、ko 138:46,三语一致以「…」为主流 → 全部适用。
 *    **en 同样适用**——不是靠现状数据,而是 DESIGN.md §11 Voice & Content 明文规定
 *    英文也用省略号字符「…」而非三个半角点。原先漏掉 en,等于让门禁替既有违规背书。
 */
export const HALFWIDTH_PUNCT_LOCALES = new Set(['zh-CN', 'zh-TW']);
export const ELLIPSIS_LOCALES = new Set(['en', 'zh-CN', 'zh-TW', 'ja', 'ko']);

/**
 * 中文正文里的半角标点。两种形态:
 *
 *  1. 汉字 / 右闭合符号 + 半角标点。只认汉字的话 `(直接替换,不留原文),或…` 会漏——
 *     逗号前面是右括号。右括号 / 右引号 / 右书名号后面接的仍是中文正文。
 *     直引号与反引号同样要算:中文文案里常写 `默认 "cindy",有重名时…`,
 *     闭合的半角引号后面那个逗号一样是正文标点。但引号这一支**要求右侧是 CJK**
 *     ——半角引号常用来包英文,`英文 "note", then continue` 里的逗号是英文标点,
 *     不该判违规。全角括号 / 书名号那一支不需要这个条件(已对 26 处实例逐条核对过)。
 *  2. 拉丁字母 / 数字 / 连字符 / 下划线 + 半角标点 + **后面是 CJK**。
 *     `Keychain,重启` 这类漏了整整一类;连字符与下划线也要算,否则代码风格的 token
 *     结尾会漏——`该 id 使用了官方保留前缀 cindy-,仅随…` 里逗号前是连字符。
 *     中文句子里夹的英文产品名、技术词后面同样该用全角。这一支必须要求右边是 CJK,
 *     否则 `a=1,b=2`、`GPT-4,Claude` 这种纯 ASCII 片段会被误判。
 *
 *     CJK 前允许空白(`\s*`):中英混排常在半角标点后留一个空格,`Keychain, 重启` 与
 *     `Keychain,重启` 是同一个问题,只认紧邻会漏掉前者。空白不影响排除纯 ASCII 的目的
 *     ——`a=1, b=2` 后面仍不是 CJK。
 */
const HALF_WIDTH_AFTER_HAN = new RegExp(
  `[一-鿿）)」』】》〉”’][,:;!?]|["'\`][,:;!?](?=\\s*[${CJK_CHAR}])|[A-Za-z0-9_-][,:;!?](?=\\s*[${CJK_CHAR}])`,
);

/** 文案里是否有 CJK 字符——下面两条规则只在中文正文里成立。 */
const HAS_CJK = new RegExp(`[${CJK_CHAR}]`);

/**
 * 句末的 `?` / `!` 紧跟拉丁 token,且整条文案是中文正文。
 *
 * 上面第 2 形态要求「半角标点右边是 CJK」,句末标点右边什么都没有,于是整类漏检:
 * 中文疑问句以英文产品名收尾时就长这样——`断开 Cindy AI?`,它显然该用「？」。
 *
 * 只认句末的 `?` `!`。三点边界都是刻意的:
 *  - 句末的 `,` `:` `;` 不算:结构化文本里的标签与前缀(`Note:`、列表项收尾)本就用半角。
 *  - **句中**「拉丁 + 半角逗号 + 拉丁」不算,哪怕整条是中文正文。中文句子里夹的英文短语
 *    两侧都是拉丁时确实可能漏掉真违规(Slack 安装确认里的 `Cindy App, bot` 就是一例,
 *    已手工改掉),但这个形态与「代码 / 语法示例」外形完全相同——`格式为 key=value,
 *    key2=value2 的形式`、`GPT-4, Claude 两者` 里的半角逗号有的对有的错,取决于那段
 *    到底是正文还是样例,静态扫描判不了。上一轮 review 已按此定过口径(见本文件末尾
 *    对应单测),不再反复。同理字体预览的排印样张 `… a,b · 0123456789 !?@&` 也不该被拦。
 *  - 要求整条含 CJK:纯英文文案里的 `Continue?` 是正确英语。
 *
 * 与 HALF_WIDTH_AFTER_HAN 刻意**互斥**,不能有字符同时被两组形态匹配:
 * countHalfWidthPunct 把两组命中数相加,重叠会让既有违规计数翻倍,已冻结的 baseline
 * 指纹随之全部失配。所以左边界只取拉丁 / 数字 / `_` / `-`——右括号与汉字是第 1 形态的地盘。
 */
const HALF_WIDTH_IN_CJK_PROSE = new RegExp(`[A-Za-z0-9_-][!?]\\s*$`);
const ASCII_ELLIPSIS = /\.\.\./;

/**
 * 插值占位符在标点检查里的替身。
 *
 * stripNonProse 把 {{total}} 换成空格,于是「已缓存 {{total}},上限」在剥离后成了
 * 「已缓存  ,上限」——半角逗号前面是空格而非汉字,HALF_WIDTH_AFTER_HAN 匹配不上,
 * 违规被静默放过(实测 settings.about.storage.reportCache 就是这样漏掉的)。
 *
 * 对读者而言 {{total}} 渲染出来就是正文的一部分,它后面跟半角逗号同样是排版错误,
 * 所以标点检查要把插值当成汉字。用一个落在 一-鿿 区间内的字符做替身即可。
 *
 * URL / 邮箱 / 文件名**不能**这样替换:`config.json:` 里的冒号是路径分隔符不是标点,
 * 换成汉字替身会把它们全判成违规。那几类仍替换为空格。
 */
const PROSE_PLACEHOLDER = '中';

/** 半角标点 → 中文全角对应物。 */
export const FULL_WIDTH_PUNCT = Object.freeze({
  ',': '，',
  ':': '：',
  ';': '；',
  '!': '！',
  '?': '？',
});

/**
 * 标点检查专用的预处理:与 stripNonProse 剥离同样的片段,但把插值类占位符换成
 * 汉字替身而非空格,理由见 PROSE_PLACEHOLDER。
 *
 * 传入**原始文案**,不要传 stripNonProse 的结果——那样插值信息已经丢了。
 */
export function normalizeForPunctuation(text) {
  return text
    // 两个插值之间的标点是**格式分隔符**,不是正文标点:`{{minutes}}:{{seconds}}` 是时间、
    // `{{label}}: {{path}}` 是「标签: 路径」。它该用半角还是全角取决于运行期填进去的值,
    // 静态扫描判不了,所以整类排除——先把这类标点换成空格,再做插值替换。
    .replace(/\}\}\s*[,:;!?]\s*\{\{/g, '}} {{')
    .replace(/\{\{[^}]*\}\}/g, PROSE_PLACEHOLDER)
    .replace(/<\/?\d+>/g, PROSE_PLACEHOLDER)
    .replace(/\$t\([^)]*\)/g, PROSE_PLACEHOLDER)
    // URL / 邮箱在标点检查里也要留下正文边界。
    //
    // TOKEN_TAIL 已经正确地把 `https://x.test,返回` 的逗号留在了外面,但若把 token 换成
    // 空格,就变成「 ,返回」——逗号前面是空格,findHalfWidthPunct 认不出左边界,违规照样
    // 漏掉。对读者来说 URL 渲染出来就是正文的一部分,和插值一样该用汉字替身。
    //
    // 注意只有**紧跟「半角标点 + CJK」**的 token 才替换成汉字替身:其余情形仍替换为空格,
    // 否则 `config.json:` 这类路径分隔符会被当成正文标点误报(FILENAME_TOKEN 同理,
    // 它永远替空格)。
    //
    // lookahead 里必须带 CJK,不能只写 [,;:!?]:token 匹配是贪婪的,只要 lookahead 能满足
    // 就会回溯出更短的匹配——`https://a.test/x?ids=1,2` 会被切在 query string 内部的逗号处,
    // 于是那个逗号被误判成正文标点。带上 CJK 后与 TOKEN_TAIL 自身的截断条件一致,不会回溯。
    .replace(new RegExp(`${URL_TOKEN.source}(?=[,;:!?]\\s*[${CJK_CHAR}])`, 'gi'), PROSE_PLACEHOLDER)
    .replace(new RegExp(`${EMAIL_TOKEN.source}(?=[,;:!?]\\s*[${CJK_CHAR}])`, 'g'), PROSE_PLACEHOLDER)
    // 文件名同理:`编辑 config.json,然后重试` 里的逗号是正文标点,把文件名换成空格
    // 就没有左边界、违规漏检。仍然只在「紧跟半角标点 + CJK」时才用汉字替身,
    // 所以 `config.json:12` 这类路径/行号里的冒号不受影响。
    .replace(
      new RegExp(`${FILENAME_TOKEN.source}(?=[,;:!?]\\s*[${CJK_CHAR}])`, 'g'),
      PROSE_PLACEHOLDER,
    )
    .replace(URL_TOKEN, ' ')
    .replace(EMAIL_TOKEN, ' ')
    .replace(FILENAME_TOKEN, ' ');
}

/** 汉字后紧跟半角标点时返回该标点,否则 null。 */
export function findHalfWidthPunct(text) {
  const m = text.match(HALF_WIDTH_AFTER_HAN);
  if (m) return m[0].slice(-1);
  if (!HAS_CJK.test(text)) return null;
  const m2 = text.match(HALF_WIDTH_IN_CJK_PROSE);
  return m2 ? m2[0].trimEnd().slice(-1) : null;
}

/** 是否含半角三点省略号。 */
export function hasAsciiEllipsis(text) {
  return ASCII_ELLIPSIS.test(text);
}
