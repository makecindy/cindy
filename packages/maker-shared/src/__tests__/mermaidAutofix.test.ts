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

  it('形状变体标签里的 unicode 箭头不改写', () => {
    const src = [
      'flowchart TD',
      'A([stadium → text]) --> B[[subroutine ⟶ text]]',
      'C{{hexagon ⇒ text}} --> D[(database ➜ text)]',
    ].join('\n');
    expect(repairMermaidSource(src)).toBe(src);
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

  it('形状变体与非对称形状的标签体整段受保护,引号与成对括号不会提前收尾', () => {
    const src = [
      'flowchart TD',
      'A([before → "quoted" after → text]) --> B[[subroutine ⟶ text]]',
      'C([输入 (含括号) → 输出])',
      'D{{hex → text}}',
      'E[(database ⟶ text)]',
      'F>asymmetric → text]',
      'G → H',
    ].join('\n');
    const out = repairMermaidSource(src);
    expect(out).toContain('A([before → "quoted" after → text])');
    expect(out).toContain('B[[subroutine ⟶ text]]');
    expect(out).toContain('C([输入 (含括号) → 输出])');
    expect(out).toContain('D{{hex → text}}');
    expect(out).toContain('E[(database ⟶ text)]');
    expect(out).toContain('F>asymmetric → text]');
    // 标签之外的边仍然照常修复
    expect(out).toContain('G --> H');
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

// review: 二次方扫描与跨行标签
describe('label scanning stays linear and spans lines', () => {
  it('keeps an arrow inside a label that spans two lines', () => {
    const out = repairMermaidSource('flowchart TD\n  A([foo\n→ bar]) --> B\n  C → D');
    expect(out).toContain('A([foo\n→ bar])');
    expect(out).toContain('C --> D');
  });

  it('keeps a comment from leaking quotes into the scan', () => {
    const out = repairMermaidSource('flowchart TD\n%% "TODO\nA → B');
    expect(out).toContain('%% "TODO');
    expect(out).toContain('A --> B');
  });
  it('protects an asymmetric label on a non-ascii id', () => {
    const out = repairMermaidSource('flowchart TD\n  节点>go → stop] --> B\n  C → D');
    expect(out).toContain('节点>go → stop]');
    expect(out).toContain('C --> D');
  });

  it('skips a frontmatter block before scanning the graph', () => {
    const out = repairMermaidSource('---\ntitle: \'Draft "v1\'\n---\nflowchart TD\n  A → B');
    expect(out).toContain('A --> B');
  });

  it('keeps a lone quote inside a slash shape from swallowing the next line', () => {
    const out = repairMermaidSource('flowchart TD\n  A[/say " → later/] --> B\n  B → C');
    expect(out).toContain('A[/say " → later/]');
    expect(out).toContain('B --> C');
  });
  it('skips frontmatter whose delimiter lines carry trailing blanks', () => {
    const out = repairMermaidSource('--- \ntitle: \'Draft "v1\'\n--- \nflowchart TD\n  A → B');
    expect(out).toContain('A --> B');
  });
  it('protects an asymmetric label on an id that ends with a dot or a hyphen', () => {
    const dotted = repairMermaidSource('flowchart TD\n  foo.>go → stop] --> B\n  B → C');
    expect(dotted).toContain('foo.>go → stop]');
    expect(dotted).toContain('B --> C');
    const hyphen = repairMermaidSource('flowchart TD\n  foo->go → stop] --> B\n  B → C');
    expect(hyphen).toContain('foo->go → stop]');
    expect(hyphen).toContain('B --> C');
  });
  it('resets the edge tip run after punctuation that closes a source id', () => {
    const out = repairMermaidSource('flowchart TD\n  A.-->B\n  E → F\n  C[label]');
    expect(out).toContain('A.-->B');
    expect(out).toContain('E --> F');
  });
  it('ends a circle head before a dotted target id that opens an asymmetric label', () => {
    const out = repairMermaidSource('flowchart TD\n  A--o.>go → stop]\n  E → F');
    expect(out).toContain('A--o.>go → stop]');
    expect(out).toContain('E --> F');
  });

  it('leaves an ascii edge tip alone before a slash shape', () => {
    const out = repairMermaidSource('flowchart TD\nA --> B\n  C[/go → stop/] --> D\n  D → E');
    expect(out).toContain('C[/go → stop/]');
    expect(out).toContain('D --> E');
  });

  it('keeps a failed bare-edge scan from hiding a later label', () => {
    const out = repairMermaidSource(
      'flowchart TD\n  A -- foo [bar --> B\n  C[/go → stop/] --> D\n  E → F',
    );
    expect(out).toContain('C[/go → stop/]');
    expect(out).toContain('E --> F');
  });
  it('protects an asymmetric label on an id that ends with punctuation runs', () => {
    for (const source of ['flowchart TD\n  foo..>go → stop] --> B\n  C → D', 'flowchart TD\n  foo.->go → stop] --> B\n  C → D']) {
      const out = repairMermaidSource(source);
      expect(out).toContain('go → stop]');
      expect(out).toContain('C --> D');
    }
  });
  it('skips frontmatter that starts with a byte order mark', () => {
    const out = repairMermaidSource('\uFEFF---\ntitle: \'Draft "v1\'\n---\nflowchart TD\n  A → B');
    expect(out.startsWith('\uFEFF')).toBe(true);
    expect(out).toContain('A --> B');
  });

  it('keeps a quoted closer inside a compound shape label from ending it early', () => {
    const sources = [
      'flowchart TD\n  A(["use ]) \u2192 later"])\n  B \u2192 C',
      'flowchart TD\n  A[["use ]] \u2192 later"]]\n  B \u2192 C',
      'flowchart TD\n  A[("use )] \u2192 later")]\n  B \u2192 C',
    ];
    for (const src of sources) {
      const out = repairMermaidSource(src);
      expect(out).toContain(src.split('\n')[1]);
      expect(out).toContain('B --> C');
    }
  });

  it('keeps a quoted closer inside a label from ending the label early', () => {
    const out = repairMermaidSource('flowchart TD\n  A["use ] → later"] --> B\n  C → D');
    expect(out).toContain('A["use ] → later"]');
    expect(out).toContain('C --> D');
  });

  it('does not let an accessibility declaration leak a quote into the scan', () => {
    const out = repairMermaidSource('flowchart TD\n  accTitle: Draft "v1\n  A → B');
    expect(out).toContain('accTitle: Draft "v1');
    expect(out).toContain('A --> B');
    const block = repairMermaidSource('flowchart TD\n  accDescr {\n  "draft v1\n  }\n  A → B');
    expect(block).toContain('A --> B');
  });

  it('keeps the quoted label value of an object metadata node intact', () => {
    const out = repairMermaidSource('flowchart TD\n  A@{ shape: rect, label: "use } → later" } --> B\n  C → D');
    expect(out).toContain('label: "use } → later"');
    expect(out).toContain('C --> D');
  });

  it('keeps a quoted label value inside a slash shape intact', () => {
    const out = repairMermaidSource('flowchart TD\n  A[/"use ] → later"/] --> B\n  C → D');
    expect(out).toContain('"use ] → later"');
    expect(out).toContain('C --> D');
  });

  it('does not let a compact bare edge text open a label', () => {
    const out = repairMermaidSource('flowchart TD\n  A -- foo[bar --> B\n  C → D\n  E[label]');
    expect(out).toContain('A -- foo[bar --> B');
    expect(out).toContain('C --> D');
  });

  it('does not let a glued bare edge text open a label', () => {
    for (const edge of ['A--foo[bar-->B', 'A==foo[bar==>B', 'A-.foo[bar.->B']) {
      const out = repairMermaidSource(`flowchart TD\n  ${edge}\n  C → D\n  E[label]`);
      expect(out).toContain(edge);
      expect(out).toContain('C --> D');
    }
  });

  it('leaves a compact dotted edge tip alone before a following label', () => {
    const out = repairMermaidSource('flowchart TD\n  A -.label.-> B\n  C → D\n  E[label]');
    expect(out).toContain('A -.label.-> B');
    expect(out).toContain('C --> D');
  });

  it('leaves a bidirectional edge tip alone before a following label', () => {
    for (const tip of ['<-->', '<==>', '-. label .->']) {
      const out = repairMermaidSource(
        `flowchart TD\n  A ${tip} B\n  C[/go \u2192 stop/] --> D\n  E \u2192 F`,
      );
      expect(out).toContain(`A ${tip} B`);
      expect(out).toContain('C[/go \u2192 stop/]');
      expect(out).toContain('E --> F');
    }
  });

  it('leaves a stretched dotted edge tip alone before a slash shape', () => {
    for (const tip of ['-..->', '-...->']) {
      const out = repairMermaidSource(
        `flowchart TD\n  A ${tip} B\n  C[/go → stop/] --> D\n  E → F`,
      );
      expect(out).toContain(`A ${tip} B`);
      expect(out).toContain('C[/go → stop/]');
      expect(out).toContain('E --> F');
    }
  });

  it('keeps every quoted metadata value from ending the object body', () => {
    const src =
      'flowchart TD\nA@{ img: "https://x/a}.png", label: "go \u2192 stop", pos: "t", h: 60 }\n  // note';
    const out = repairMermaidSource(src);
    expect(out).toContain('A@{ img: "https://x/a}.png", label: "go \u2192 stop", pos: "t", h: 60 }');
  });

  it('keeps a quoted circle label from ending the circle early', () => {
    const src = 'flowchart TD\nA(("use )) \u2192 later")) --> B\n  // note';
    const out = repairMermaidSource(src);
    expect(out).toContain('A(("use )) \u2192 later"))');
    expect(out).toContain('--> B');
  });

  it('keeps a long run of edge characters linear', () => {
    // Both gates must stay open, otherwise repairMermaidSource returns the source
    // untouched and the scan below never runs: one line of 1 880 `>` plus the
    // comment stays under MAX_REPAIR_LINE_LENGTH, and 50 of them stay under
    // MAX_REPAIR_SOURCE_LENGTH. The comment rewrite proves the scan ran.
    const line = `  A ${'>'.repeat(1_880)} B`;
    const body = Array.from({ length: 50 }, () => line).join('\n');
    const src = `flowchart TD\n${body}\n  // note`;
    expect(line.length).toBeLessThan(2_000);
    expect(src.length).toBeLessThan(100_000);
    // Counting the characters the scan copies keeps this regression deterministic:
    // walking the punctuation run back for every `>` copied about 88 MB on this
    // input, while counting the run copies about 500 KB. A wall-clock budget would
    // fail whenever the shared CI worker is descheduled, independent of the code.
    const originalSlice = String.prototype.slice;
    let copied = 0;
    String.prototype.slice = function (this: string, start?: number, end?: number): string {
      const from = start ?? 0;
      const to = end ?? this.length;
      if (to > from) copied += to - from;
      return originalSlice.call(this, start, end);
    } as typeof originalSlice;
    let out = '';
    try {
      out = repairMermaidSource(src);
    } finally {
      String.prototype.slice = originalSlice;
    }
    expect(out).toContain('  %% note');
    expect(out).toContain(body);
    expect(copied).toBeLessThan(1_000_000);
  });
});

describe('quotes, complete edges and block headers', () => {
  it('does not rescan the label body for every quote', () => {
    // Every line stays under MAX_REPAIR_LINE_LENGTH and the whole source under
    // MAX_REPAIR_SOURCE_LENGTH, so the scan really runs; the label is a quoted
    // circle body that holds a quote every other character.
    const line = 'x"'.repeat(950);
    const source = ['flowchart TD', '  A(("first', ...Array.from({ length: 45 }, () => line), '")) --> B'].join('\n');
    expect(line.length).toBeLessThan(2_000);
    expect(source.length).toBeLessThan(100_000);
    // Counting the characters the scan copies keeps this regression deterministic.
    // Reading the body again for every quote copied 2.2 MB on this input; keeping
    // the last two non-space characters copies 171 KB.
    const originalSlice = String.prototype.slice;
    let copied = 0;
    String.prototype.slice = function (this: string, start?: number, end?: number): string {
      const from = start ?? 0;
      const to = end ?? this.length;
      if (to > from) copied += to - from;
      return originalSlice.call(this, start, end);
    } as typeof originalSlice;
    let output = '';
    try {
      output = repairMermaidSource(source);
    } finally {
      String.prototype.slice = originalSlice;
    }
    expect(output).toContain('--> B');
    expect(copied).toBeLessThan(500_000);
  });

  it('leaves a complete edge token before a shape label alone', () => {
    const source = ['flowchart TD', '  A --o B; C[/go \u2192 stop/] --> D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('C[/go \u2192 stop/]');
    expect(output).not.toContain('go --> stop');
  });

  it('keeps a one-line accessibility description out of the scan', () => {
    const source = ['flowchart TD', '  accDescr { a diagram }', '  A \u2192 B'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('accDescr { a diagram }');
    expect(output).toContain('A --> B');
  });

  it('consumes a complete edge token before scanning the rest of the line', () => {
    // `A---B` carries no text, but leaving `--B` behind made the glued-text skipper
    // run over `C[go -> stop]`, whose quoted value then lost its arrow.
    const source = ['flowchart TD', '  E \u2192 F', '  A---B; C[go \u2192 stop] --> D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('E --> F');
    expect(output).toContain('go \u2192 stop');
    expect(output).not.toContain('go --> stop');
  });

  it('recognises a compact circle head glued to the target id', () => {
    const source = ['flowchart TD', '  E \u2192 F', '  A--oB; C[go \u2192 stop] --> D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('go \u2192 stop');
    expect(output).not.toContain('go --> stop');
  });

  it('ends a bare edge text at a tip without an arrow head', () => {
    const source = ['flowchart TD', '  A -- foo --- B; C[go \u2192 stop] --> D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('go \u2192 stop');
    expect(output).not.toContain('go --> stop');
  });

  it('accepts a semicolon after the closing line of a description block', () => {
    const source = ['flowchart TD', '  accDescr {', '  };', '  A \u2192 B'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('};');
    expect(output).toContain('A --> B');
  });

  it('keeps a subgraph title out of the scan', () => {
    const source = ['flowchart TD', '  subgraph group [left \u2192 right]', '  C \u2192 D', '  end'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('subgraph group [left \u2192 right]');
    expect(output).toContain('C --> D');
  });

  it('ends a bare edge text at a dotted terminator', () => {
    // `-. foo .->` closes with `.-`, so the terminator starts on a `.`. Scanning
    // past it carried the next node's label into the rewrite. The same terminator
    // may be glued to the label (`-.foo.->`), where the position no longer decides.
    for (const line of ['  A -. foo .-> B', '  A -. foo .-o B', '  A -. foo .- B', '  A -.foo.-> B']) {
      const source = ['flowchart TD', `${line}; C[/go \u2192 stop/] --> D`].join('\n');
      const output = repairMermaidSource(source);
      expect(output).toContain(line);
      expect(output).toContain('go \u2192 stop');
      expect(output).not.toContain('go --> stop');
    }
  });

  it('skips an indented frontmatter delimiter', () => {
    // The delimiter may carry leading spaces, and `isFlowchartSource()` already
    // accepts it through `trim()`. The lone quote in the YAML value must not
    // swallow the graph below.
    const source = ['  ---', '  title: \'Draft "v1\'', '  ---', '  flowchart TD', '  A \u2192 B'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain("title: 'Draft \"v1'");
    expect(output).toContain('A --> B');
  });

  it('accepts whitespace between the description brace and its semicolon', () => {
    const source = ['flowchart TD', '  accDescr {', '  } ;', '  A \u2192 B'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('} ;');
    expect(output).toContain('A --> B');
  });

  it('restores the outer metadata body when a nested shape closes', () => {
    // The nested `[on]` closes before the `img` string, so the `@{` string state
    // has to come back with the outer body; otherwise the `}` inside the URL ends
    // the metadata early and the label loses its arrow.
    const source = [
      'flowchart TD',
      '  A@{ shape: rect, constraint: [on], img: "https://x/a}.png", label: "go \u2192 stop" }',
      '  // note',
    ].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('constraint: [on]');
    expect(output).toContain('go \u2192 stop');
    expect(output).not.toContain('go --> stop');
  });

  it('ends a bare edge text at a stretched dotted terminator', () => {
    for (const line of ['  A -. foo ..-> B', '  A -. foo ...-> B']) {
      const source = ['flowchart TD', `${line}`, '  C[/go \u2192 stop/] --> D'].join('\n');
      const output = repairMermaidSource(source);
      expect(output).toContain(line);
      expect(output).toContain('go \u2192 stop');
      expect(output).not.toContain('go --> stop');
    }
  });

  it('does not read a statement inside a quoted edge label', () => {
    const source = [
      'flowchart TD',
      '  A -->|"foo; accTitle: Draft"| B',
      '  C \u2192 D',
    ].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('foo; accTitle: Draft');
    expect(output).toContain('C --> D');
  });

  it('scans the rest of the line after a one-line description block', () => {
    const source = ['flowchart TD', '  accDescr { foo }; A \u2192 B'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('accDescr { foo };');
    expect(output).toContain('A --> B');
  });

  it('accepts a target id that starts with a dash after a circle head', () => {
    const source = [
      'flowchart TD',
      '  A--o-B; C[go \u2192 stop] --> D',
      '  E \u2192 F',
    ].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('A--o-B');
    expect(output).toContain('go \u2192 stop');
    expect(output).not.toContain('go --> stop');
  });

  it('inherits the metadata flag instead of walking the openers again', () => {
    const source = ['flowchart TD', '  A[[[[x"]]]]', '  C \u2192 D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('C --> D');
  });

  it('keeps the quotes of a skipped bare edge text', () => {
    const source = [
      'flowchart TD',
      '  A -- "go \u2192 stop" --> B',
      '  C \u2192 D',
    ].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('go \u2192 stop');
    expect(output).not.toContain('go --> stop');
    expect(output).toContain('C --> D');
  });

  it('accepts a target id that starts with a run of dots', () => {
    const source = [
      'flowchart TD',
      '  A--o..B; C["go \u2192 stop"] --> D',
      '  E \u2192 F',
    ].join('\n');
    const output = repairMermaidSource(source);
    expect(output).not.toContain('go --> stop');
  });

  it('consumes a circle head that is followed by an edge label', () => {
    const source = [
      'flowchart TD',
      '  A --o|edge| B; C["go \u2192 stop"] --> D',
      '  E \u2192 F',
    ].join('\n');
    const output = repairMermaidSource(source);
    // The edge label itself gets quoted by the plain-text rule; what matters here
    // is that the head is consumed and the label of `C` keeps its arrow.
    expect(output).toContain('edge');
    expect(output).not.toContain('go --> stop');
  });

  it('keeps an accessibility keyword inside a multi-line quoted label', () => {
    const source = [
      'flowchart TD',
      '  A -->|"foo',
      'accTitle: Draft"| B',
      '  C \u2192 D',
    ].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('accTitle: Draft');
    expect(output).toContain('C --> D');
  });

  it('scans the rest of the closing line of a multi-line description', () => {
    const source = ['flowchart TD', '  accDescr {', 'foo', '}; A \u2192 B'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('}; A --> B');
  });

  it('walks a long run of dots once', () => {
    const lines = ['flowchart TD'];
    for (let k = 0; k < 50; k += 1) lines.push('  ' + '.'.repeat(1880));
    const source = lines.join('\n');
    expect(source.length).toBeLessThan(100_000);
    const copy = String.prototype.slice;
    let copied = 0;
    // eslint-disable-next-line no-extend-native
    (String.prototype as unknown as Record<string, unknown>).slice = function (this: string, a?: number, b?: number) {
      const out = copy.call(this, a, b);
      copied += out.length;
      return out;
    };
    try {
      repairMermaidSource(source);
    } finally {
      (String.prototype as unknown as Record<string, unknown>).slice = copy;
    }
    expect(copied).toBeLessThan(1_000_000);
  });

  it('keeps a later metadata array value a string', () => {
    const source = [
      'flowchart TD',
      '  A@{ shape: rect, constraint: [on, "off]"], label: "go \u2192 stop" }',
      '  C \u2192 D',
    ].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('"off]"');
    expect(output).toContain('C --> D');
  });

  it('consumes the head of a stretched bare edge terminator', () => {
    const source = [
      'flowchart TD',
      '  A--foo--->B; C \u2192 D; E[label]',
    ].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('A--foo--->B');
    expect(output).toContain('C --> D');
  });

  it('keeps a quoted value inside nested metadata a string', () => {
    // The quote sits in the second stack frame, so the metadata context has to
    // travel with the stack: otherwise the `]` inside the string pops the array
    // and the rest of the document stays inside the unclosed metadata body.
    const source = [
      'flowchart TD',
      '  A@{ shape: rect, constraint: ["off]"] }',
      '  C \u2192 D',
    ].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('constraint: ["off]"]');
    expect(output).toContain('C --> D');
  });

  it('consumes a long run of dashes as one complete edge token', () => {
    // A fixed lookahead window cuts the run and hands the tail to the glued-text
    // skipper, which then runs over the label of the next node on the line.
    const source = [
      'flowchart TD',
      '  E \u2192 F',
      '  A----------B; C[go \u2192 stop] --> D',
    ].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('A----------B');
    expect(output).toContain('go \u2192 stop');
    expect(output).not.toContain('go --> stop');
  });

  it('keeps an accessibility declaration after a semicolon out of the scan', () => {
    const source = ['flowchart TD', '  A-->B; accTitle: Draft "v1', '  C \u2192 D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('accTitle: Draft "v1');
    expect(output).toContain('C --> D');
  });
  it('leaves a source-side edge head alone before a shape label', () => {
    for (const head of ['o--', 'x--', '<--']) {
      const source = ['flowchart TD', `  A ${head} B; C[/go \u2192 stop/] --> D`, '  E \u2192 F'].join('\n');
      const output = repairMermaidSource(source);
      expect(output).toContain('C[/go \u2192 stop/]');
      expect(output).not.toContain('go --> stop');
      expect(output).toContain('E --> F');
    }
  });

  it('recognises an accessibility declaration after a description separator', () => {
    const source = [
      'flowchart TD',
      '  accDescr { foo }; accTitle: Draft "v1',
      '  A --> B',
      '  C \u2192 D',
    ].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('accTitle: Draft "v1');
    expect(output).toContain('C --> D');
  });

  it('walks a long run of dots and dashes once', () => {
    // The dash run after the dots is remembered too, so a long alternating payload
    // does not repeat the dash walk at every dot.
    const lines = ['flowchart TD'];
    for (let k = 0; k < 50; k += 1) lines.push('  ' + '.'.repeat(940) + '-'.repeat(939) + '=');
    const source = lines.join('\n');
    expect(source.length).toBeLessThan(100_000);
    const copy = String.prototype.slice;
    let copied = 0;
    // eslint-disable-next-line no-extend-native
    (String.prototype as unknown as Record<string, unknown>).slice = function (this: string, a?: number, b?: number) {
      const out = copy.call(this, a, b);
      copied += out.length;
      return out;
    };
    try {
      repairMermaidSource(source);
    } finally {
      (String.prototype as unknown as Record<string, unknown>).slice = copy;
    }
    expect(copied).toBeLessThan(1_000_000);
  });

  it('keeps a quote glued to an id out of the scan', () => {
    // `screen5"` is an id with a stray quote, not the start of a string, so the next
    // statement is still graph syntax.
    const source = ['flowchart TD', '  screen5" --> B; C --> D', '  E \u2192 F'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('screen5"');
    expect(output).toContain('E --> F');
  });

  it('consumes a dotted tip that follows a source head', () => {
    for (const head of ['o.->', 'x.->', '<.->']) {
      const source = ['flowchart TD', `  A ${head} B; C[/go \u2192 stop/] --> D`, '  E \u2192 F'].join('\n');
      const output = repairMermaidSource(source);
      expect(output).toContain('C[/go \u2192 stop/]');
      expect(output).not.toContain('go --> stop');
      expect(output).toContain('E --> F');
    }
  });

  it('ends a description block on a line that carries text before the brace', () => {
    const source = ['flowchart TD', '  accDescr {', 'foo }; A --> B', '  C \u2192 D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('C --> D');
  });

  it('does not open a label at a bare scalar in object metadata', () => {
    // `foo(` is a bare scalar value, not a nested shape, so the `}` behind it still
    // closes the metadata and the next statement is graph syntax again.
    const source = ['flowchart TD', '  A@{ shape: rect, label: foo( }', '  C \u2192 D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('A@{ shape: rect, label: foo( }');
    expect(output).toContain('C --> D');
  });

  it('still opens a nested shape value in object metadata', () => {
    const source = ['flowchart TD', '  A@{ shape: rect, constraint: [on], label: foo( }', '  C \u2192 D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('constraint: [on]');
    expect(output).toContain('C --> D');
  });

  it('keeps the title of a subgraph that follows a semicolon', () => {
    const source = ['flowchart TD', '  A --> B; subgraph id [go \u2192 stop]', '  C \u2192 D', '  end'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('subgraph id [go \u2192 stop]');
    expect(output).not.toContain('subgraph id [go --> stop]');
    expect(output).toContain('C --> D');
  });

  it('stops a quoted bare edge text at the tip behind the quotes', () => {
    const source = ['flowchart TD', '  A -- "go --> stop" --> B', '  C \u2192 D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('A -- "go --> stop" --> B');
    expect(output).toContain('C --> D');
  });

  it('keeps a quote behind a non-ascii id in the token', () => {
    const source = ['flowchart TD', '  \u5c4f\u5e55" --> B', '  C \u2192 D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('\u5c4f\u5e55"');
    expect(output).toContain('C --> D');
  });
  it('does not open a label at a bracket that starts a metadata scalar', () => {
    // `(foo` is a bare scalar too, so the same rule as for `foo(` applies: the
    // metadata closes at its own `}` and the next statement is graph syntax.
    const source = ['flowchart TD', '  A@{ shape: rect, label: (foo }', '  C → D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('A@{ shape: rect, label: (foo }');
    expect(output).toContain('C --> D');
  });

  it('still opens a flow sequence that starts a metadata value', () => {
    const source = ['flowchart TD', '  A@{ shape: rect, constraint: [(on)], label: ok }', '  C → D'].join('\n');
    const output = repairMermaidSource(source);
    expect(output).toContain('constraint: [(on)]');
    expect(output).toContain('C --> D');
  });

  it('consumes a source head that follows a node closer', () => {
    // `A[label]o.->B` is legal Mermaid: the head is glued to the closer of the
    // source node, so the `]` has to end the token like a space does.
    for (const head of ['o.->', 'x.->', '<.->']) {
      const source = ['flowchart TD', `  A[label]${head}B; C → D; E[label]`].join('\n');
      const output = repairMermaidSource(source);
      expect(output).toContain(`A[label]${head}B`);
      expect(output).toContain('C --> D');
    }
  });
});
