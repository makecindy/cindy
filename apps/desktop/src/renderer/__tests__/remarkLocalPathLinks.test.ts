/**
 * remarkLocalPathLinks.test.ts
 * ---------------------------------------------------------------------------
 * 单元测试:确保 remarkLocalPathLinks 能把正文纯文本里"带分隔符、可解析形状"
 * 的路径 token 切成 link 节点,同时不误吞普通词 / URL / 裸文件名,也不碰已经在
 * link 里的文本。
 *
 * 插件是 unified plugin,接收 mdast 树并原地修改。测试直接构造 AST 调用插件
 * 函数,避免依赖 `remark` 解析器(项目未显式安装),与 remarkTruncateCjkUrls
 * 的测试方式一致。
 */

import { describe, it, expect } from 'vitest';
import type { Root, Link, Text, Paragraph, PhrasingContent } from 'mdast';
import remarkLocalPathLinks from '../components/chat/remarkLocalPathLinks';

const transform = (remarkLocalPathLinks as () => (tree: Root) => void)();

/** 一个 paragraph 里放一段纯文本。 */
function textTree(value: string): Root {
  const text: Text = { type: 'text', value };
  const para: Paragraph = { type: 'paragraph', children: [text] };
  return { type: 'root', children: [para] };
}

function runOnText(value: string): PhrasingContent[] {
  const tree = textTree(value);
  transform(tree);
  return (tree.children[0] as Paragraph).children;
}

/** 抽出被切成 link 的 url 列表,方便断言"哪些 token 变成了链接"。 */
function linkUrls(children: PhrasingContent[]): string[] {
  return children.filter((c): c is Link => c.type === 'link').map((l) => l.url);
}

