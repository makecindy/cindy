import { describe, expect, it } from 'vitest';

import {
  classifyInlineCodeTarget,
  classifyMarkdownLinkTarget,
  looksLikeBareFileReference,
  splitLocalLineSuffix,
} from '../lib/markdownTarget';

describe('splitLocalLineSuffix', () => {
  it('parses path:line and path:line:column for local references', () => {
    expect(splitLocalLineSuffix('apps/desktop/src/App.tsx:42')).toEqual({
      href: 'apps/desktop/src/App.tsx',
      line: 42,
    });
    expect(splitLocalLineSuffix('D:/AI/xdt-maker/a.ts:12:3')).toEqual({
      href: 'D:/AI/xdt-maker/a.ts',
      line: 12,
      column: 3,
    });
    expect(splitLocalLineSuffix('C:\\repo\\src\\App.tsx:100:2')).toEqual({
      href: 'C:\\repo\\src\\App.tsx',
      line: 100,
      column: 2,
    });
    expect(splitLocalLineSuffix('file:///C:/repo/src/App.tsx:9')).toEqual({
      href: 'file:///C:/repo/src/App.tsx',
      line: 9,
    });
    expect(splitLocalLineSuffix('apps/server/src/services/skills.ts:316-320')).toEqual({
      href: 'apps/server/src/services/skills.ts',
      line: 316,
    });
  });

  it('does not strip ports from http URLs', () => {
    expect(splitLocalLineSuffix('http://localhost:3000')).toEqual({
      href: 'http://localhost:3000',
    });
    expect(splitLocalLineSuffix('https://example.com/a.ts:42')).toEqual({
      href: 'https://example.com/a.ts:42',
    });
  });
});

describe('looksLikeBareFileReference', () => {
  it('accepts bare code filenames and rejects ordinary identifiers', () => {
    expect(looksLikeBareFileReference('MarkdownRenderer.tsx')).toBe(true);
    expect(looksLikeBareFileReference('package.json')).toBe(true);
    expect(looksLikeBareFileReference('useState')).toBe(false);
    expect(looksLikeBareFileReference('npm run build')).toBe(false);
  });
});

