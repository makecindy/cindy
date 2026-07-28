/**
 * 从 i18n/glossary.json 渲染人读版 GLOSSARY.md。
 *
 * 抽成共享模块的原因:generate-glossary-doc.mjs 用它生成,check-i18n-glossary.mjs
 * 用同一份逻辑校验「文档是否与术语表同步」。两边共用一个渲染函数,才不会出现
 * 「校验说同步了、实际生成出来不一样」的假绿。
 */

/** 术语表在人读文档里的展示顺序:已裁决在前(按 id),待讨论在后(按 id)。 */
function sortTerms(terms) {
  return [...terms].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'decided' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * 单元格转义:markdown 表格里的 | 会破坏列结构。
 * 反斜杠必须**先**转义,否则原文里的 `\` 会与后面补上的转义符结合成新的转义序列
 * (CodeQL: incomplete string escaping)。
 */
function cell(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

/** 译法展示:译法与 en 相同即「保留英文原词」,标注出来。 */
function renderTranslation(term, locale) {
  const value = term.translations?.[locale];
  if (!value) return '—';
  if (value === term.en) return `\`${value}\`（保留英文）`;
  return value;
}

/** 禁用词条目可能是字符串（无条件）或 { text, whenEn }（仅当英文源匹配时禁用）。 */
function forbiddenLabel(entry) {
  if (typeof entry === 'string') return entry;
  return `${entry.text}（仅当英文含 ${entry.whenEn}）`;
}

/**
 * 归一化行尾,供「已落盘的 GLOSSARY.md」与「渲染结果」比较时使用。
 *
 * renderGlossaryDoc 恒以 LF 收尾(见函数末尾的 join('\n')),但 .gitattributes
 * 未给 *.md 固定 eol——`core.autocrlf=true` 的 Windows checkout(Git for Windows
 * 安装时的默认选项)会把 GLOSSARY.md 转成 CRLF。此时逐字符比较会假报「文档过期」,
 * 而且无法自愈:重新生成写出的是 LF,下次 checkout 又被转回 CRLF,门禁永远红。
 *
 * 与 apps/desktop/scripts/help-kb-guard.mjs 的 norm() 同款处理。放在共享模块里
 * 是为了让三处比较点(本文件的消费方 generate-glossary-doc.mjs --check、
 * check-i18n-glossary.mjs、glossary-rules.test.mjs)用同一份逻辑,不会出现某处
 * 漏加归一化又把 Windows 拦回去。
 */
export function normalizeDocEol(text) {
  return text.replace(/\r\n/g, '\n');
}

