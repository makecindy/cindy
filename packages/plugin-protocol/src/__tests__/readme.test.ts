import { describe, expect, it } from 'vitest';

import { collectGhostReadmeImagePaths, resolveGhostReadmeAssetPath } from '../readme.js';

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

  it('collects package image references in order without duplicates or external URLs', () => {
    const markdown = [
      '![a](assets/a.png) ![b](https://cdn.example.com/b.png)',
      '<img src="./assets/c.jpg" width="320">',
      '[ref]: assets/a.png',
    ].join('\n');
    expect(collectGhostReadmeImagePaths(markdown, 'README.md')).toEqual([
      'assets/a.png',
      'assets/c.jpg',
    ]);
  });
});
