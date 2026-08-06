/**
 * 第三层：**正则红线扫描**（兜底抹除敏感片段）。
 *
 * 原则：**宁可多抹，不可漏**。over-redact 只影响排障效率，漏抹是隐私事故。
 *
 * ⚠️ 规则只增不减。放宽任何一条（缩小匹配范围、提高最小长度、去掉某个形态）都视为
 * 隐私变更，需要重新评审（需求 §5.6）。
 *
 * 按**形态**写规则而不是按厂商：厂商清单永远滞后于新出现的 key 形态，而形态（前缀 +
 * 长度 + 字符集）是相对稳定的。发现新形态即补规则。
 *
 * 顺序有意义：先抹「整头 / 整值」（Authorization、敏感字段名的值），再抹「独立形态」
 * （JWT、各家 key），最后抹「结构位置」（URL query 值）与「个人标识」（邮箱、家目录
 * 用户名）。反过来会让先被局部替换的片段躲开后面本该整段抹掉的规则。
 */

/** 一条脱敏规则。`name` 会出现在替换文本里，便于排障时看出被抹了什么类别。 */
interface RedactRule {
  name: string;
  pattern: RegExp;
  /** 替换函数：默认整段替换；需要保留结构（参数名、域名等）的规则自定义。 */
  replace: (...args: string[]) => string;
}

function tag(name: string): string {
  return `<redacted:${name}>`;
}

/**
 * 敏感字段名。三种书写形态都要覆盖：
 *   裸 JSON      `"token":"abc"`
 *   被转义的 JSON `\"token\":\"abc\"`   ← 日志里把 JSON 字符串化过一次就是这个样子
 *   k=v / k: v    `token=abc` / `token: abc`
 */
const SENSITIVE_FIELD_NAMES =
  'password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|access[_-]?key[_-]?id|' +
  'secret[_-]?access[_-]?key|refresh[_-]?token|access[_-]?token|id[_-]?token|client[_-]?secret|' +
  'private[_-]?key|credential|credentials|authorization|cookie|session[_-]?key';

/** 鉴权 / Cookie 类整头。值一律整段抹掉，不保留任何前缀片段。 */
const AUTH_HEADER_NAMES = 'authorization|proxy-authorization|cookie|set-cookie|x-api-key';

/**
 * 鉴权 scheme 关键字（HTTP `Authorization` 的 scheme + 常见 bot / 云厂商形态）。
 *
 * 存在的理由：这些形态里 **scheme 与凭证之间有一个空格**，而 `sensitive-field-kv` 的值
 * 取到空白为止——于是 `token=Bearer <opaque>` 只会被抹掉 `Bearer` 这个词，凭证本体原样
 * 留在上报正文里（2026-08-04 review P1）。命中 scheme 时必须一路抹到行尾。
 */
const AUTH_SCHEMES = 'Bearer|Basic|Digest|Negotiate|NTLM|Token|Bot|ApiKey|AWS4-HMAC-SHA256';