describe('classifyMarkdownLinkTarget', () => {
  it('keeps supported external links clickable', () => {
    expect(classifyMarkdownLinkTarget('https://example.com/docs')).toEqual({
      kind: 'external',
      href: 'https://example.com/docs',
    });
  });

  it('keeps anchors and xdt audio as first-class targets', () => {
    expect(classifyMarkdownLinkTarget('#section')).toEqual({
      kind: 'anchor',
      id: 'section',
      href: '#section',
    });
    expect(classifyMarkdownLinkTarget('#%E9%93%BE%E6%8E%A5%E6%B5%8B%E8%AF%95%E6%A0%87%E9%A2%98')).toEqual({
      kind: 'anchor',
      id: '链接测试标题',
      href: '#%E9%93%BE%E6%8E%A5%E6%B5%8B%E8%AF%95%E6%A0%87%E9%A2%98',
    });
    expect(classifyMarkdownLinkTarget('xdt-audio://local/?path=%2Ftmp%2Fa.mp3')).toEqual({
      kind: 'audio',
      href: 'xdt-audio://local/?path=%2Ftmp%2Fa.mp3',
    });
  });

  it('routes xdt image/file URLs as direct image preview targets', () => {
    expect(classifyMarkdownLinkTarget('xdt-image://sess/a.png')).toEqual({
      kind: 'local-image-url',
      href: 'xdt-image://sess/a.png',
    });
    expect(classifyMarkdownLinkTarget('xdt-file://local/?path=%2Ftmp%2Fa.png')).toEqual({
      kind: 'local-image-url',
      href: 'xdt-file://local/?path=%2Ftmp%2Fa.png',
    });
  });

  it('turns explicit local links into pending local candidates until fs resolution proves them', () => {
    expect(classifyMarkdownLinkTarget('apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx')).toEqual({
      kind: 'local-candidate',
      href: 'apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx',
      originalHref: 'apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx',
      localKind: 'text',
    });
    expect(classifyMarkdownLinkTarget('D:/AI/xdt-maker/apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx:832')).toEqual({
      kind: 'local-candidate',
      href: 'D:/AI/xdt-maker/apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx',
      originalHref: 'D:/AI/xdt-maker/apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx:832',
      localKind: 'text',
      line: 832,
    });
    expect(classifyMarkdownLinkTarget('C:\\repo\\apps\\desktop\\src\\App.tsx:12')).toEqual({
      kind: 'local-candidate',
      href: 'C:\\repo\\apps\\desktop\\src\\App.tsx',
      originalHref: 'C:\\repo\\apps\\desktop\\src\\App.tsx:12',
      localKind: 'text',
      line: 12,
    });
    expect(classifyMarkdownLinkTarget('file:///C:/repo/apps/desktop/src/App.tsx:12')).toEqual({
      kind: 'local-candidate',
      href: 'file:///C:/repo/apps/desktop/src/App.tsx',
      originalHref: 'file:///C:/repo/apps/desktop/src/App.tsx:12',
      localKind: 'text',
      line: 12,
    });
    expect(classifyMarkdownLinkTarget('apps/server/src/services/skills.ts:316-320')).toEqual({
      kind: 'local-candidate',
      href: 'apps/server/src/services/skills.ts',
      originalHref: 'apps/server/src/services/skills.ts:316-320',
      localKind: 'text',
      line: 316,
    });
  });

  it('keeps bare filenames as resolvable code references instead of unsafe external links', () => {
    expect(classifyMarkdownLinkTarget('MarkdownRenderer.tsx')).toEqual({
      kind: 'local-candidate',
      href: 'MarkdownRenderer.tsx',
      originalHref: 'MarkdownRenderer.tsx',
      localKind: 'text',
    });
  });

  it("classifies 3D model files as localKind 'model' (link + inline code)", () => {
    expect(classifyMarkdownLinkTarget('~/Downloads/character.fbx')).toEqual({
      kind: 'local-candidate',
      href: '~/Downloads/character.fbx',
      originalHref: '~/Downloads/character.fbx',
      localKind: 'model',
    });
    // .gltf 是 JSON 文本;model 判定必须先于 text fallback,否则会拿到 'text'。
    expect(classifyMarkdownLinkTarget('assets/scene.gltf')).toEqual({
      kind: 'local-candidate',
      href: 'assets/scene.gltf',
      originalHref: 'assets/scene.gltf',
      localKind: 'model',
    });
    expect(classifyInlineCodeTarget('/abs/models/char.glb')).toEqual({
      kind: 'local-candidate',
      href: '/abs/models/char.glb',
      originalHref: '/abs/models/char.glb',
      localKind: 'model',
    });
  });

  it('resolves uploaded local file refs synchronously when the basename is unique', () => {
    expect(classifyMarkdownLinkTarget('Report.DOCX', [
      { name: 'Report.DOCX', path: 'C:\\Users\\me\\Downloads\\Report.DOCX' },
    ])).toEqual({
      kind: 'resolved-local',
      href: 'Report.DOCX',
      absPath: 'C:\\Users\\me\\Downloads\\Report.DOCX',
      localKind: 'text',
    });
  });

  it('does not render unsupported schemes or directories as clickable links', () => {
    expect(classifyMarkdownLinkTarget('mailto:me@example.com')).toEqual({
      kind: 'plain-text',
      href: 'mailto:me@example.com',
      reason: 'unsupported-scheme',
    });
    // 目录形态(尾斜杠)现在 candidate 化:去尾杠后走存在性解析,真实存在的
    // 目录点亮为 chip(点击定位进侧边栏文件浏览器),不存在保持纯文本。
    expect(classifyMarkdownLinkTarget('src/components/')).toEqual({
      kind: 'local-candidate',
      href: 'src/components',
      originalHref: 'src/components/',
      localKind: 'text',
    });
    expect(classifyMarkdownLinkTarget('ftp://example.com/a.ts')).toEqual({
      kind: 'plain-text',
      href: 'ftp://example.com/a.ts',
      reason: 'unsupported-scheme',
    });
  });

  it('keeps non-target markdown hrefs as plain text', () => {
    expect(classifyMarkdownLinkTarget('hello')).toEqual({
      kind: 'plain-text',
      href: 'hello',
      reason: 'not-a-target',
    });
  });
});

describe('classifyInlineCodeTarget', () => {
  it('promotes path-shaped inline code to local candidates', () => {
    expect(classifyInlineCodeTarget('src/App.tsx')).toEqual({
      kind: 'local-candidate',
      href: 'src/App.tsx',
      originalHref: 'src/App.tsx',
      localKind: 'text',
    });
    expect(classifyInlineCodeTarget('src/App.tsx:18')).toEqual({
      kind: 'local-candidate',
      href: 'src/App.tsx',
      originalHref: 'src/App.tsx:18',
      localKind: 'text',
      line: 18,
    });
    expect(classifyInlineCodeTarget('C:\\repo\\src\\App.tsx:18')).toEqual({
      kind: 'local-candidate',
      href: 'C:\\repo\\src\\App.tsx',
      originalHref: 'C:\\repo\\src\\App.tsx:18',
      localKind: 'text',
      line: 18,
    });
    expect(classifyInlineCodeTarget('file:///C:/repo/src/App.tsx')).toEqual({
      kind: 'local-candidate',
      href: 'file:///C:/repo/src/App.tsx',
      originalHref: 'file:///C:/repo/src/App.tsx',
      localKind: 'text',
    });
    expect(classifyInlineCodeTarget('apps/server/src/services/skills.ts:316-320')).toEqual({
      kind: 'local-candidate',
      href: 'apps/server/src/services/skills.ts',
      originalHref: 'apps/server/src/services/skills.ts:316-320',
      localKind: 'text',
      line: 316,
    });
  });

  it('keeps ordinary inline code as non-target code', () => {
    expect(classifyInlineCodeTarget('useState')).toBeNull();
    expect(classifyInlineCodeTarget('npm run build')).toBeNull();
    expect(classifyInlineCodeTarget('https://example.com/a.ts')).toBeNull();
  });
});
