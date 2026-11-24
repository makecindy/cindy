import { describe, expect, it } from 'vitest';
import { repairMermaidSource } from '../mermaidAutofix.js';

describe('repairMermaidSource', () => {
  it('合法 flowchart 原样返回(逐字符相同)', () => {
    const src = 'flowchart TD\n  A["Start"] -->|"go"| B[End]\n  B --> C';
    expect(repairMermaidSource(src)).toBe(src);
  });

  it('unicode 箭头 → -->', () => {
    expect(repairMermaidSource('flowchart TD\nA → B\nB ⇒ C')).toBe(
      'flowchart TD\nA --> B\nB --> C',
    );
  });

  it('引号内的 unicode 箭头不动', () => {
    const src = 'flowchart TD\nA["输入 → 输出"] --> B';
    expect(repairMermaidSource(src)).toBe(src);
  });

  it('subgraph 头补空格(带引号标签)', () => {
    expect(repairMermaidSource('flowchart TD\nsubgraph L3["Layer 3"]\nA\nend')).toBe(
      'flowchart TD\nsubgraph L3 ["Layer 3"]\nA\nend',
    );
  });

  it('subgraph 头已有空格不动', () => {
    const src = 'flowchart TD\nsubgraph L3 ["Layer 3"]\nA\nend';
    expect(repairMermaidSource(src)).toBe(src);
  });

  it('// 行注释 → %%(所有图类型,含非 flowchart)', () => {
    expect(repairMermaidSource('sequenceDiagram\n// note here\nA->>B: hi')).toBe(
      'sequenceDiagram\n%% note here\nA->>B: hi',
    );
    expect(repairMermaidSource('flowchart TD\n  // step one\nA --> B')).toBe(
      'flowchart TD\n  %% step one\nA --> B',
    );
  });

  it('未引号边标签加引号', () => {
    expect(repairMermaidSource('flowchart LR\nC1 -->|注册 + 入队| H1')).toBe(
      'flowchart LR\nC1 -->|"注册 + 入队"| H1',
    );
  });

  it('已引号边标签不动', () => {
    const src = 'flowchart LR\nC1 -->|"注册 + 入队"| H1';
    expect(repairMermaidSource(src)).toBe(src);
  });

  it('含特殊字符的节点标签加引号(方/圆/菱)', () => {
    expect(repairMermaidSource('flowchart TD\nA[Step: parse (user) input] --> B')).toBe(
      'flowchart TD\nA["Step: parse (user) input"] --> B',
    );
    expect(repairMermaidSource('flowchart TD\nA(fn: init) --> B')).toBe(
      'flowchart TD\nA("fn: init") --> B',
    );
    expect(repairMermaidSource('flowchart TD\nA{ok?: yes/no} --> B')).toBe(
      'flowchart TD\nA{"ok?: yes/no"} --> B',
    );
  });

  it('无特殊字符的节点标签不动', () => {
    const src = 'flowchart TD\nA[plain text] --> B(round) --> C{choice}';
    expect(repairMermaidSource(src)).toBe(src);
  });

  it('形状变体不误伤([(db)] [[sub]] {{hex}} ((circle)) [/para/])', () => {
    const src = [
      'flowchart TD',
      'A[(database)] --> B[[subroutine]]',
      'C{{hexagon}} --> D((circle))',
      'E[/parallelogram/] --> F',
    ].join('\n');
    expect(repairMermaidSource(src)).toBe(src);
  });

  it('保留 #7687 原报中两种形状标签的 Unicode 箭头', () => {
    const src = 'flowchart TD\nA([stadium → text]) --> B[[subroutine ⟶ text]]';
    expect(repairMermaidSource(src)).toBe(src);
  });

  it.each([
    'A([before → "quoted ])" after → text])',
    'A([输入 (含括号) → 输出])',
    'A.([stadium → text])',
    'A,([stadium → text])',
    'A>draft → final]',
    'A->draft → final]',
    "A'([stadium → text])",
    'A`([stadium → text])',
    'A[[outer [inner] → text]]',
    'A[(database → text)]',
    'A{{hexagon ➔ text}}',
    'A((circle ➜ text))',
    'A[/parallelogram ⇒ text/]',
    'A[\\trapezoid ⟹ text/]',
  ])('保留 %s 的标签并修复同一行的边', (node) => {
    expect(repairMermaidSource(`flowchart TD\n${node} → B`)).toBe(
      `flowchart TD\n${node} --> B`,
    );
  });

  // #7687 的 unit 回归。既有用例只覆盖符号形状；@{...} 的标签同样需要保留箭头，
  // 连线仍须修复。最小失败输入是 A@{ shape: stadium, label: start → done } → B。
  it.each([
    'A@{ shape: stadium, label: start → done }',
    'A@{ &props shape: stadium, label: start → done }',
    'A@{ "shape": "stadium", label: start → done }',
    "A@{ 'shape': 'stadium', label: start → done }",
    'A@{\n  shape: stadium\n  label: start → done\n}',
    'A@{\n  # node shape\n  shape: stadium\n  label: start → done\n}',
    'A@{\n  shape: stadium\n  label: "start } → done"\n}',
  ])('保留 @{...} 的属性内容并修复后续连线 (%s)', (node) => {
    expect(repairMermaidSource('flowchart TD\n' + node + ' → B')).toBe(
      'flowchart TD\n' + node + ' --> B',
    );
  });

  it('YAML 标题和边标签中的 @{ 不会阻止后续连线修复', () => {
    expect(repairMermaidSource('---\ntitle: Demo @{\n---\nflowchart TD\nA → B\nC{ok} --> D')).toBe(
      '---\ntitle: Demo @{\n---\nflowchart TD\nA --> B\nC{ok} --> D',
    );
    expect(repairMermaidSource('flowchart TD\nA -->|literal @{ text| B\nC → D\nE{ok} --> F')).toBe(
      'flowchart TD\nA -->|"literal @{ text"| B\nC --> D\nE{ok} --> F',
    );
  });

  it.each(['\n', '; '])('回调名中的 -- 不影响后续形状属性和连线 (%j)', (separator) => {
    const prefix = 'flowchart TD\nclick A call foo--bar()' + separator;
    const node = 'C@{ shape: rect, label: start → done }';
    expect(repairMermaidSource(prefix + node + ' → D')).toBe(prefix + node + ' --> D');
  });

  it.each(['C:::foo--bar\n', 'C:::foo--bar-->'])('类名中的 -- 不影响后续节点 (%j)', (line) => {
    const prefix = 'flowchart TD\n' + line;
    const node = 'D@{ shape: rect, label: start → done }';
    expect(repairMermaidSource(prefix + node + '\nD → E')).toBe(prefix + node + '\nD --> E');
  });

  it.each([
    'accTitle: Demo @{ shape: stadium',
    'accDescr: Demo @{ shape: stadium',
    'A --> B; accTitle: Demo @{ shape: stadium',
    'A -- literal @{ shape: stadium --> B',
    'A -- literal\n@{ shape: stadium --> B',
    'A -. literal @{ shape: stadium .-> B',
  ])('保留 %s 中的普通文本并修复下一行', (line) => {
    const source = 'flowchart TD\n' + line + '\nC → D\nE{ok} --> F';
    expect(repairMermaidSource(source)).toBe(
      'flowchart TD\n' + line + '\nC --> D\nE{ok} --> F',
    );
  });

  it.each(['A[foo -- bar]', 'A([foo == bar])', 'A(foo -. bar)', 'A>foo -- bar]', 'A["`foo\n-- bar`"]'])(
    '保留 %s 后面的形状属性与连线',
    (node) => {
      expect(repairMermaidSource('flowchart TD\n' + node + '\nC@{ shape: rect, label: start → done }\nC → D')).toBe(
        'flowchart TD\n' + node + '\nC@{ shape: rect, label: start → done }\nC --> D',
      );
    },
  );

  it('未闭合的形状不会吞掉后面的完整标签和连线', () => {
    const prefix = 'flowchart TD\n' + 'A(('.repeat(600);
    expect(repairMermaidSource(prefix + ' C([go → stop]) → B')).toBe(
      prefix + ' C([go → stop]) --> B',
    );
  });

  it('已引号的节点标签内容不被二次改写', () => {
    const src = 'flowchart TD\nA["call foo(x:y)"] --> B';
    expect(repairMermaidSource(src)).toBe(src);
  });

  it('同一标签先补方括号引号后,内部圆括号不再二次加引号', () => {
    expect(repairMermaidSource('flowchart TD\nA[call foo(x:y)] --> B')).toBe(
      'flowchart TD\nA["call foo(x:y)"] --> B',
    );
  });

  it('非 flowchart 图不应用 flowchart 规则(er 基数语法保全)', () => {
    const src = 'erDiagram\nPERSON ||--o{ ORDER : places';
    expect(repairMermaidSource(src)).toBe(src);
  });

  it('frontmatter 之后识别 flowchart', () => {
    expect(repairMermaidSource('---\ntitle: demo\n---\nflowchart TD\nA → B')).toBe(
      '---\ntitle: demo\n---\nflowchart TD\nA --> B',
    );
  });

  it('%% 注释与指令行不动', () => {
    const src = 'flowchart TD\n%%{init: {"theme": "dark"}}%%\n%% a → b comment\nA --> B';
    expect(repairMermaidSource(src)).toBe(src);
  });

  it('内容保真:合法行未引号标签里的 unicode 箭头不被改写,先引号保护再替换', () => {
    // 整文档 parse 失败(第 3 行坏),但第 2 行本身合法——修复只能补引号,
    // 不能把标签文本「下单 → 支付」改成「下单 --> 支付」渲染出来
    expect(repairMermaidSource('flowchart TD\nA -->|下单 → 支付| B\nB → C')).toBe(
      'flowchart TD\nA -->|"下单 → 支付"| B\nB --> C',
    );
    // 节点标签同理:含箭头的标签先加引号保护,渲染文本不变
    expect(repairMermaidSource('flowchart TD\nA[go → stop] --> B\nB → C')).toBe(
      'flowchart TD\nA["go → stop"] --> B\nB --> C',
    );
  });

  it('规模闸:超长单行 / 超大文档直接原样返回,不跑二次方正则', () => {
    const hugeLine = `flowchart TD\n${'x'.repeat(100_000)}`;
    const start = Date.now();
    expect(repairMermaidSource(hugeLine)).toBe(hugeLine);
    // 未触发 O(n²) 回溯时远低于此上限;真跑回溯是十几秒量级
    expect(Date.now() - start).toBeLessThan(500);

    const hugeDoc = `flowchart TD\n${'A --> B\n'.repeat(20_000)}`;
    expect(repairMermaidSource(hugeDoc)).toBe(hugeDoc);
  });

  it('组合修复:截图同款架构图常见笔误一次修齐', () => {
    const src = [
      'flowchart TD',
      'subgraph Pub["发布侧"]',
      'CFG[仓内正本 config/client-endpoints.json] → OSS[OSS assets 桶]',
      'end',
      'OSS -->|CDN 公开读| CDN',
    ].join('\n');
    expect(repairMermaidSource(src)).toBe(
      [
        'flowchart TD',
        'subgraph Pub ["发布侧"]',
        // CFG 标签含 `/` 触发加引号;OSS 标签无危险字符,保持原样
        'CFG["仓内正本 config/client-endpoints.json"] --> OSS[OSS assets 桶]',
        'end',
        'OSS -->|"CDN 公开读"| CDN',
      ].join('\n'),
    );
  });
});