export function renderGlossaryDoc(glossary) {
  const terms = sortTerms(glossary.terms);
  const decided = terms.filter((t) => t.status === 'decided');
  const proposed = terms.filter((t) => t.status === 'proposed');
  const locales = glossary.locales.filter((l) => l !== glossary.sourceLocale);

  const lines = [];

  lines.push('<!-- 本文件由 scripts/generate-glossary-doc.mjs 自动生成，请勿手改。 -->');
  lines.push('<!-- 修改术语请编辑 i18n/glossary.json，然后运行 pnpm i18n:glossary-doc。 -->');
  lines.push('');
  lines.push('# Cindy 术语表');
  lines.push('');
  lines.push(
    '产品术语的唯一事实源。**新增或修改任何 UI 文案前先查这里**——同一个概念在不同界面译法不一致，' +
      '是用户能直接看见的质量问题。',
  );
  lines.push('');
  lines.push('> **这是一份参考，不是替换表。**');
  lines.push('>');
  lines.push('> 表里的「译法」是默认情况下的选择，不是「见到 A 就换成 B」的映射。同一个中文词往往');
  lines.push('> 对应多个英文概念——「额度」同时是 Balance / Quota / Credits 的正确译法，「代理」同时是');
  lines.push('> Agent / Subagent / Proxy 的译法——具体这一条文案该怎么译，取决于它的英文源和这个 key');
  lines.push('> 的实际用途。');
  lines.push('>');
  lines.push('> 所以：**禁止拿本表做脚本批量替换**。门禁只报告「这里用了禁用译法」并给出英文源，');
  lines.push('> 不给替换目标；改哪一条、改成什么，逐条读语境决定。');
  lines.push('');
  lines.push('- 数据正本：`i18n/glossary.json`（本文件由它生成）');
  lines.push('- 自动门禁：`pnpm check:i18n-glossary`（随 CI 阻断）');
  lines.push('- 存量豁免：`i18n/glossary-baseline.json`（只减不增）');
  lines.push('');

  lines.push('## 已裁决术语');
  lines.push('');
  if (decided.length === 0) {
    lines.push('（暂无）');
  } else {
    lines.push('这些术语的译法已定，**违反会阻断 CI**。');
    lines.push('');
    lines.push(`| 英文 | ${locales.join(' | ')} | 禁用译法 |`);
    lines.push(`| --- | ${locales.map(() => '---').join(' | ')} | --- |`);
    for (const term of decided) {
      const cells = locales.map((l) => cell(renderTranslation(term, l)));
      const forbidden = Object.entries(term.forbidden ?? {})
        .flatMap(([loc, words]) => words.map((w) => `${loc}: ${forbiddenLabel(w)}`))
        .join('；');
      lines.push(`| **${cell(term.en)}** | ${cells.join(' | ')} | ${cell(forbidden) || '—'} |`);
    }
    lines.push('');
    const withVariants = decided.filter((t) =>
      Object.values(t.alsoAllowed ?? {}).some((list) => list.length > 0),
    );
    if (withVariants.length > 0) {
      lines.push('### 分场合译法');
      lines.push('');
      lines.push('同一个词在不同语境下有不同说法。下面这些是**允许的**，按场合选，不会被门禁拦截。');
      lines.push('');
      lines.push('| 英文 | 语言 | 译法 | 什么场合 |');
      lines.push('| --- | --- | --- | --- |');
      for (const term of withVariants) {
        for (const [locale, list] of Object.entries(term.alsoAllowed ?? {})) {
          const primary = term.translations?.[locale];
          if (primary) {
            lines.push(`| **${cell(term.en)}** | ${locale} | ${cell(primary)} | 默认 |`);
          }
          for (const variant of list) {
            lines.push(`| ${cell(term.en)} | ${locale} | ${cell(variant.text)} | ${cell(variant.when)} |`);
          }
        }
      }
      lines.push('');
    }

    lines.push('### 裁决理由');
    lines.push('');
    for (const term of decided) {
      lines.push(`- **${term.en}** — ${term.note}`);
      if (term.exempt?.length) {
        lines.push(`  - 豁免范围：${term.exempt.map((e) => `\`${e}\``).join('、')}`);
      }
    }
  }
  lines.push('');

  lines.push('## 待讨论术语');
  lines.push('');
  if (proposed.length === 0) {
    lines.push('（暂无——所有已登记术语都已裁决）');
  } else {
    lines.push(
      '这些术语现状不一致但**尚未拍板**，guard 只告警不阻断。' +
        '裁决后把 `i18n/glossary.json` 里对应条目的 `status` 改为 `decided`、补上 `translations`。',
    );
    lines.push('');
    lines.push(
      '**注意别指望 `--update-baseline` 帮你收尾。** `proposed` 存在的理由正是「已知有存量不一致」，' +
        '改成 `decided` 的那一刻这些告警会变成阻断违规；而 `--update-baseline` 只删不加，' +
        '遇到 baseline 里没有的指纹会直接拒绝。所以裁决时只有两条路：' +
        '要么把命中逐条读语境改掉，要么先人工把已 review 过的指纹写进 ' +
        '`i18n/glossary-baseline.json` 冻结存量，之后再用 `--update-baseline` 做修剪。',
    );
    lines.push('');
    for (const term of proposed) {
      lines.push(`### ${term.en}`);
      lines.push('');
      lines.push(term.note);
      const forbidden = Object.entries(term.forbidden ?? {})
        .flatMap(([loc, words]) => words.map((w) => `\`${forbiddenLabel(w)}\`（${loc}）`))
        .join('、');
      if (forbidden) {
        lines.push('');
        lines.push(`已确定禁用：${forbidden}`);
      }
      lines.push('');
    }
  }

  lines.push('## 怎么加一条术语');
  lines.push('');
  lines.push('1. 在 `i18n/glossary.json` 的 `terms` 里加条目，`note` 必填——写清楚**为什么**这么定，');
  lines.push('   否则后人会反复推翻它。');
  lines.push('2. 拿不准时先设 `status: "proposed"`，让 guard 把现状规模统计出来再讨论。');
  lines.push('3. 跑 `pnpm i18n:glossary-doc` 重新生成本文件。');
  lines.push('4. 跑 `pnpm check:i18n-glossary` 看新规则命中多少存量，逐条核对后清理干净。');
  lines.push('   `--update-baseline` **只删不加**——它会拒绝登记新违规；确需冻结一批存量时');
  lines.push('   手动编辑 `i18n/glossary-baseline.json`，让新增条目出现在 diff 里被 review 看到。');
  lines.push('5. 把 `proposed` 提升为 `decided` 时也是这一条：`proposed` 存在的理由正是「已知有存量');
  lines.push('   不一致」，改成 `decided` 的那一刻这些告警全部变成阻断违规。因为 `--update-baseline`');
  lines.push('   **只删不加**，此时只有两条路——逐条读语境改掉，或先人工把已 review 过的指纹写进');
  lines.push('   baseline，之后再用 `--update-baseline` 做修剪。');
  lines.push('');
  lines.push('## 清理存量：不要用脚本批量替换');
  lines.push('');
  lines.push('guard 只能告诉你「这个词不该用」，回答不了「该换成哪个」——目标译法取决于该 key 的');
  lines.push('英文源，而 sed / 正则看不见语境。**逐条读英文源再决定**。');
  lines.push('');
  lines.push('「额度」同时是 Balance / Quota / Credits 三个英文源的正确译法，「代理」同时是');
  lines.push('Agent / Subagent / Proxy 的译法——无条件替换必然改错其中两类。这类词要用条件禁用');
  lines.push('`{ text, whenEn }` 按英文源拆开，让每条规则的目标译法唯一；目标不唯一的禁用词');
  lines.push('就是误译的温床。');
  lines.push('');
  lines.push('还要当心外部产品的既定术语被产品术语盖掉：macOS 系统设置面板名日文是');
  lines.push('「オートメーション」而非产品的「自動化」，照改会让用户在系统设置里找不到授权项。');
  lines.push('这类走 `exempt`。');
  lines.push('');
  lines.push('**误报排查**：guard 已剥离 `{{插值}}`、URL、文件名，并把连字符视作词边界');
  lines.push('（`ssh-agent` 不会被判成产品 `Agent`）。仍需放行时用 `exempt`：完整路径精确匹配，');
  lines.push('或以 `.` 结尾的子树前缀。同形异义（SSH agent vs 产品 Agent）走 `exempt` 并在 `note` 里写明。');
  lines.push('');

  return `${lines.join('\n')}\n`;
}
