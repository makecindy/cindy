import { describe, expect, it } from 'vitest';

import {
  parseIssueEnvHarness,
  parseIssueEnvModelId,
  parseIssueEnvRegion,
  parseOptionalGithubUserIdentity,
  parseIssueSuggestedPublicName,
  parseIssueSubmissionIdentity,
} from '@/lib/issueConfirmPayload';

describe('issue runtime metadata parsers', () => {
  it('只接受三个公开 Harness 全名', () => {
    expect(parseIssueEnvHarness('Claude Code')).toBe('Claude Code');
    expect(parseIssueEnvHarness('Codex')).toBe('Codex');
    expect(parseIssueEnvHarness('Pi')).toBe('Pi');
    expect(parseIssueEnvHarness('cc')).toBeUndefined();
    expect(parseIssueEnvHarness('cx')).toBeUndefined();
    expect(parseIssueEnvHarness(undefined)).toBeUndefined();
  });

  it('把模型 ID 规范成有界单行值并兼容旧 Main 缺失字段', () => {
    expect(parseIssueEnvModelId('  custom\nmodel  ')).toBe('custom model');
    expect(parseIssueEnvModelId('x'.repeat(201))).toBe('x'.repeat(200));
    expect(parseIssueEnvModelId('')).toBeUndefined();
    expect(parseIssueEnvModelId(undefined)).toBeUndefined();
  });
});

describe('parseIssueSubmissionIdentity', () => {
  it('保留 GitHub 用户和平台的实际 login', () => {
    expect(parseIssueSubmissionIdentity({ kind: 'github-user', login: ' octocat ' })).toEqual({
      kind: 'github-user',
      login: 'octocat',
    });
    expect(parseIssueSubmissionIdentity({ kind: 'platform', login: 'cindy-issue' })).toEqual({
      kind: 'platform',
      login: 'cindy-issue',
    });
  });

  it('拒绝缺失 login 或未知 kind', () => {
    expect(parseIssueSubmissionIdentity({ kind: 'github-user', login: '' })).toBeNull();
    expect(parseIssueSubmissionIdentity({ kind: 'other', login: 'someone' })).toBeNull();
    expect(parseIssueSubmissionIdentity(null)).toBeNull();
  });
});

describe('parseOptionalGithubUserIdentity', () => {
  it('只保留完整的 GitHub 用户身份，非法可选值按缺失处理', () => {
    expect(parseOptionalGithubUserIdentity({ kind: 'github-user', login: ' octocat ' })).toEqual({
      kind: 'github-user',
      login: 'octocat',
    });
    expect(
      parseOptionalGithubUserIdentity({ kind: 'platform', login: 'cindy-issue' }),
    ).toBeUndefined();
    expect(parseOptionalGithubUserIdentity({ kind: 'github-user', login: '' })).toBeUndefined();
  });
});

describe('parseIssueEnvRegion', () => {
  it('保留三种合法构建区域', () => {
    expect(parseIssueEnvRegion('cn')).toBe('cn');
    expect(parseIssueEnvRegion('global')).toBe('global');
    expect(parseIssueEnvRegion('dev')).toBe('dev');
  });

  it('未知 / 缺失 / 非字符串一律 undefined,不猜区域', () => {
    // 猜错的代价是把中国版用户的反馈标成国际版,宁可不展示。
    expect(parseIssueEnvRegion('CN')).toBeUndefined();
    expect(parseIssueEnvRegion('china')).toBeUndefined();
    expect(parseIssueEnvRegion(undefined)).toBeUndefined();
    expect(parseIssueEnvRegion(null)).toBeUndefined();
    expect(parseIssueEnvRegion(1)).toBeUndefined();
  });
});

describe('parseIssueSuggestedPublicName', () => {
  it('trims a valid single-line public name', () => {
    expect(parseIssueSuggestedPublicName('  Cindy User  ')).toBe('Cindy User');
  });

  it('drops empty, over-long, control-character and line-separator values', () => {
    expect(parseIssueSuggestedPublicName('')).toBeUndefined();
    expect(parseIssueSuggestedPublicName('x'.repeat(101))).toBeUndefined();
    expect(parseIssueSuggestedPublicName('line 1\nline 2')).toBeUndefined();
    expect(parseIssueSuggestedPublicName('line 1\u0085line 2')).toBeUndefined();
    expect(parseIssueSuggestedPublicName('line 1\u009fline 2')).toBeUndefined();
    expect(parseIssueSuggestedPublicName('line 1\u2028line 2')).toBeUndefined();
    expect(parseIssueSuggestedPublicName('line 1\u2029line 2')).toBeUndefined();
  });
});