const RULES: readonly RedactRule[] = [
  // ── 整头 / 整值 ────────────────────────────────────────────────────────────
  {
    // header 形态：`Authorization: Bearer xxx` / `Cookie: a=b; c=d`
    // 值**一直取到行尾**（`[^\n]*`），不在 ` | ` / `, ` 这类分隔符处停。
    // 这是有意的 over-redact：日志行常把多个字段拼在一行，若在分隔符处收手，
    // 「Authorization 后面紧跟的那半截令牌」就会留在正文里。多抹掉同行后面的无关字段
    // 只影响排障效率，漏抹是隐私事故。
    name: 'auth-header',
    pattern: new RegExp(`\\b(${AUTH_HEADER_NAMES})\\s*:\\s*[^\\n]*`, 'gi'),
    replace: (_m, name: string) => `${name}: ${tag('auth-header')}`,
  },
  {
    // 引号包起来的**字段名**(允许 x-/厂商前缀,名以敏感词结尾);分隔符在**闭合引号之后**。
    // 覆盖 util.inspect 对象渲染 / (转义)JSON 里被整体引起来的键：
    //   `{ 'x-api-key': 'opaque' }`   `"x-api-key":"opaque"`   `\"x-api-key\":\"opaque\"`
    // 这形态四条老规则全都不命中(2026-08-06 review)：`auth-header` 要求名后**紧跟**冒号;
    // `sensitive-field-json` 要求引号**紧贴**敏感名、不容前缀(`x-`);`sensitive-field-quoted`
    // 与 `sensitive-field-kv` 要求名后紧跟分隔符,而这里名与分隔符之间夹着闭合引号。于是任意
    // `x-api-key` 值除非撞上某个厂商形态,否则原样留在上报正文里。
    // 放在其它字段规则**之前**:命中后值(连引号)整段抹掉,后面的规则看到的已是无引号占位符、
    // 不再重复处理。g2=键引号(可带转义反斜杠),g3=值引号(可选,值也可不带引号)。
    name: 'sensitive-field-quoted-key',
    pattern: new RegExp(
      `((\\\\?['"\`])[\\w-]*(?:${SENSITIVE_FIELD_NAMES})\\2\\s*[:=]\\s*)` +
        `(?:(\\\\?['"\`])(?:\\\\.|(?!\\3)[^\\n])*\\3|[^\\s&;,]+)`,
      'gi',
    ),
    replace: (_m, keyPart: string) => `${keyPart}${tag('sensitive-field')}`,
  },
  {
    // 裸 JSON / 转义 JSON：`"token":"abc"` / `\"token\":\"abc\"`
    // `\\\\?` 吃掉可选的转义反斜杠;值里允许出现被转义的引号。
    name: 'sensitive-field-json',
    pattern: new RegExp(
      `(\\\\?"(?:${SENSITIVE_FIELD_NAMES})\\\\?"\\s*:\\s*\\\\?")(?:[^"\\\\]|\\\\.)*(\\\\?")`,
      'gi',
    ),
    replace: (_m, head: string, tail: string) => `${head}${tag('sensitive-field')}${tail}`,
  },
  {
    // 敏感字段名 + 鉴权 scheme：`authorization=Bearer xxx` / `token: Basic xxx`。
    // **必须排在 sensitive-field-kv 之前**：那条规则的值取到空白为止，会只抹掉 `Bearer`
    // 这个词而把凭证本体留下；而独立的 `bearer` 规则排在它之后，等它跑到时 `Bearer`
    // 前缀已经被替换掉、正则再也匹配不上，凭证于是全程无人处理（2026-08-04 review P1）。
    //
    // 值一路取到**行尾**，与 auth-header 同款 over-redact：`AWS4-HMAC-SHA256` 这类
    // scheme 的凭证本身就带逗号和空格，在任何分隔符处收手都会漏。
    name: 'sensitive-field-auth-scheme',
    pattern: new RegExp(
      `\\b(${SENSITIVE_FIELD_NAMES})\\s*[:=]\\s*(?:${AUTH_SCHEMES})\\b[^\\n]*`,
      'gi',
    ),
    replace: (_m, name: string) => `${name}=${tag('sensitive-field')}`,
  },
  {
    // util.format 渲染对象时值**带引号**：`{ token: 'opaqueSecret' }` 在 main 日志里就是
    // `token: 'opaqueSecret'`（键无引号、值单引号；含单引号时 Node 会换双引号或反引号）。
    // 这形态两头不着：`sensitive-field-json` 要求键带双引号，不命中；`sensitive-field-kv`
    // 的值类 `[^\s&;,"']` 把引号排除在外，遇到引号开头一个字符都匹配不到 —— 于是这个**最
    // 常见的对象渲染形态**反而漏网（2026-08-04 review P1）。这条专吃「引号包起来的值」，
    // 连引号带内容整段抹掉，匹配到成对的闭合引号（`\\.` 吃转义，`(?!\\2)` 防止跨过闭合引号）。
    // 放在 kv 之前（kv 是无引号兜底）、auth-scheme 之后（后者管无引号的 `=Bearer xxx`）。
    name: 'sensitive-field-quoted',
    pattern: new RegExp(
      `\\b(${SENSITIVE_FIELD_NAMES})\\s*[:=]\\s*(['"\`])(?:\\\\.|(?!\\2)[^\\n])*\\2`,
      'gi',
    ),
    replace: (_m, name: string) => `${name}=${tag('sensitive-field')}`,
  },
  {
    // k=v / k: v（非 JSON、值不带引号）。值取到空白、`&`、`;`、`,`、`"`、`'` 为止。
    name: 'sensitive-field-kv',
    pattern: new RegExp(`\\b(${SENSITIVE_FIELD_NAMES})\\s*[:=]\\s*([^\\s&;,"']+)`, 'gi'),
    replace: (_m, name: string) => `${name}=${tag('sensitive-field')}`,
  },

  // ── 独立形态 ──────────────────────────────────────────────────────────────
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    replace: () => tag('jwt'),
  },
  {
    name: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
    replace: () => `Bearer ${tag('bearer')}`,
  },
  {
    // OpenAI / Anthropic 系：sk- / sk-ant- / sk-proj-
    name: 'sk-key',
    pattern: /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g,
    replace: () => tag('sk-key'),
  },
  {
    // GitHub：ghp_ / gho_ / ghu_ / ghs_ / ghr_ / github_pat_
    name: 'github-token',
    pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g,
    replace: () => tag('github-token'),
  },
  {
    // 云厂商 AccessKey / API key：阿里云 LTAI、AWS AKIA/ASIA、Google AIza、Slack xox*
    name: 'cloud-access-key',
    pattern:
      /\b(?:LTAI[A-Za-z0-9]{12,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,})/g,
    replace: () => tag('cloud-access-key'),
  },
  {
    // PEM 私钥块。两个分支的顺序有意义:先尝试匹配完整块(BEGIN…END),匹配不到才退化成
    // 「从 BEGIN 一直吞到底」。写成单个带可选 END 的懒惰模式是错的 —— 懒惰量词会在
    // 可选组零宽命中处立刻收手,只抹掉块头、把密钥正文原样留在日志里(本条曾如此)。
    // 吞到底的分支是有意的:日志里被截断的半个私钥块同样不能出现。
    name: 'private-key-block',
    pattern:
      /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----|-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*/g,
    replace: () => tag('private-key-block'),
  },

  // ── 结构位置 ──────────────────────────────────────────────────────────────
  {
    // URL query 参数值：保留参数名、值一律替换。
    // 搜索关键词等用户输入常出现在这里,而参数名对排障已经足够。
    // 只在 `?`/`&` 之后、`=` 之前有参数名时命中,避免误伤普通的 `a=b` 文本。
    name: 'url-query-value',
    pattern: /([?&][A-Za-z0-9_.-]+=)([^\s&#"'<>]+)/g,
    replace: (_m, head: string) => `${head}${tag('url-query-value')}`,
  },

  // ── 个人标识 ──────────────────────────────────────────────────────────────
  {
    // 邮箱：保留首字母与域名,让排障能关联「同一用户的多行日志」而不知道是谁。
    // 与 logger.maskEmail 同口径。
    name: 'email',
    pattern: /\b([A-Za-z0-9])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    replace: (_m, first: string, domain: string) => `${first}***${domain}`,
  },
  {
    // 家目录里的用户名段:保留路径其余部分供排查。
    // 三种平台形态各一条分支;`<user>` 是固定占位,不是 <redacted:…> —— 这里抹的是
    // 「谁」而不是「一段秘密」,保持路径可读性对排障有实际价值。
    name: 'home-user-segment',
    pattern: /(\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([^/\\\s:*?"<>|]+)/g,
    replace: (_m, prefix: string) => `${prefix}<user>`,
  },
];

/**
 * 对一段正文跑完整套红线规则。
 *
 * `homeDir` 可选：传入时额外把其中的真实用户名做一次精确替换。上一条路径规则只覆盖
 * 标准家目录形态，而用户名也可能出现在别的位置（例如 `C:\Work\<name>\…` 这类自定义
 * 路径，或 Windows 域账号串）。只在长度 ≥ 3 时做，避免把一个两字母用户名在全文里
 * 乱替换。
 */
export function redact(text: string, homeDir?: string): string {
  let out = text;
  for (const rule of RULES) {
    // 每条规则都用自己的 lastIndex：正则带 g，复用同一个对象跨调用会串状态。
    out = out.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replace as never);
  }
  const userName = homeUserName(homeDir);
  if (userName && userName.length >= 3) {
    out = out.split(userName).join('<user>');
  }
  return out;
}

/** 从家目录路径里取末段用户名。取不到返回 null。 */
export function homeUserName(homeDir?: string): string | null {
  if (!homeDir) return null;
  const parts = homeDir.split(/[/\\]/).filter((s) => s.length > 0);
  const last = parts.at(-1);
  return last && last.length > 0 ? last : null;
}

export const __testing = { RULES, SENSITIVE_FIELD_NAMES, AUTH_HEADER_NAMES, AUTH_SCHEMES };
