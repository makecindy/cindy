/**
 * 术语表 guard 规则函数的单测。
 *
 * 这里每一条断言都对应一个真实踩过的坑或一条有数据依据的裁决,不是为覆盖率凑数:
 * 误报会让门禁被绕过或被关掉,漏报会让门禁形同虚设,两边都要钉住。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ELLIPSIS_LOCALES,
  HALFWIDTH_PUNCT_LOCALES,
  FULL_WIDTH_PUNCT,
  findCaseMismatch,
  findHalfWidthPunct,
  hasAsciiEllipsis,
  makeExemptChecker,
  occursIn,
  stripNonProse,
  normalizeForPunctuation,
  countOccurrences,
  countHalfWidthPunct,
  countCaseMismatches,
  caseStandardFor,
  sourceMentions,
  makeSourceTermMatcher,
} from '../shared/glossary-rules.mjs';
import { validateAgainstSchema } from '../shared/json-schema-lite.mjs';
import { renderGlossaryDoc } from '../shared/glossary-doc.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// ---------------------------------------------------------------------------
// occursIn:词边界
// ---------------------------------------------------------------------------

test('occursIn: 连字符复合词不算命中(ssh-agent ≠ 产品 Agent)', () => {
  // 这是引入 guard 时最大的一批假阳性来源:SSH 密钥代理与产品 Agent 同形但无关。
  assert.equal(occursIn('密钥已加载到 ssh-agent', 'agent'), false);
  assert.equal(occursIn('检查 user-agent 头', 'agent'), false);
  assert.equal(occursIn('字段 agent_id 缺失', 'agent'), false);
  // 独立成词时必须命中,否则门禁形同虚设。
  assert.equal(occursIn('展开 agent 设置', 'agent'), true);
});

test('occursIn: 允许复数但不误伤更长的标识符', () => {
  assert.equal(occursIn('更多 Plugin 操作', 'Plugin'), true);
  assert.equal(occursIn('已安装 Plugins', 'Plugin'), true);
  assert.equal(occursIn('PluginRegistry 初始化', 'Plugin'), false);
});

test('occursIn: 中文术语按子串匹配(无词边界概念)', () => {
  assert.equal(occursIn('这是代理设置', '代理'), true);
  assert.equal(occursIn('这是插件设置', '代理'), false);
});

test('occursIn: 大小写敏感 —— forbidden 区分 Plugin 与 plugin', () => {
  assert.equal(occursIn('更多 plugin 操作', 'Plugin'), false);
});

// ---------------------------------------------------------------------------
// stripNonProse:剥离非文案片段
// ---------------------------------------------------------------------------

test('stripNonProse: 剥离 i18next 插值,避免变量名与术语同形误报', () => {
  // {{project}} 是变量名,不是展示给用户的「Project」字样。
  assert.equal(occursIn(stripNonProse('在 {{project}} 中新建'), 'project'), false);
  assert.equal(occursIn(stripNonProse('该 Project 下的会话'), 'Project'), true);
});

test('stripNonProse: 剥离 URL、邮箱与文件名', () => {
  assert.equal(occursIn(stripNonProse('打开 https://x.com/agent/list'), 'agent'), false);
  assert.equal(occursIn(stripNonProse('读取 project.json 失败'), 'project'), false);
  assert.equal(occursIn(stripNonProse('联系 agent@example.com'), 'agent'), false);
});

test('stripNonProse: 剥离 Trans 占位与 $t 引用', () => {
  assert.equal(stripNonProse('前<0>中</0>后').includes('<0>'), false);
  assert.equal(stripNonProse('$t(common.agent) 之后').includes('$t('), false);
});

// ---------------------------------------------------------------------------
// findCaseMismatch:大小写形态
// ---------------------------------------------------------------------------

test('findCaseMismatch: 命中错误形态时返回实际拼写,正确时返回 null', () => {
  assert.equal(findCaseMismatch('归档 worker', 'Worker'), 'worker');
  assert.equal(findCaseMismatch('归档 Worker', 'Worker'), null);
  assert.equal(findCaseMismatch('归档 WORKER', 'Worker'), 'WORKER');
});

test('findCaseMismatch: 复数形态归一后再比对,不误报 Workers', () => {
  assert.equal(findCaseMismatch('所有 Workers 已停止', 'Worker'), null);
  assert.equal(findCaseMismatch('所有 workers 已停止', 'Worker'), 'worker');
});

test('findCaseMismatch: 连字符复合词同样豁免', () => {
  assert.equal(findCaseMismatch('service-worker 已注册', 'Worker'), null);
});

test('findCaseMismatch: 扫描全部匹配,不因首个正确就漏掉后面的错误形态', () => {
  // #389 两位 reviewer 同标 P1:非全局 match 只看第一个匹配,首个正确即返回 null,
  // 后面的错误形态永远进不了报告,能一路漏到 UI。
  assert.equal(findCaseMismatch('创建 Worker 后，该 worker 会自动启动', 'Worker'), 'worker');
  assert.equal(findCaseMismatch('Agent 与另一个 agent 协作', 'Agent'), 'agent');
  // 全部正确时仍应返回 null,不能因为改成全局匹配就误报。
  assert.equal(findCaseMismatch('创建 Worker 后，该 Worker 会自动启动', 'Worker'), null);
});

// ---------------------------------------------------------------------------
// makeExemptChecker:豁免
// ---------------------------------------------------------------------------

test('makeExemptChecker: 完整路径精确匹配', () => {
  const isExempt = makeExemptChecker(['desktop:settings.a.b']);
  assert.equal(isExempt('desktop:settings.a.b'), true);
  assert.equal(isExempt('desktop:settings.a.c'), false);
});

test('makeExemptChecker: 以点结尾的子树前缀豁免整段', () => {
  const isExempt = makeExemptChecker(['desktop:settings.remote.']);
  assert.equal(isExempt('desktop:settings.remote.keys.inAgent'), true);
  assert.equal(isExempt('desktop:settings.remoteControl.hook'), false, '前缀必须含点,不能误伤 remoteControl');
});

test('makeExemptChecker: 不支持按末段 key 名匹配', () => {
  // 按末段匹配会让任意同名嵌套 key 被静默放过,是 brand guard 明确记录过的教训。
  const isExempt = makeExemptChecker(['title']);
  assert.equal(isExempt('desktop:settings.a.title'), false);
});

test('makeExemptChecker: 空/缺省列表不豁免任何 key', () => {
  assert.equal(makeExemptChecker(undefined)('desktop:any.key'), false);
  assert.equal(makeExemptChecker([])('desktop:any.key'), false);
});

// ---------------------------------------------------------------------------
// 标点规则
// ---------------------------------------------------------------------------

test('findHalfWidthPunct: 只在汉字后触发', () => {
  assert.equal(findHalfWidthPunct('保存失败:原因'), ':');
  assert.equal(findHalfWidthPunct('授权失败,请重试'), ',');
  assert.equal(findHalfWidthPunct('保存失败：原因'), null);
  // 英文/数字后的半角标点是正常排版,不能报。
  assert.equal(findHalfWidthPunct('Error: not found'), null);
  assert.equal(findHalfWidthPunct('共 1,000 项'), null);
});

test('findHalfWidthPunct: 覆盖分号与问号叹号', () => {
  // 首轮只查了逗号冒号,清理时才发现分号 49 处、问号叹号 25 处是同类问题。
  assert.equal(findHalfWidthPunct('加载失败;请重试'), ';');
  assert.equal(findHalfWidthPunct('确定要删除吗?'), '?');
  assert.equal(findHalfWidthPunct('操作成功!'), '!');
  assert.equal(findHalfWidthPunct('加载失败；请重试'), null);
  assert.equal(findHalfWidthPunct('确定要删除吗？'), null);
});

test('FULL_WIDTH_PUNCT: 覆盖全部受检半角标点', () => {
  // 映射表缺项会让 hint 退化成「应使用全角「;」」这种自相矛盾的提示。
  for (const mark of [',', ':', ';', '!', '?']) {
    assert.ok(FULL_WIDTH_PUNCT[mark], `缺少 ${mark} 的全角映射`);
    assert.equal(findHalfWidthPunct(`中文${mark}`), mark);
    assert.equal(findHalfWidthPunct(`中文${FULL_WIDTH_PUNCT[mark]}`), null);
  }
});

test('标点规则的 locale 适用范围有数据依据', () => {
  // ja 实测半角冒号 124:78 才是主流(日文 UI 惯例),套用中文全角规则会制造大批假阳性。
  assert.equal(HALFWIDTH_PUNCT_LOCALES.has('zh-CN'), true);
  assert.equal(HALFWIDTH_PUNCT_LOCALES.has('ja'), false);
  assert.equal(HALFWIDTH_PUNCT_LOCALES.has('ko'), false);
  // 省略号三语一致以「…」为主流。
  for (const locale of ['zh-CN', 'ja', 'ko']) {
    assert.equal(ELLIPSIS_LOCALES.has(locale), true, `${locale} 应纳入省略号规则`);
  }
});

test('hasAsciiEllipsis: 识别三点省略号', () => {
  assert.equal(hasAsciiEllipsis('加载中...'), true);
  assert.equal(hasAsciiEllipsis('加载中…'), false);
});

// ---------------------------------------------------------------------------
// 术语表数据自身的完整性
// ---------------------------------------------------------------------------

const glossary = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'glossary.json'), 'utf8'));

test('glossary.json: id 唯一且格式合法', () => {
  const ids = glossary.terms.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, '术语 id 必须唯一——baseline 用它做锚点');
  for (const id of ids) {
    assert.match(id, /^[a-z0-9-]+$/, `id "${id}" 必须是 kebab-case`);
  }
});

test('glossary.json: 每条术语都有裁决理由', () => {
  for (const term of glossary.terms) {
    assert.ok(term.note?.trim(), `术语 ${term.id} 缺 note——没有理由的裁决会被后人反复推翻`);
  }
});

test('glossary.json: decided 术语必须给出所有非源语言的译法', () => {
  const targets = glossary.locales.filter((l) => l !== glossary.sourceLocale);
  for (const term of glossary.terms.filter((t) => t.status === 'decided')) {
    for (const locale of targets) {
      assert.ok(
        term.translations?.[locale]?.trim(),
        `已裁决术语 ${term.id} 缺 ${locale} 译法;拿不准应留在 status=proposed`,
      );
    }
  }
});

test('glossary.json: forbidden 不能与自己的标准译法冲突', () => {
  for (const term of glossary.terms) {
    for (const [locale, words] of Object.entries(term.forbidden ?? {})) {
      const standard = term.translations?.[locale];
      if (!standard) continue;
      const texts = words.map((w) => (typeof w === 'string' ? w : w.text));
      assert.ok(
        !texts.includes(standard),
        `术语 ${term.id} 在 ${locale} 把标准译法「${standard}」同时列为禁用,规则自相矛盾`,
      );
    }
  }
});

test('glossary.json: 声明的译法必须是现状主流，否则要写明为何有意偏离', () => {
  // 引入术语表时踩过的坑:ja/ko 的译法凭抽样几个 key 就定,结果 5 条是少数派,
  // 其中 quota 的 ko「쿼터」全仓零出现——纯属凭空造词。更糟的是 automation 的 ja
  // 把少数派同时写进 translations 与 forbidden,guard 于是输出「X 是禁用译法,应为 X」。
  // 这条断言把「你凭什么违反数据」显式化:占比不足 35% 就必须给理由。
  const MIN_RATIO = 0.35;
  const load = (locale) => {
    const out = new Map();
    const flatten = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj)) {
        const kp = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, kp);
        else if (typeof v === 'string') out.set(kp, v);
      }
    };
    flatten(
      JSON.parse(fs.readFileSync(path.join(ROOT, `apps/desktop/src/renderer/i18n/locales/${locale}/common.json`), 'utf8')),
      '',
    );
    return out;
  };

  const corpus = Object.fromEntries(glossary.locales.map((l) => [l, load(l)]));
  const problems = [];

  for (const term of glossary.terms) {
    if (term.status !== 'decided') continue;
    const escaped = term.en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![A-Za-z0-9_-])${escaped}s?(?![A-Za-z0-9_-])`, 'i');
    const keys = [...corpus[glossary.sourceLocale]].filter(([, v]) => re.test(v)).map(([k]) => k);
    if (keys.length < 8) continue; // 样本太小,占比没有统计意义

    for (const locale of glossary.locales) {
      if (locale === glossary.sourceLocale) continue;
      const declared = term.translations?.[locale];
      if (!declared) continue;
      // alsoAllowed 是同一裁决下的合法变体（Running 作谓语时用「正在运行」），
      // 计算主流度时必须算进来,否则分场合译法越多、越会被误判成"声明不是主流"。
      const accepted = [declared, ...(term.alsoAllowed?.[locale] ?? []).map((v) => v.text)];
      const hit = keys.filter((k) => {
        const value = corpus[locale].get(k);
        return value && accepted.some((a) => value.includes(a));
      }).length;
      const ratio = hit / keys.length;
      if (ratio >= MIN_RATIO) continue;
      if (term.minorityByDesign?.[locale]?.trim()) continue;
      problems.push(
        `${term.id}/${locale}: 声明「${declared}」只覆盖 ${hit}/${keys.length} ` +
          `(${Math.round(ratio * 100)}%)，既非主流又没写 minorityByDesign 理由`,
      );
    }
  }

  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('glossary.json: 同一 locale 下 forbidden 词不跨术语重复', () => {
  // 重复会让同一处违规被两个术语各报一次,baseline 也会存两条指纹。
  // 一个词只归属一个术语,其余条目在 note 里交叉引用(如「代理」统一登记在 proxy 下)。
  // 例外:带 whenEn 的条件禁用可以同词多登记——它们按英文源区分,替换目标唯一。
  // 「代理」正是如此:Agent / Subagent / Proxy 三个来源各登记一条,统一挂在某一条下
  // 反而会让自动替换无法确定该换成哪个词(2026-07 一次批量重放就因此产出「子 Proxy 模型」)。
  const owner = new Map();
  for (const term of glossary.terms) {
    for (const [locale, words] of Object.entries(term.forbidden ?? {})) {
      for (const entry of words) {
        const word = typeof entry === 'string' ? entry : entry.text;
        const scope = typeof entry === 'string' ? '' : `@${entry.whenEn}`;
        const slot = `${locale}\t${word}${scope}`;
        const prev = owner.get(slot);
        assert.equal(
          prev,
          undefined,
          `${locale} 的禁用词「${word}」同时登记在 ${prev} 与 ${term.id} 下,会造成重复报告`,
        );
        owner.set(slot, term.id);
      }
    }
  }
});

test('glossary.json: exempt 路径带来源前缀,不是裸 key', () => {
  for (const term of glossary.terms) {
    for (const item of term.exempt ?? []) {
      assert.match(
        item,
        /^(desktop|mobile\/[a-zA-Z]+):.+$/,
        `术语 ${term.id} 的豁免 "${item}" 缺来源前缀(desktop: / mobile/<ns>:)`,
      );
    }
  }
});

test('glossary.json: locales 与 desktop SUPPORTED_LOCALES 一致', () => {
  const localeTs = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/shared/locale.ts'), 'utf8');
  const match = localeTs.match(/SUPPORTED_LOCALES\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, '无法从 locale.ts 解析 SUPPORTED_LOCALES');
  const supported = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(
    [...glossary.locales].sort(),
    [...supported].sort(),
    '术语表覆盖的语言必须与 SUPPORTED_LOCALES 一致,新增语言时两处一起改',
  );
});

// ---------------------------------------------------------------------------
// 文档同步
// ---------------------------------------------------------------------------

test('GLOSSARY.md 与 glossary.json 同步', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'i18n', 'GLOSSARY.md'), 'utf8');
  assert.equal(
    doc,
    renderGlossaryDoc(glossary),
    'i18n/GLOSSARY.md 已过期,运行 pnpm i18n:glossary-doc 重新生成',
  );
});

// ---------------------------------------------------------------------------
// baseline 完整性
// ---------------------------------------------------------------------------

test('glossary-baseline.json: 条目格式合法且无重复', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'glossary-baseline.json'), 'utf8'));
  const entries = baseline.entries ?? [];
  assert.equal(new Set(entries).size, entries.length, 'baseline 不应有重复条目');
  for (const entry of entries) {
    const parts = entry.split('\t');
    // 五段:locale / key / rule / detail / 文案摘要。摘要是后加的(见 makeViolation 注释),
    // 断言必须跟上——baseline 当前为空会让这条空转通过,而第一条真条目就会让
    // pnpm test:unit 失败,把 baseline 流程整个卡死。
    assert.equal(
      parts.length,
      5,
      `baseline 条目 "${entry}" 应为 locale\\tkey\\trule\\tdetail\\tdigest 五段`,
    );
    assert.ok(glossary.locales.includes(parts[0]), `baseline 条目语言 "${parts[0]}" 不在术语表 locales 内`);
    assert.match(parts[4], /^[0-9a-f]{12}$/, `baseline 条目摘要格式不对: ${parts[4]}`);
  }
});

// ---------------------------------------------------------------------------
// schema 校验器
//
// 子集校验器的价值全在「拼错字段能被抓住」和「schema 加了新关键字不会被静默忽略」
// 这两条上。两条都塌了的话,它比没有更危险——看起来有校验,实际全绿放行。
// ---------------------------------------------------------------------------

test('validateAgainstSchema: 正本必须符合自己的 schema', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'glossary.schema.json'), 'utf8'));
  assert.deepEqual(validateAgainstSchema(glossary, schema), []);
});

test('validateAgainstSchema: 拼错的字段名被判为未知字段', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { forbidden: { type: 'array', items: { type: 'string' } } },
  };
  const errors = validateAgainstSchema({ forbiden: ['会话'] }, schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /forbiden/);
});

test('validateAgainstSchema: 校验 required / enum / pattern / oneOf', () => {
  const schema = {
    type: 'object',
    required: ['id', 'status'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: '^[a-z0-9-]+$' },
      status: { enum: ['decided', 'proposed'] },
      forbidden: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              required: ['text', 'whenEn'],
              additionalProperties: false,
              properties: { text: { type: 'string' }, whenEn: { type: 'string' } },
            },
          ],
        },
      },
    },
  };
  assert.deepEqual(validateAgainstSchema({ id: 'session', status: 'decided' }, schema), []);
  assert.match(validateAgainstSchema({ id: 'session' }, schema).join(), /缺少必填字段 "status"/);
  assert.match(validateAgainstSchema({ id: 'Session', status: 'decided' }, schema).join(), /不匹配/);
  assert.match(validateAgainstSchema({ id: 'a', status: 'decied' }, schema).join(), /取值必须是/);
  // 条件禁用少写 whenEn 时,两个 oneOf 分支都不匹配
  assert.match(
    validateAgainstSchema({ id: 'a', status: 'decided', forbidden: [{ text: '代理' }] }, schema).join(),
    /oneOf/,
  );
});

test('validateAgainstSchema: schema 用了未实现的关键字必须报错而非忽略', () => {
  assert.throws(
    () => validateAgainstSchema({}, { type: 'object', anyOf: [{ type: 'object' }] }),
    /未实现的关键字 "anyOf"/,
  );
});

// ---------------------------------------------------------------------------
// 标点检查的插值边界
//
// stripNonProse 把 {{插值}} 换成空格,于是插值后面的半角标点前是空格而非汉字,
// 整类违规被静默放过（reportCache 的 `{{total}},上限` 就是这样漏掉的）。
// 标点检查必须走 normalizeForPunctuation。
// ---------------------------------------------------------------------------

test('normalizeForPunctuation: 插值后的半角标点能被检出', () => {
  const raw = '已缓存 {{total}},上限 {{limit}};清掉后会重新拉取。';
  assert.equal(findHalfWidthPunct(stripNonProse(raw)), null, '这正是原先漏检的成因');
  assert.equal(findHalfWidthPunct(normalizeForPunctuation(raw)), ',');
});

test('normalizeForPunctuation: 两个插值之间的标点是格式分隔符,不判违规', () => {
  // 该用半角还是全角取决于运行期填进去的值,静态扫描判不了,整类排除
  for (const raw of ['二维码将在 {{minutes}}:{{seconds}} 后过期', '{{label}}: {{path}}']) {
    assert.equal(findHalfWidthPunct(normalizeForPunctuation(raw)), null, raw);
  }
});

test('normalizeForPunctuation: 文件名与 URL 里的冒号不算标点违规', () => {
  // 这几类替换成空格而非汉字替身,否则 `config.json:` 的路径冒号会被误判
  assert.equal(findHalfWidthPunct(normalizeForPunctuation('请检查 config.json:12 行')), null);
  assert.equal(findHalfWidthPunct(normalizeForPunctuation('详见 https://a.example/b:8080 页面')), null);
});

test('glossary.schema.json: terms 不能为空——空表会让整套门禁静默消失', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'glossary.schema.json'), 'utf8'));
  const errors = validateAgainstSchema({ ...glossary, terms: [] }, schema);
  assert.ok(
    errors.some((e) => /terms.*至少需要 1 项|至少需要 1 项/.test(e)),
    `空 terms 必须被拒绝,实际错误:${JSON.stringify(errors)}`,
  );
});

test('stripNonProse: URL 后紧跟中文时,不能把后面的正文一起吞掉', () => {
  // \S+ 收尾会连全角标点带整句正文一起吃掉,URL 之后的禁用词就永远扫不到
  const stripped = stripNonProse('请访问 https://x.test，返回对话列表继续操作');
  assert.ok(stripped.includes('返回对话列表继续操作'), `URL 之后的正文被吞了:${JSON.stringify(stripped)}`);
  assert.ok(!stripped.includes('x.test'));
});

test('glossary.json: 语言键必须都在 locales 里', () => {
  // 拼错的语言键(forbidden.zh_CN)不会被 schema 拦下——additionalProperties 只约束值的
  // 形状,不能拿 locales 的内容去约束键名——而扫描只按 locales 迭代,规则就静默失效了
  const locales = new Set(glossary.locales);
  for (const term of glossary.terms) {
    for (const field of ['translations', 'forbidden', 'alsoAllowed', 'minorityByDesign']) {
      for (const locale of Object.keys(term[field] ?? {})) {
        assert.ok(locales.has(locale), `术语 ${term.id} 的 ${field}.${locale} 语言键不在 locales 里`);
      }
    }
  }
});

test('stripNonProse: 任意扩展名的文件名都要剥离,但不能吃掉数字', () => {
  // 白名单式的扩展名列表补不全,plugin.py / worker.go 会被误判成正文里的产品术语
  for (const [text, gone] of [
    ['请编辑 plugin.py 后重试', 'plugin'],
    ['运行 worker.go', 'worker'],
    ['打开 Agent.java', 'Agent'],
  ]) {
    assert.ok(!stripNonProse(text).includes(gone), text);
  }
  // 版本号 / 小数不是文件名。若被当成文件名吃掉,「已用 1.5 GB」会变成「已用  」,
  // 后续的术语与标点检查都在残缺文本上跑
  assert.ok(stripNonProse('已用 1.5 GB').includes('1.5'));
  assert.ok(stripNonProse('版本 v1.0 可用').includes('v1.0'));
  // 若 1.5 被当成文件名吃掉,「已用 1.5 GB，缓存超限,请清理」里的「限,」就会连带丢失
  assert.equal(findHalfWidthPunct(normalizeForPunctuation('已用 1.5 GB，缓存超限,请清理')), ',');
});

test('findHalfWidthPunct: 右括号等闭合符号也算中文正文的左边界', () => {
  assert.equal(findHalfWidthPunct('可润色改写正文(直接替换),或用卡片替换'), ',');
  assert.equal(findHalfWidthPunct('卸载「{{name}}」?'.replace('{{name}}', 'x')), '?');
  // 右括号做边界后,英文括注也会命中。这不是问题:标点规则只对 zh-CN 生效
  // (HALFWIDTH_PUNCT_LOCALES),而 zh-CN 文案里的英文括注同样该跟中文标点
  assert.equal(findHalfWidthPunct('see (note), then continue'), ',');
});

// ---------------------------------------------------------------------------
// 术语表的定位:参考,不是替换表
// ---------------------------------------------------------------------------

test('禁用译法的提示不给替换目标,只给英文源', () => {
  // 「应为 X」读起来就是一条替换指令,会诱导机械替换——#389 由此产生约 35 处误译。
  // 禁用译法的正确目标取决于英文源(同一个「额度」在 Balance / Quota / Credits 下答案
  // 不同),工具给不出,也不该假装给得出。这条断言防止提示被改回「应为」句式。
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'check-i18n-glossary.mjs'), 'utf8');
  const forbiddenBlock = src
    .slice(src.indexOf("rule: 'forbidden-term'"), src.indexOf("rule: 'term-case'"))
    // 剔除注释行:注释里会引用旧的「应为」句式来解释为什么不再用它
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(forbiddenBlock.includes('hint:'), '未定位到 forbidden-term 的提示构造');
  assert.ok(
    !forbiddenBlock.includes('应为'),
    'forbidden-term 的提示不应给出替换目标——术语表是参考不是替换表',
  );
  assert.ok(forbiddenBlock.includes('英文源'), 'forbidden-term 的提示应附上英文源供判断语境');
});

test('GLOSSARY.md 必须声明「参考，不是替换表」', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'i18n', 'GLOSSARY.md'), 'utf8');
  assert.ok(doc.includes('不是替换表'), 'GLOSSARY.md 缺少定位声明');
  assert.ok(doc.includes('禁止拿本表做脚本批量替换'), 'GLOSSARY.md 缺少批量替换禁令');
});

test('validateAgainstSchema: schema 的 pattern 写坏时报可读错误而不是抛栈', () => {
  // 直接 new RegExp 会把异常抛出校验流程,调用方拿不到带 path 的错误、
  // check-i18n-glossary 会崩栈而不是走 fail()
  const schema = { type: 'object', properties: { id: { type: 'string', pattern: '[' } } };
  const errors = validateAgainstSchema({ id: 'x' }, schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\$\.id: schema 的 pattern 不是合法正则/);
});

test('validateAgainstSchema: 关键字的值形状写错必须报错而不是被曲解', () => {
  // type: ["string","null"] 是合法 draft-07,但本模块只实现字符串形态——
  // 拿数组去比对会永远不等,那条 type 约束就在「看似生效」的外表下彻底失效
  assert.throws(
    () => validateAgainstSchema({}, { type: 'object', properties: { a: { type: ['string', 'null'] } } }),
    /"type" 应是 string,实际是 array/,
  );
  // properties 写成数组
  assert.throws(
    () => validateAgainstSchema({}, { type: 'object', properties: [] }),
    /"properties" 应是 object,实际是 array/,
  );
  // required 写成字符串
  assert.throws(
    () => validateAgainstSchema({}, { type: 'object', required: 'id' }),
    /"required" 应是 array,实际是 string/,
  );
  // additionalProperties 允许 boolean 与 schema 对象两种,其余报错
  assert.doesNotThrow(() => validateAgainstSchema({}, { type: 'object', additionalProperties: false }));
  assert.doesNotThrow(() =>
    validateAgainstSchema({}, { type: 'object', additionalProperties: { type: 'string' } }),
  );
  assert.throws(
    () => validateAgainstSchema({}, { type: 'object', additionalProperties: 'yes' }),
    /additionalProperties 只支持 boolean 或 schema 对象/,
  );
  // items 同属「值是 schema」的位置,同样允许 boolean——不能按 object 死判,
  // 否则合法的 `items: false` 会被误判成 schema 写错
  assert.throws(
    () => validateAgainstSchema({}, { type: 'array', items: 'yes' }),
    /items 只支持 boolean 或 schema 对象/,
  );
});

test('normalizeForPunctuation: URL / 邮箱后紧跟半角标点 + 中文时留下正文边界', () => {
  // TOKEN_TAIL 把逗号留在了 token 外面,但 token 换成空格后逗号前就是空格,
  // findHalfWidthPunct 认不出左边界,违规照样漏
  assert.equal(findHalfWidthPunct(normalizeForPunctuation('请访问 https://x.test,返回对话列表')), ',');
  assert.equal(findHalfWidthPunct(normalizeForPunctuation('联系 a@x.com,重启后重试')), ',');
  assert.equal(findHalfWidthPunct(normalizeForPunctuation('联系 a@x.com;然后重启')), ';');
  // 不能误伤 URL 自身的 query string / 端口号 / 路径冒号
  for (const t of [
    '见 https://a.test/x?ids=1,2&y=3 页面',
    '详见 https://a.example/b:8080 页面',
    '详见 config.json:12 行',
    '打开 https://a.test/p 查看',
    '邮件发到 ops@x.com 即可',
  ]) {
    assert.equal(findHalfWidthPunct(normalizeForPunctuation(t)), null, t);
  }
});

test('countOccurrences: 次数进 fingerprint 才能挡住「已冻结 key 里新增一处」', () => {
  assert.equal(countOccurrences('这个对话和那个会话', '会话'), 1);
  assert.equal(countOccurrences('会话结束后新建会话', '会话'), 2);
  // ASCII 词按词边界,允许复数 s;ssh-agent 不算产品 Agent。
  // 默认大小写敏感(同 occursIn),小写 worker 不计入;要数全部形态得显式放开。
  assert.equal(countOccurrences('创建 Worker 后 worker 会启动', 'Worker'), 1);
  assert.equal(
    countOccurrences('创建 Worker 后 worker 会启动', 'Worker', { caseInsensitive: true }),
    2,
  );
  assert.equal(countOccurrences('用 ssh-agent 转发', 'Agent'), 0);
  assert.equal(countHalfWidthPunct('先这样,再那样,最后收尾'), 2);
});

test('validateAgainstSchema: boolean schema 的 false 必须恒失败', () => {
  // false 被当成「无约束对象」时,items: false 变成不检查、oneOf 的 false 分支
  // 甚至能算唯一通过的分支,把「禁止一切」翻转成「允许一切」
  assert.deepEqual(validateAgainstSchema(['x'], { type: 'array', items: true }), []);
  const errors = validateAgainstSchema(['x'], { type: 'array', items: false });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /schema 为 false,此处不允许任何值/);
  // oneOf 里的 false 分支不能算作通过
  assert.match(
    validateAgainstSchema('x', { oneOf: [false, false] }).join(),
    /oneOf/,
  );
});

test('stripNonProse: 邮箱 local part 不能把紧贴在前面的中文正文吃掉', () => {
  // local part 若允许 CJK,会一路吞到上一个空白/标点为止:`返回worker联系a@x.com`
  // 整条被剥成一个空格,里面小写的 worker 违规随之消失
  const stripped = stripNonProse('返回worker联系a@x.com');
  assert.ok(stripped.includes('worker'), `正文被吞了:${JSON.stringify(stripped)}`);
  assert.ok(!stripped.includes('@'));
  // 正常写法仍要剥干净
  assert.ok(!stripNonProse('联系 ops@x.com 即可').includes('@'));
});

test('ELLIPSIS_LOCALES 必须含 en', () => {
  // DESIGN.md §11 Voice & Content 明文要求英文也用「…」而非三个半角点。
  // 漏掉 en 等于让门禁替既有违规背书(实测当时 en 侧有 54 处)。
  assert.ok(ELLIPSIS_LOCALES.has('en'));
  for (const l of ['zh-CN', 'ja', 'ko']) assert.ok(ELLIPSIS_LOCALES.has(l), l);
});

test('countOccurrences: 默认大小写敏感,与 occursIn 同口径', () => {
  // 术语表里 project 只禁大写 Project、plugin 把两种大小写各列一条,说明设计意图是
  // 逐形态声明。计数若用 /i,「只禁 Project」会被悄悄扩成连小写 project 也禁。
  const text = '打开 project 目录后再看 Project 设置';
  assert.equal(countOccurrences(text, 'Project'), 1);
  assert.equal(occursIn(text, 'Project'), true);
  // 大小写检查那条规则要数出所有形态,显式放开
  assert.equal(countOccurrences(text, 'Project', { caseInsensitive: true }), 2);
});

test('findHalfWidthPunct: 半角标点后有空格再接中文同样算违规', () => {
  // 中英混排常在半角标点后留一个空格,`Keychain, 重启` 与 `Keychain,重启` 是同一问题
  assert.equal(findHalfWidthPunct('Keychain, 重启后自动恢复'), ',');
  assert.equal(findHalfWidthPunct('Keychain,重启后自动恢复'), ',');
  // 空白不影响排除纯 ASCII 的本意
  assert.equal(findHalfWidthPunct('a=1, b=2 的形式'), null);
  assert.equal(findHalfWidthPunct('GPT-4, Claude 两者'), null);
});

test('glossary.json: punctuationExempt 格式合法且不滥用', () => {
  const list = glossary.punctuationExempt ?? [];
  for (const entry of list) {
    assert.match(entry, /^(desktop|mobile\/[a-zA-Z]+):.+$/, `豁免项格式非法:${entry}`);
  }
  // 标点豁免的正当用途极窄(机器可读的结构化文本),数量失控就说明规则本身该改而不是加豁免
  assert.ok(list.length <= 5, `标点豁免已达 ${list.length} 条,请复核规则本身是否需要调整`);
});

test('countCaseMismatches: 只数错的那几处,不是术语出现的总次数', () => {
  // 数总次数的话 `worker … Worker` 与 `worker … worker` 同指纹,前者冻进 baseline 后
  // 把原本正确的那处也改错,新增违规会被静默掩盖
  assert.equal(countCaseMismatches('用 worker 再看 Worker', 'Worker'), 1);
  assert.equal(countCaseMismatches('用 worker 再看 worker', 'Worker'), 2);
  assert.equal(countCaseMismatches('用 Worker 再看 Worker', 'Worker'), 0);
});

test('stripNonProse: 较长扩展名的文件名同样要剥离', () => {
  // 仓库实际支持 .markdown / .properties / .webmanifest（见 maker-shared/filePreview.ts）,
  // 卡在 6 位会让 worker.markdown 留在正文里被误报成产品 Worker
  for (const [text, gone] of [
    ['请编辑 worker.markdown 后重试', 'worker'],
    ['打开 plugin.properties', 'plugin'],
    ['见 agent.webmanifest', 'agent'],
  ]) {
    assert.ok(!stripNonProse(text).includes(gone), text);
  }
  assert.ok(stripNonProse('已用 1.5 GB').includes('1.5'));
});

test('空术语不能让计数函数挂死', () => {
  // 空串走 CJK 分支时 indexOf('', from) 永远返回 from、term.length 为 0,循环不推进
  // ——门禁会挂死而不是报错。CI 里 check:i18n-glossary 排在单测之前,一个手滑的 ""
  // 就能卡住整条流水线。schema 的 minLength 是第一道防线,这里是第二道。
  assert.equal(countOccurrences('任意文案', ''), 0);
  assert.equal(occursIn('任意文案', ''), false);
  assert.equal(countCaseMismatches('任意文案', ''), 0);
});

test('glossary.schema.json: 禁用词不允许为空串', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'glossary.schema.json'), 'utf8'));
  const bad = {
    ...glossary,
    terms: [{ ...glossary.terms[0], forbidden: { 'zh-CN': [''] } }],
  };
  assert.ok(
    validateAgainstSchema(bad, schema).length > 0,
    '空禁用词必须在 schema 阶段就被拒,不能让它走到计数函数',
  );
});

test('findHalfWidthPunct: 闭合的半角引号也算左边界,但要求右侧是中文', () => {
  // 中文文案常写 `默认 "cindy",有重名时…`,闭合引号后那个逗号是正文标点
  assert.equal(findHalfWidthPunct('默认 "cindy",有重名时加后缀'), ',');
  assert.equal(findHalfWidthPunct("用 'plugin',再重启"), ',');
  assert.equal(findHalfWidthPunct('见 `worker`,然后继续'), ',');
  // 半角引号常用来包英文,右侧不是中文时不判违规
  assert.equal(findHalfWidthPunct('英文 "note", then continue'), null);
  // 全角括号那一支不要求右侧是中文（已对 26 处实例逐条核对）
  assert.equal(findHalfWidthPunct('(直接替换,不留原文),或用卡片'), ',');
});

test('findCaseMismatch: 标准词自带尾部 s 时不能把它当复数削掉', () => {
  // 匹配正则带 `s?`,无条件 replace(/s$/,'') 会把 Credits / Full access 固有的 s 削掉,
  // 拼写完全正确的文案反被判违规。目前保留英文的术语恰好都不以 s 结尾,所以还没爆——
  // 但只要有人加一条以 s 结尾的术语,正确文案就会被门禁全面拒绝。
  assert.equal(findCaseMismatch('Full access', 'Full access'), null);
  assert.equal(findCaseMismatch('Credits', 'Credits'), null);
  assert.equal(countCaseMismatches('Full access', 'Full access'), 0);
  // 仍要能抓出真正的大小写错误
  assert.equal(findCaseMismatch('full access', 'Full access'), 'full access');
  assert.equal(findCaseMismatch('credits', 'Credits'), 'credits');
  // 复数形式仍算正确
  assert.equal(findCaseMismatch('两个 Workers', 'Worker'), null);
});

test('stripNonProse: 扩展名不设长度上限', () => {
  // 支持列表里有 .gitattributes(13) / .browserslistrc(14) / .prettierignore(14),
  // 任何具体上限都会随列表变化失准
  for (const [text, gone] of [
    ['见 worker.browserslistrc 配置', 'worker'],
    ['见 plugin.prettierignore 配置', 'plugin'],
    ['见 agent.gitattributes 配置', 'agent'],
  ]) {
    assert.ok(!stripNonProse(text).includes(gone), text);
  }
  assert.ok(stripNonProse('已用 1.5 GB').includes('1.5'));
});

test('normalizeForPunctuation: 文件名后的正文标点与 URL 后的省略号都要保留', () => {
  // 文件名换成空格会丢掉左边界,`编辑 config.json,然后重试` 的逗号漏检
  assert.equal(findHalfWidthPunct(normalizeForPunctuation('编辑 config.json,然后重试')), ',');
  assert.equal(findHalfWidthPunct(normalizeForPunctuation('编辑 config.json, 然后重试')), ',');
  // 路径里的冒号仍不算正文标点
  assert.equal(findHalfWidthPunct(normalizeForPunctuation('详见 config.json:12 行')), null);
  // token 不能吃掉正文省略号
  assert.equal(hasAsciiEllipsis(normalizeForPunctuation('Open https://x.test...')), true);
  assert.equal(hasAsciiEllipsis(normalizeForPunctuation('联系 a@x.com...然后重试')), true);
  // URL 内部的单点不受影响
  assert.equal(hasAsciiEllipsis(normalizeForPunctuation('见 https://a.test/a.b.c 页面')), false);
});

test('findHalfWidthPunct: 连字符 / 下划线结尾的 code token 后也算左边界', () => {
  // 代码风格的 token 常以 - 或 _ 收尾:`该 id 使用了官方保留前缀 cindy-,仅随…`
  // 逗号前是连字符,只认字母数字会整类漏掉
  assert.equal(findHalfWidthPunct('保留前缀 cindy-,仅随应用内置的插件可用'), ',');
  assert.equal(findHalfWidthPunct('变量 foo_,然后继续'), ',');
  // 仍要求右侧是 CJK,纯 ASCII 片段不受影响
  assert.equal(findHalfWidthPunct('a=1, b=2 的形式'), null);
  assert.equal(findHalfWidthPunct('GPT-4, Claude 两者'), null);
});

test('TOKEN_TAIL: 正文直接贴在 URL / 邮箱后面(连标点都没有)时也要截断', () => {
  // 中英混排常把中文正文紧贴在地址后面。\S+ 会把整句正文一起吞掉,里面的术语违规随之消失。
  assert.ok(stripNonProse('访问 https://x.test返回worker操作').includes('worker'));
  assert.ok(stripNonProse('联系 a@x.com然后worker操作').includes('worker'));
  // 地址本身仍然被完整剥掉,不会把 host 里的词当正文
  assert.ok(!stripNonProse('访问 https://worker.test返回操作').includes('worker.test'));
  // 端口号、query string 这类合法 URL 结构不能被切坏(切坏了会把里面的半角标点当正文标点)
  assert.equal(findHalfWidthPunct(normalizeForPunctuation('见 https://a.test:8080/x?ids=1,2 页面')), null);
});

test('findHalfWidthPunct: 句末的 ?/! 紧跟拉丁词也算(中文正文)', () => {
  // 中文疑问句以英文产品名收尾:右边没有任何字符,「右侧须是 CJK」那条永远匹配不上
  assert.equal(findHalfWidthPunct('断开 Cindy AI?'), '?');
  assert.equal(findHalfWidthPunct('要重启 Cindy!'), '!');
  assert.equal(findHalfWidthPunct('确认删除 config?  '), '?');
  // 纯英文文案不受影响——`Continue?` 是正确英语
  assert.equal(findHalfWidthPunct('Disconnect Cindy AI?'), null);
  // 句末的 , : ; 仍不算:结构化前缀与列表收尾本就用半角
  assert.equal(findHalfWidthPunct('中文说明 note:'), null);
  // 句中「拉丁 + 半角逗号 + 拉丁」仍不算(与代码/语法示例外形相同,静态判不了),
  // 这两条是上一轮 review 定下的口径,新分支不得推翻
  assert.equal(findHalfWidthPunct('a=1, b=2 的形式'), null);
  assert.equal(findHalfWidthPunct('GPT-4, Claude 两者'), null);
});

test('countHalfWidthPunct: 两组形态互斥,同一个标点不会被数两次', () => {
  // 汉字后的半角标点只属于第 1 形态
  assert.equal(countHalfWidthPunct('重启 Keychain,然后继续'), 1);
  // 句末 ? 只属于新分支
  assert.equal(countHalfWidthPunct('断开 Cindy AI?'), 1);
  // 右括号 + 句末问号:左边界只取拉丁/数字,不含右括号,所以仍只算一次(第 1 形态)
  assert.equal(countHalfWidthPunct('确认删除（含历史）?'), 1);
  // 两处不同形态各算一次
  assert.equal(countHalfWidthPunct('重启 Keychain,然后断开 Cindy AI?'), 2);
});

test('makeSourceTermMatcher: 复数按英语真实形态展开', () => {
  // Proxy → proxies。只认「加 s」时英文源写 proxies 会让条件禁用整个跳过
  assert.ok(sourceMentions('Configure system proxies here', 'Proxy'));
  assert.ok(sourceMentions('Use a Proxy', 'Proxy'));
  assert.ok(!sourceMentions('proxying requests', 'Proxy'));
  // s / x / ch / sh 结尾 → es
  assert.ok(sourceMentions('Two processes exited', 'Process'));
  // 常规词 → 可选 s
  assert.ok(sourceMentions('no credits left', 'Credit'));
  assert.ok(sourceMentions('one credit left', 'Credit'));
  // 词边界仍要成立:连字符与下划线算边界
  assert.ok(!sourceMentions('ssh-agent forwarding', 'Agent'));
  assert.ok(!sourceMentions('agent_id missing', 'Agent'));
  // 空词返回 null,不能退化成「恒命中」
  assert.equal(makeSourceTermMatcher(''), null);
  assert.equal(sourceMentions('anything', ''), false);
});

test('caseStandardFor: alsoAllowed 允许英文原词时同样要查大小写', () => {
  const skill = {
    en: 'Skill',
    translations: { 'zh-CN': '技能' },
    alsoAllowed: { 'zh-CN': [{ text: 'Skill', when: '技术语境' }] },
  };
  // 首选译法是中文,但既然允许保留英文,保留的就该是规范形态
  assert.equal(caseStandardFor(skill, 'zh-CN'), 'Skill');
  // 没有 alsoAllowed 的语言不查
  assert.equal(caseStandardFor(skill, 'ja'), null);
  // 故意小写的外部系统叫法(thread / credits)靠「恰好等于 term.en」天然排除
  const thread = {
    en: 'Thread',
    translations: { 'zh-CN': '对话' },
    alsoAllowed: { 'zh-CN': [{ text: 'thread', when: 'Codex 概念' }] },
  };
  assert.equal(caseStandardFor(thread, 'zh-CN'), null);
  // checkCase=false 一律不查
  assert.equal(caseStandardFor({ ...skill, checkCase: false }, 'zh-CN'), null);
  // translations 值就是英文原词时照旧
  assert.equal(caseStandardFor({ en: 'Agent', translations: { 'zh-CN': 'Agent' } }, 'zh-CN'), 'Agent');
  // 源语言 en 不在 translations 里,天然返回 null(开启会有 84 处假阳性)
  assert.equal(caseStandardFor({ en: 'Agent', translations: { 'zh-CN': 'Agent' } }, 'en'), null);
});

test('GLOSSARY.md 不得把 --update-baseline 说成能登记新违规', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'i18n', 'GLOSSARY.md'), 'utf8');
  // proposed → decided 会把既有告警变成阻断违规,而 --update-baseline 只删不加,
  // 照着「再跑 --update-baseline 冻结存量」做只会失败
  assert.ok(!/改为\s*`?decided`?[^\n]*再跑\s*`?--update-baseline`?[^\n]*冻结存量/.test(doc), doc.slice(0, 200));
  assert.ok(doc.includes('只删不加'), '文档要说清 --update-baseline 的方向性');
});
