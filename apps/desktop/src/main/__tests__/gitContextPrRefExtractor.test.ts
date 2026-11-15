/**
 * git-context/prRefExtractor 单测 — PR URL 确定性提取与去重。
 */

import { describe, it, expect } from 'vitest';

import { extractPrRefs, messageContentToText } from '../git-context/prRefExtractor';

describe('extractPrRefs', () => {
  it('提取标准 PR URL,owner/repo 规范化为小写', () => {
    const refs = extractPrRefs('PR 已创建: https://github.com/makecindy/cindy/pull/85');
    expect(refs).toEqual([
      {
        owner: 'makecindy',
        repo: 'cindy',
        prNumber: 85,
        url: 'https://github.com/makecindy/cindy/pull/85',
      },
    ]);
  });

  it('同一 PR 的大小写变体规范化后去重(防唯一索引重复行)', () => {
    const refs = extractPrRefs(
      'https://github.com/makecindy/cindy/pull/85 https://github.com/MakeCindy/cindy/pull/85',
    );
    expect(refs).toHaveLength(1);
  });

  it('PR 子路径 / query / hash 规范化为 PR 首页', () => {
    const refs = extractPrRefs(
      '看下 https://github.com/o/r/pull/12/files?diff=split#diff-abc 这个改动',
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].url).toBe('https://github.com/o/r/pull/12');
  });

  it('同一 PR 多次出现去重,不同 PR 保序', () => {
    const text = [
      'https://github.com/o/r/pull/1',
      'https://github.com/o/r/pull/2',
      'https://github.com/o/r/pull/1/files',
    ].join(' ');
    const refs = extractPrRefs(text);
    expect(refs.map((r) => r.prNumber)).toEqual([1, 2]);
  });

  it('忽略 issue / commit / 非 github 链接与裸 #号', () => {
    const text = [
      'https://github.com/o/r/issues/3',
      'https://github.com/o/r/commit/abcdef',
      'https://gitlab.com/o/r/-/issues/4',
      '#85',
    ].join(' ');
    expect(extractPrRefs(text)).toEqual([]);
  });

  it('http 与 www 前缀也接受,repo 名 .git 后缀剥离', () => {
    const refs = extractPrRefs('http://www.github.com/o/r.git/pull/9');
    expect(refs[0]).toMatchObject({ owner: 'o', repo: 'r', prNumber: 9 });
  });
});

describe('messageContentToText', () => {
  it('字符串原样返回', () => {
    expect(messageContentToText('hello')).toBe('hello');
  });

  it('结构化 content stringify 后可被扫描', () => {
    const content = { text: '提了 https://github.com/o/r/pull/7', attachments: [] };
    expect(extractPrRefs(messageContentToText(content))).toHaveLength(1);
  });

  it('null / undefined 返回空串', () => {
    expect(messageContentToText(null)).toBe('');
    expect(messageContentToText(undefined)).toBe('');
  });
});

// Unit: provider/host identity and multi-level namespaces are new observable inputs;
// the old GitHub-only extractor silently dropped these associations.
it('recognizes HTTPS GitLab MRs without authentication and keeps hosts distinct', () => {
  const refs = extractPrRefs(
    'https://git.example.com/one/two/project/-/merge_requests/7 https://other.example.com/one/two/project/-/merge_requests/7 http://git.example.com/one/project/-/merge_requests/8',
  );
  expect(refs).toHaveLength(2);
  expect(refs[0]).toMatchObject({
    provider: 'gitlab',
    host: 'git.example.com',
    owner: 'one/two',
    repo: 'project',
    prNumber: 7,
    url: 'https://git.example.com/one/two/project/-/merge_requests/7',
  });
  expect(refs[1].host).toBe('other.example.com');
  expect(extractPrRefs('https://secret@git.example.com/g/p/-/merge_requests/1')).toEqual([]);
});
