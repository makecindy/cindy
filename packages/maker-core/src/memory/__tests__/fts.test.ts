/**
 * MemoryFts 单测 — 用真 better-sqlite3 内存库。
 *
 * 重点覆盖 #1537: unicode61 tokenizer 把连续 CJK 文本当一个 token,
 * phrase MATCH 无法命中中文子串, 必须由 LIKE 兜底捞回。
 * 另覆盖 buildFilename 对带 type 前缀 slug 的拒绝 (#1652 附带小 bug)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { MemoryFts } from '../fts.js';
import { buildFilename } from '../storage.js';
import type { MemoryRecord } from '../types.js';

function record(filename: string, body: string, overrides?: Partial<MemoryRecord>): MemoryRecord {
  // 按 MemoryRecord 契约: slug 是去掉 <type>_ 前缀与 .md 后缀的部分 (types.ts)
  const slug = filename.replace(/\.md$/, '').replace(/^(user|feedback|project|reference|digest)_/, '');
  const type = (filename.match(/^(user|feedback|project|reference|digest)_/) ?? ['digest'])[0].replace(/_$/, '') as MemoryRecord['frontmatter']['type'];
  return {
    filename,
    slug,
    frontmatter: {
      type,
      title: `标题 ${filename}`,
      description: `描述 ${filename}`,
      updatedAt: '2026-08-06T00:00:00.000Z',
    },
    body,
    sizeBytes: body.length,
    ...overrides,
  };
}

describe('MemoryFts', () => {
  let db: Database.Database;
  let fts: MemoryFts;

  beforeEach(() => {
    db = new DatabaseCtor(':memory:');
    fts = new MemoryFts(db);
    fts.init();
  });

  afterEach(() => {
    db.close();
  });

  it('中文子串查询命中 (LIKE 兜底, #1537 主场景)', () => {
    fts.upsert(record('project_a.md', 'MaxCompute 数据分析链路性能优化'));
    fts.upsert(record('project_b.md', '边界索引配置说明'));

    // 复现 issue: 无通配符的精确中文查询
    const hits = fts.search('边界');
    expect(hits.length).toBe(1);
    expect(hits[0].filename).toBe('project_b.md');
  });

  it('英文精确查询仍走 MATCH 优先 (score = bm25 非 0)', () => {
    fts.upsert(record('project_a.md', 'MaxCompute link 优化'));

    const hits = fts.search('MaxCompute');
    expect(hits.length).toBe(1);
    expect(hits[0].filename).toBe('project_a.md');
    expect(hits[0].score).not.toBe(Number.MAX_SAFE_INTEGER); // 走 MATCH 路径才带 bm25
  });

  it('MATCH 命中不足时合并 LIKE 兜底并按 filename 去重', () => {
    // A: MATCH('link') 与 LIKE('%link%') 双命中
    fts.upsert(record('project_a.md', '数据链路分析与 link 优化'));
    // B: token 是 LinkedIn, MATCH('link') 不命中, 但 LIKE 大小写不敏感可命中
    fts.upsert(record('project_b.md', 'LinkedIn 社交平台分析'));
    // C: 双不命中
    fts.upsert(record('project_c.md', 'MaxCompute 边界索引'));

    const hits = fts.search('link');
    const filenames = hits.map((h) => h.filename).sort();
    expect(filenames).toEqual(['project_a.md', 'project_b.md']);
    // 去重: A 只出现一次
    expect(new Set(filenames).size).toBe(filenames.length);
  });

  it('type filter 对 MATCH 与 LIKE 兜底都生效', () => {
    fts.upsert(record('project_a.md', '边界索引配置说明'));
    fts.upsert(record('feedback_b.md', '边界相关反馈'));

    const all = fts.search('边界');
    expect(all.length).toBe(2);

    const filtered = fts.search('边界', { type: 'feedback' });
    expect(filtered.length).toBe(1);
    expect(filtered[0].filename).toBe('feedback_b.md');
  });

  it('空查询返回空', () => {
    fts.upsert(record('project_a.md', '内容'));
    expect(fts.search('')).toEqual([]);
    expect(fts.search('   ')).toEqual([]);
  });

  it('特殊字符查询不抛 (语法错被吞, 由 LIKE 兜底接管)', () => {
    fts.upsert(record('project_a.md', '括号 (nested) 与引号 "quote" 内容'));
    const hits = fts.search('"quote" 括号');
    // 不抛异常即可; 能命中引号词更好
    expect(Array.isArray(hits)).toBe(true);
  });

  it('limit 生效', () => {
    for (let i = 0; i < 20; i++) {
      fts.upsert(record(`project_${String(i).padStart(2, '0')}.md`, `共同词 内容 ${i}`));
    }
    expect(fts.search('共同词', { limit: 3 }).length).toBe(3);
    expect(fts.search('共同词', { limit: 100 }).length).toBe(20); // 上限 50 不越界即可
  });

  it('MATCH 命中满 limit 时为 LIKE-only 子串命中预留 1 个名额', () => {
    const spy = vi.spyOn(fts as unknown as { searchLike: (terms: readonly string[], o: unknown) => unknown }, 'searchLike');
    try {
      // 7 条整 token 命中 (>= limit 3, 满额; 且 7 > limit*2=6, LIKE 全扫也排在前面) +
      // 1 条 LIKE-only (LinkedIn, MATCH 不中) 在物理顺序最后 — 若 SQL 先 LIMIT 会被截掉
      for (let i = 0; i < 7; i++) {
        fts.upsert(record(`project_${String(i).padStart(2, '0')}.md`, `link 内容 ${i}`));
      }
      fts.upsert(record('project_linkedin.md', 'LinkedIn 社交平台'));
      const hits = fts.search('link', { limit: 3 });
      expect(spy).toHaveBeenCalled(); // 子串检索仍执行
      expect(hits.length).toBe(3);
      // 预留名额生效: 唯一的 LIKE-only 命中必须可见
      expect(hits.some((h) => h.filename === 'project_linkedin.md')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('limit=1 且 MATCH 满额时不预留 (保住唯一最佳 MATCH)', () => {
    fts.upsert(record('project_a.md', 'link 内容'));
    fts.upsert(record('project_linkedin.md', 'LinkedIn 社交平台'));
    const hits = fts.search('link', { limit: 1 });
    expect(hits.length).toBe(1);
    expect(hits[0].filename).toBe('project_a.md'); // MATCH 优先, 不被 LIKE 挤掉
  });

  // 测试价值 (engineering-conventions §3.2)
  // - 生产入口与可观察结果: MemoryFts.search → memory_search 的命中数、顺序、snippet。
  // - Bug 依据: 短语零命中时旧实现直接返回 0; 真实记忆库上 5/10 条查询零命中。
  // - 现有覆盖缺口: 原用例只覆盖单词中文子串与 MATCH 合并, 无多词、排序、窗口片段。
  // - 最小失败输入: 「登录 缓存」两条正文分别只含一个词 → 旧实现 0 命中。
  // - tier: unit (真 better-sqlite3 内存库, 无真实 I/O; 整文件约 1.3s)。
  it('短语零命中时多词按 OR 兜底, 覆盖更多词的排前面', () => {
    // 旧实现把整条 query 当一个 LIKE 子串: 「登录 缓存」只有在原文出现
    // 「登录 缓存」字面串时才命中, 这里两条都不会被捞到 (0 命中)。
    fts.upsert(record('project_a.md', '登录失败时先检查 token 是否过期'));
    fts.upsert(record('project_b.md', '登录成功后写入本地缓存'));
    fts.upsert(record('project_c.md', '与此无关的构建日志'));

    const hits = fts.search('登录 缓存');
    expect(hits.map((h) => h.filename).sort()).toEqual(['project_a.md', 'project_b.md']);
    // b 两个词都命中, a 只命中「登录」
    expect(hits[0]?.filename).toBe('project_b.md');
  });

  it('title 命中优先于仅正文命中, LIKE 臂内按 score 升序', () => {
    // filename 顺序故意与期望相反: 旧实现按 filename 排序, 会先返回 a。
    const titled = record('project_b.md', '正文只提一次');
    fts.upsert({ ...titled, frontmatter: { ...titled.frontmatter, title: '缓存位置速查' } });
    fts.upsert(record('project_a.md', '缓存位置写在这里'));

    const hits = fts.search('缓存位置');
    expect(hits.map((h) => h.filename)).toEqual(['project_b.md', 'project_a.md']);
    expect(hits[0]!.score).toBeLessThan(hits[1]!.score);
  });

  it('LIKE 命中返回命中窗口片段并标记关键词, 不再截取正文开头', () => {
    // 命中在正文 160 字之后: 旧实现取正文前 160 字, snippet 里根本看不到关键词。
    const head = '前置说明'.repeat(40);
    fts.upsert(record('project_a.md', `${head}关键短语${'后置内容'.repeat(40)}`));

    const [hit] = fts.search('关键短语');
    expect(hit?.snippet).toContain('<mark>关键短语</mark>');
    expect(hit?.snippet.startsWith('…')).toBe(true);
    // 窗口 180 字 + 首尾省略号 + <mark> 开闭标签
    expect((hit?.snippet ?? '').length).toBeLessThanOrEqual(240);
  });

  it('2 字中文仍命中; 多词 + type 过滤只在该类目内召回', () => {
    fts.upsert(record('project_a.md', '登录与缓存'));
    fts.upsert(record('feedback_b.md', '登录与缓存'));

    expect(fts.search('登录').length).toBe(2);
    const filtered = fts.search('登录 缓存', { type: 'feedback' });
    expect(filtered.map((h) => h.filename)).toEqual(['feedback_b.md']);
  });

  it('超长 query 截断后不抛; LIKE 通配符按字面匹配', () => {
    fts.upsert(record('project_a.md', '进度 100% 完成'));
    fts.upsert(record('project_b.md', '进度一百'));

    expect(() => fts.search('x'.repeat(500))).not.toThrow();
    // 「%」按字面匹配: 只有含 100% 的那条命中
    expect(fts.search('%').map((h) => h.filename)).toEqual(['project_a.md']);
  });

  it('短语命中时保持精确语义, 不再拆词', () => {
    fts.upsert(record('project_adjacent.md', '缓存 日志 都在 E 盘'));
    fts.upsert(record('project_split.md', '缓存只在这里，日志写在别处'));

    // 整串命中优先: 只有含「缓存 日志」的分片返回, 不因为拆词多召回 split
    const hits = fts.search('缓存 日志');
    expect(hits.map((h) => h.filename)).toEqual(['project_adjacent.md']);
  });

  it('片段边界: 开头命中不加前省略号, 中部命中两端省略, title/description 命中可直接成片段', () => {
    fts.upsert(record('project_head.md', '缓存位置在 E 盘'));
    fts.upsert(record('project_middle.md', `${'前置'.repeat(50)}结尾关键词${'后置'.repeat(100)}`));
    const titled = record('project_title.md', '正文没有');
    fts.upsert({ ...titled, frontmatter: { ...titled.frontmatter, title: '速查表' } });
    const described = record('project_desc.md', '正文没有');
    fts.upsert({ ...described, frontmatter: { ...described.frontmatter, description: '接口约定' } });

    const head = fts.search('缓存位置')[0];
    expect(head?.snippet.startsWith('<mark>缓存位置</mark>')).toBe(true);
    expect(head?.snippet.includes('…')).toBe(false);

    const middle = fts.search('结尾关键词')[0];
    expect(middle?.snippet.startsWith('…')).toBe(true);
    expect(middle?.snippet.endsWith('…')).toBe(true);

    expect(fts.search('速查表')[0]?.snippet).toBe('<mark>速查表</mark>');
    expect(fts.search('接口约定')[0]?.snippet).toBe('<mark>接口约定</mark>');
  });

  it('片段标记: 重叠词不嵌套, 代码不被 HTML 转义', () => {
    fts.upsert(record('project_overlap.md', '登录失败要重试'));
    const [overlap] = fts.search('登录 登录失败');
    expect(overlap?.snippet).toContain('<mark>登录失败</mark>');
    expect(overlap?.snippet).not.toContain('<mark><mark>');

    // 用 MATCH 命不中的子串(整 token 是 TValue)走 LIKE 臂, 验证片段不转义尖括号
    fts.upsert(record('project_code.md', '占位符 <TValue> 表示泛型'));
    const [code] = fts.search('<T');
    expect(code?.snippet).toContain('<T');
    expect(code?.snippet).not.toContain('&lt;');
  });

  it('排序: 出现次数多、正文更短的优先', () => {
    fts.upsert(record('project_dense.md', '缓存 缓存 缓存 缓存'));
    fts.upsert(record('project_sparse.md', '缓存 与其它内容'));
    expect(fts.search('缓存')[0]?.filename).toBe('project_dense.md');

    fts.upsert(record('project_short.md', `缓存${'说明'.repeat(98)}`));
    fts.upsert(record('project_long.md', `缓存${'说明'.repeat(2998)}`));
    const lengthHits = fts.search('缓存').filter(
      (h) => h.filename === 'project_short.md' || h.filename === 'project_long.md',
    );
    expect(lengthHits.map((h) => h.filename)).toEqual(['project_short.md', 'project_long.md']);
  });

  it('limit 在相关度排序之后截断, 不按 filename', () => {
    for (let i = 0; i < 5; i++) {
      // 末尾补一个汉字, 避免正文恰好是「缓存」整 token 而被 MATCH 臂先命中
      fts.upsert(record(`project_${String(i).padStart(2, '0')}.md`, `${'缓存'.repeat(i + 1)}项`));
    }
    const hits = fts.search('缓存', { limit: 3 });
    expect(hits.map((h) => h.filename)).toEqual(['project_04.md', 'project_03.md', 'project_02.md']);
  });

  it('候选池上限 500: 短正文高密度文档不会被 filename 顺序截掉', () => {
    // 501 条都命中单词 (刚超过 500 上限); 高密度文档(正文只有 3 字)故意排在
    // filename 末尾。粗排同分时按 length(body) ASC 先取短正文, 它才能进入候选并拿第一。
    fts.rebuild(
      Array.from({ length: 501 }, (_, i) =>
        record(`digest_x${String(i).padStart(4, '0')}.md`, i === 500 ? '缓存项' : `缓存项${'填充'.repeat(3000)}`),
      ),
    );
    const hits = fts.search('缓存', { limit: 3 });
    expect(hits[0]?.filename).toBe('digest_x0500.md');
  });

  it('候选池上限 500: 多词兜底同样保留短正文高密度文档', () => {
    fts.rebuild(
      Array.from({ length: 501 }, (_, i) =>
        record(
          `digest_y${String(i).padStart(4, '0')}.md`,
          i === 500 ? '缓存项 日志项' : `缓存项 日志项${'填充'.repeat(3000)}`,
        ),
      ),
    );
    const hits = fts.search('缓存 日志', { limit: 3 });
    expect(hits[0]?.filename).toBe('digest_y0500.md');
  });

  it('query 归一: 词序无关、全角空格、重复词去重', () => {
    fts.upsert(record('project_a.md', '登录成功后写入缓存'));
    const forward = fts.search('登录 缓存');
    const reversed = fts.search('缓存 登录');
    expect(reversed.map((h) => h.filename)).toEqual(forward.map((h) => h.filename));
    expect(reversed[0]?.score).toBe(forward[0]?.score);

    const wide = fts.search('登录　缓存');
    expect(wide.map((h) => h.filename)).toEqual(forward.map((h) => h.filename));

    const dup = fts.search('缓存 缓存');
    expect(dup[0]?.score).toBe(fts.search('缓存')[0]?.score);
  });

  it('超过 8 个词只取前 8 个', () => {
    fts.upsert(record('project_unique.md', '独特词'));
    const eight = ['一', '二', '三', '四', '五', '六', '七', '独特词'].join(' ');
    expect(fts.search(eight).length).toBe(1);
    const nine = ['一', '二', '三', '四', '五', '六', '七', '八', '独特词'].join(' ');
    expect(fts.search(nine).length).toBe(0);
  });

  describe('真实语料矩阵 (12 条分片 / 14 条查询)', () => {
    // 形态对齐真实 maker-memory: 标题是短句, 正文是中文说明 + 英文路径/命令。
    function shard(filename: string, title: string, body: string): MemoryRecord {
      const base = record(filename, body);
      return { ...base, frontmatter: { ...base.frontmatter, title } };
    }

    const corpus: MemoryRecord[] = [
      shard('user_pref_concise.md', '回答风格', '用户偏好简洁中文回答，先给结论再展开。'),
      shard('user_pref_choice_first.md', '取舍偏好', '耗时或改动相差大的选择先问一句再动手。'),
      shard('feedback_local_dev.md', '本机开发', 'Cindy 开发调试跑在本机，不用虚拟机；VM 只用于干净系统验证安装升级。'),
      shard('project_windows_env.md', 'Windows 开发环境', '本机开发环境：corepack pnpm、缓存集中在 E:\\DevCache、打包日志在 E:\\DevCache\\logs。'),
      shard('reference_paths.md', '路径索引', 'gh CLI 在 C:\\Program Files\\GitHub CLI，已登录 woniuxia；安装包产物在 apps\\desktop\\out\\make\\nsis。'),
      shard('project_search_plan.md', '记忆检索方案', '中文检索先增强 LIKE，多词按空格分开；cjk_seg 与 trigram 暂不做索引。'),
      shard('feedback_test_budget.md', '测试预算', '单测文件单独运行应在 5 秒内，重 I/O 下沉到专用 tier。'),
      shard('reference_ci.md', 'CI 门禁', '提交前跑 pnpm rules:changed 与 pnpm check:test-hygiene。'),
      shard('project_updater.md', '更新链路', '改 cindy-updater 或 Electron 更新服务前必须先取得维护者确认。'),
      shard('feedback_logs.md', '日志脱敏', '日志只增不减脱敏规则，禁止把用户凭证写进日志。'),
      shard('project_pi.md', 'Pi 会话', 'Pi 压缩上下文时把摘要写成 digest 记忆，能 memory_search 但不能进 MEMORY.md 索引。'),
      shard('reference_embedding.md', '向量检索', '聊天历史已是 FTS + 向量 RRF；记忆暂不加向量臂。'),
    ];

    beforeEach(() => {
      for (const r of corpus) fts.upsert(r);
    });

    const cases = [
      { query: '检索 方案', expected: 'project_search_plan.md' },
      { query: '缓存 日志', expected: 'project_windows_env.md' },
      { query: '干净系统 验证', expected: 'feedback_local_dev.md' },
      { query: '测试 预算', expected: 'feedback_test_budget.md' },
      { query: '日志 脱敏', expected: 'feedback_logs.md' },
      { query: '向量 RRF', expected: 'reference_embedding.md' },
      { query: '安装包 产物', expected: 'reference_paths.md' },
      { query: 'digest 索引', expected: 'project_pi.md' },
      { query: 'pnpm 门禁', expected: 'reference_ci.md' },
      { query: '确认 更新', expected: 'project_updater.md' },
      { query: '简洁 回答', expected: 'user_pref_concise.md' },
      { query: '虚拟机', expected: 'feedback_local_dev.md' },
      { query: '虚拟机 嵌入', expected: 'feedback_local_dev.md' },
      { query: 'hnswlib 聚类', expected: null },
    ];

    it.each(cases)('$query → $expected', ({ query, expected }) => {
      const hits = fts.search(query, { limit: 5 });
      if (expected === null) {
        expect(hits).toEqual([]);
        return;
      }
      expect(hits[0]?.filename).toBe(expected);
    });
  });

  it('upsert 按 filename 去重, delete/count/rebuild 基本行为', () => {
    fts.upsert(record('project_a.md', 'v1 边界'));
    fts.upsert(record('project_a.md', 'v2 索引'));
    expect(fts.count()).toBe(1);

    fts.delete('project_a.md');
    expect(fts.count()).toBe(0);

    fts.upsert(record('project_b.md', '边界内容'));
    fts.rebuild([record('project_b.md', '边界内容'), record('project_c.md', 'MaxCompute 链路')]);
    expect(fts.count()).toBe(2);
    expect(fts.search('MaxCompute').length).toBe(1);
  });
});

describe('buildFilename · 拒绝 type 前缀 slug (#1652 附带小 bug)', () => {
  it('slug 已带同 type 前缀时拒绝 (而非剥离), 避免存量分片定位错位', () => {
    // 存量 feedback_feedback_foo.md 被 parseFilename 解析为 slug 'feedback_foo',
    // 若剥离成 'foo' 会定位到不存在的 feedback_foo.md (not-found 或静默改错分片)
    expect(() => buildFilename('feedback', 'feedback_foo')).toThrow(/invalid-slug/);
    expect(() => buildFilename('project', 'project_pricing')).toThrow(/invalid-slug/);
  });

  it('不带前缀的纯 slug 原样拼装', () => {
    expect(buildFilename('feedback', 'foo')).toBe('feedback_foo.md');
  });

  it('slug 恰好等于 type 名时报 invalid-slug', () => {
    expect(() => buildFilename('feedback', 'feedback')).toThrow(/invalid-slug/);
  });

  it('只带前缀没有实体的 slug 报 invalid-slug', () => {
    expect(() => buildFilename('feedback', 'feedback_')).toThrow(/invalid-slug/);
  });
});