describe('remarkLocalPathLinks', () => {
  // ── 应该 linkify 的场景 ──

  it('正文里的相对路径(带分隔符 + 扩展名)', () => {
    const out = runOnText('见 src/App.tsx 第 20 行');
    expect(linkUrls(out)).toEqual(['src/App.tsx']);
    // 前后纯文本保留,路径只切出中间那段。
    expect((out[0] as Text).value).toBe('见 ');
    expect((out[2] as Text).value).toBe(' 第 20 行');
  });

  it('深层相对路径', () => {
    const out = runOnText('改的是 apps/desktop/src/main/pathResolver.ts 这个文件');
    expect(linkUrls(out)).toEqual(['apps/desktop/src/main/pathResolver.ts']);
  });

  it('Windows 绝对路径', () => {
    const out = runOnText('文件在 C:\\Users\\me\\proj\\app.tsx 里');
    expect(linkUrls(out)).toEqual(['C:\\Users\\me\\proj\\app.tsx']);
  });

  it('POSIX 绝对路径', () => {
    const out = runOnText('路径 /Users/me/proj/app.tsx 打开看看');
    expect(linkUrls(out)).toEqual(['/Users/me/proj/app.tsx']);
  });

  it('带 :line 行号后缀整体进 url,渲染层再拆', () => {
    const out = runOnText('见 src/App.tsx:42 那行');
    expect(linkUrls(out)).toEqual(['src/App.tsx:42']);
  });

  it('一段里多个路径都切出来', () => {
    const out = runOnText('对比 src/a.ts 和 src/b.ts');
    expect(linkUrls(out)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('剥两侧包裹标点:括号 / 句末逗号', () => {
    expect(linkUrls(runOnText('(见 src/App.tsx)'))).toEqual(['src/App.tsx']);
    expect(linkUrls(runOnText('改了 src/App.tsx,然后呢'))).toEqual(['src/App.tsx']);
    expect(linkUrls(runOnText('文件:src/App.tsx。完'))).toEqual(['src/App.tsx']);
  });

  it('含 CJK 目录名的相对路径', () => {
    const out = runOnText('在 docs/设计稿/index.md 里');
    expect(linkUrls(out)).toEqual(['docs/设计稿/index.md']);
  });

  it('./ ../ ~/ 锚点的相对路径(单层也认)', () => {
    expect(linkUrls(runOnText('打开 ./foo.md 看'))).toEqual(['./foo.md']);
    expect(linkUrls(runOnText('在 ../sib/foo.json 里'))).toEqual(['../sib/foo.json']);
    expect(linkUrls(runOnText('日志 ~/logs/app.log 末尾'))).toEqual(['~/logs/app.log']);
  });

  it('前面是 ASCII 冒号也认(文件:src/x.ts)', () => {
    expect(linkUrls(runOnText('文件:src/App.tsx。完'))).toEqual(['src/App.tsx']);
  });

  // ── 不应该 linkify 的场景 ──

  it('裸文件名(无分隔符)不动——正文里太歧义', () => {
    const out = runOnText('改一下 package.json 配置');
    expect(linkUrls(out)).toEqual([]);
  });

  it('普通带斜杠的词不动:and/or、读写比', () => {
    expect(linkUrls(runOnText('支持 and/or 两种'))).toEqual([]);
    expect(linkUrls(runOnText('读/写 比例'))).toEqual([]);
  });

  it('URL 不动(裸文本形态,无扩展名结尾且带 scheme)', () => {
    expect(linkUrls(runOnText('看 https://example.com/path/page 这个'))).toEqual([]);
  });

  it('目录(尾部分隔符)不动', () => {
    expect(linkUrls(runOnText('放在 src/components/ 下'))).toEqual([]);
  });

  it('已经在 link 里的文本不碰(避免嵌套链接)', () => {
    const inner: Text = { type: 'text', value: 'src/App.tsx' };
    const link: Link = { type: 'link', url: 'src/App.tsx', children: [inner] };
    const para: Paragraph = { type: 'paragraph', children: [link] };
    const tree: Root = { type: 'root', children: [para] };
    transform(tree);
    const kids = (tree.children[0] as Paragraph).children;
    expect(kids).toHaveLength(1);
    expect((kids[0] as Link).children).toHaveLength(1);
    expect(((kids[0] as Link).children[0] as Text).value).toBe('src/App.tsx');
  });

  it('已知限制:中文紧贴路径无空白边界时,前导中文会被并入 token', () => {
    // CJK 既可能是 prose(见)也可能是真实目录名(我的看板),词法层无法区分。
    // 紧贴无空白时,前导"见"被并进路径 → "见src/App.tsx" 解析不到真实文件 →
    // 走现有链路降级成纯文本,最终仍然点不动(与现状一致,非回退);拿不到干净的
    // src/App.tsx 而已。
    expect(linkUrls(runOnText('见src/App.tsx'))).toEqual(['见src/App.tsx']);
  });

  it('已知限制:中文黏连两条真路径会吞成一个 token,两条都点不亮', () => {
    // 中间的"和"被当成路径段,整串成一个 token,解析不到 → 两条真路径都降级纯
    // 文本。比"前导紧贴"影响更大;救它只能把 CJK 当分隔符,但会反过来切断
    // docs/设计稿/index.md 里的中文目录名,得不偿失,故不做。
    expect(linkUrls(runOnText('改了 a/b.ts和c/d.ts'))).toEqual(['a/b.ts和c/d.ts']);
  });

  it('负例:版本号 / 宽高比等会进 candidate,但靠 resolve 闸门兜底不变 chip', () => {
    // 16/9.0、a/b.c 形状上满足"带分隔符 + 扩展名",会被切成 candidate link;
    // 但主进程 resolve 找不到真实文件 → 现有链路渲染成纯 <span>,不会变 chip。
    // tokenizer 单测只能固化"进 candidate"这一层;"不变 chip"由 resolve 闸门保证。
    expect(linkUrls(runOnText('比例 16/9.0 居中'))).toEqual(['16/9.0']);
    expect(linkUrls(runOnText('记作 a/b.c 即可'))).toEqual(['a/b.c']);
  });

  it('完全没有路径的句子原样不动', () => {
    const out = runOnText('这是一句普通的中文,没有任何路径。');
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('text');
  });
});
