import { describe, expect, it } from 'vitest';

import {
  collectGhostReadmeImagePaths,
  inlineGhostReadmeReferenceImages,
  resolveGhostReadmeAssetPath,
} from '../readme.js';

// 详细介绍图片的包内路径解析(readme.ts):宿主读图和界面查表共用这一个函数。
// 它是"只显示包内图片"的边界:外部地址、越出包根或非图片格式一旦被解析成路径,
// 宿主就会去读包外文件或界面会去加载外部图片。
describe('resolveGhostReadmeAssetPath', () => {
  it.each<[string, string, string | null]>([
    ['README.md', 'assets/shot.png', 'assets/shot.png'],
    ['docs/README.md', './shot.webp', 'docs/shot.webp'],
    ['docs/README.md', '../assets/shot.png', 'assets/shot.png'],
    ['docs/README.md', 'img%2Fshot.png', 'docs/img/shot.png'],
    ['README.md', '../outside.png', null],
    ['README.md', 'https://example.com/a.png', null],
    ['README.md', '//example.com/a.png', null],
    ['README.md', 'data:image/png;base64,AAAA', null],
    ['README.md', '/abs/a.png', null],
    ['README.md', 'a.png?x=1', null],
    ['README.md', 'icon.svg', null],
    ['README.md', 'my shot.png', null],
  ])('%s + %s', (readmePath, src, expected) => {
    expect(resolveGhostReadmeAssetPath(readmePath, src)).toBe(expected);
  });

  // 打包检查与运行时读取共用这一份结果：代码示例里的图片语法不能让打包失败，
  // 引用式图片缺文件则必须被发现。
  it('collects only real markdown images, including reference style', () => {
    const markdown = [
      '![a](assets/a.png) ![b](https://cdn.example.com/b.png)',
      '<img src="./assets/html.jpg">',
      '`![inline](assets/code.png)`',
      '```md',
      '![fenced](assets/fenced.png)',
      '```',
      '![ref][shot] ![short] ![dup](assets/a.png)',
      '',
      '[shot]: assets/shot.webp "title"',
      '[short]: <assets/short.gif>',
    ].join('\n');
    expect(collectGhostReadmeImagePaths(markdown, 'README.md')).toEqual([
      'assets/a.png',
      'assets/shot.webp',
      'assets/short.gif',
    ]);
  });

  // Main 进程同步调用收集器；128 KB 的未闭合 `![` 曾因回溯扫描耗时约 30 秒。
  it('scans pathological bodies in linear time', () => {
    const started = Date.now();
    expect(collectGhostReadmeImagePaths('!['.repeat(65536), 'README.md')).toEqual([]);
    expect(collectGhostReadmeImagePaths('![a]('.repeat(26000), 'README.md')).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // 手机解析器只认行内图片：规范化后引用式图片变成行内、定义行消失，代码里的示例不动。
  it('rewrites reference images to inline form for the phone', () => {
    const markdown = [
      '![ref][shot] ![short] ![none][missing]',
      '`![code][shot]`',
      '```',
      '[shot]: assets/in-code.png',
      '```',
      '',
      '[shot]: assets/shot.webp',
      '[short]: assets/short.gif',
    ].join('\n');
    expect(inlineGhostReadmeReferenceImages(markdown)).toBe(
      [
        '![ref](assets/shot.webp) ![short](assets/short.gif) ![none][missing]',
        '`![code][shot]`',
        '```',
        '[shot]: assets/in-code.png',
        '```',
        '',
      ].join('\n'),
    );
  });
});
