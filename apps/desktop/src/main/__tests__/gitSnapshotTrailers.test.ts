/**
 * git-snapshot: commit message ⇄ 保存点元数据 的序列化/解析单测。
 *
 * 保存点用 git 原生 trailer (X-XDT-*) 把 {sessionId, kind, anchor} 落进 commit message,
 * git log 就是唯一事实源。非保存点 commit 必须被识别为 null。
 */

import { describe, it, expect } from 'vitest';

import {
  buildCommitMessage,
  parseSnapshotCommit,
} from '../git-snapshot/snapshotTrailers';

describe('snapshotTrailers', () => {
  it('round-trip: parse(build(...)) 还原 label/sessionId/kind/anchor', () => {
    const msg = buildCommitMessage('登录页定稿', {
      sessionId: 'sess-123',
      kind: 'after-edit',
      anchor: 'msg-456',
    });
    const parsed = parseSnapshotCommit(msg);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      label: '登录页定稿',
      sessionId: 'sess-123',
      kind: 'after-edit',
      anchor: 'msg-456',
    });
  });

  it('anchor 缺省: 不产生空 trailer 行, parse 出的 anchor 为 undefined', () => {
    const msg = buildCommitMessage('manual save', {
      sessionId: 'sess-1',
      kind: 'manual',
    });
    expect(msg).not.toContain('X-XDT-Anchor');
    const parsed = parseSnapshotCommit(msg);
    expect(parsed?.anchor).toBeUndefined();
    expect(parsed?.kind).toBe('manual');
  });

  it('round-trip: dirty-start rewind marker kind', () => {
    const msg = buildCommitMessage('blocked', {
      sessionId: 'sess-1',
      kind: 'rewind-blocked',
      anchor: 'msg-1',
    });

    expect(parseSnapshotCommit(msg)).toMatchObject({
      label: 'blocked',
      sessionId: 'sess-1',
      kind: 'rewind-blocked',
      anchor: 'msg-1',
    });
  });

  it('非保存点 commit (无 X-XDT-* trailer) → null', () => {
    expect(parseSnapshotCommit('fix: 普通用户提交\n\n一些正文说明')).toBeNull();
    expect(parseSnapshotCommit('')).toBeNull();
    expect(parseSnapshotCommit('feat: add thing')).toBeNull();
  });

  it('label 含冒号 / 多行不破坏 trailer 解析', () => {
    const label = 'AI 完成: 重写登录页\n\n顺带修了校验: 这一行也有冒号';
    const msg = buildCommitMessage(label, {
      sessionId: 'sess-x',
      kind: 'before-edit',
    });
    const parsed = parseSnapshotCommit(msg);
    expect(parsed?.label).toBe(label);
    expect(parsed?.sessionId).toBe('sess-x');
    expect(parsed?.kind).toBe('before-edit');
  });

  it('未知 kind 视为非法 → null (kind 是受控枚举)', () => {
    const fake = 'x\n\nX-XDT-Session: s1\nX-XDT-Kind: bogus-kind';
    expect(parseSnapshotCommit(fake)).toBeNull();
  });

  it('缺 Session 或缺 Kind → null', () => {
    expect(parseSnapshotCommit('x\n\nX-XDT-Kind: manual')).toBeNull();
    expect(parseSnapshotCommit('x\n\nX-XDT-Session: s1')).toBeNull();
  });

  it('容忍 git %B 末尾多余换行', () => {
    const msg = buildCommitMessage('t', { sessionId: 's1', kind: 'pre-rollback' }) + '\n\n';
    const parsed = parseSnapshotCommit(msg);
    expect(parsed?.kind).toBe('pre-rollback');
    expect(parsed?.label).toBe('t');
  });

  it('兼容 commit hook 追加的混合 trailer block', () => {
    const msg = `${buildCommitMessage('with signoff', {
      sessionId: 's1',
      kind: 'after-edit',
      anchor: 'm1',
    })}\nSigned-off-by: XDT <xdt@example.com>\nChange-Id: Iabc123`;

    expect(parseSnapshotCommit(msg)).toMatchObject({
      label: 'with signoff',
      sessionId: 's1',
      kind: 'after-edit',
      anchor: 'm1',
    });
  });

  it('兼容 commit hook 追加的 folded trailer continuation', () => {
    const msg = `${buildCommitMessage('with folded trailer', {
      sessionId: 's1',
      kind: 'after-edit',
      anchor: 'm1',
    })}\nSigned-off-by: XDT <xdt@example.com>\n continued by hook`;

    expect(parseSnapshotCommit(msg)).toMatchObject({
      label: 'with folded trailer',
      sessionId: 's1',
      kind: 'after-edit',
      anchor: 'm1',
    });
  });

  it('未来包含数字的 XDT trailer key 不会截断 trailer block', () => {
    const msg = `${buildCommitMessage('numeric key', {
      sessionId: 's1',
      kind: 'manual',
    })}\nX-XDT-Schema2: v1`;

    expect(parseSnapshotCommit(msg)).toMatchObject({
      label: 'numeric key',
      sessionId: 's1',
      kind: 'manual',
    });
  });

  it('解析前会展开 XDT trailer 自身的 folded value', () => {
    const msg = [
      'folded xdt value',
      '',
      'X-XDT-Session: s1',
      'X-XDT-Kind: rollback',
      'X-XDT-Reverts: c3,',
      ' c2',
      'X-XDT-ProtectRef: refs/xdt/pre-rollback/rb-1',
    ].join('\n');

    expect(parseSnapshotCommit(msg)).toMatchObject({
      label: 'folded xdt value',
      sessionId: 's1',
      kind: 'rollback',
      reverts: ['c3', 'c2'],
      protectRef: 'refs/xdt/pre-rollback/rb-1',
    });
  });

  it('rollback 元数据 round-trip', () => {
    const msg = buildCommitMessage('rollback', {
      sessionId: 's1',
      kind: 'rollback',
      rollbackId: 'rb-1',
      rollbackTarget: 'm2',
      reverts: ['c3', 'c2'],
      protectRef: 'refs/xdt/pre-rollback/rb-1',
      branch: 'main',
    });
    expect(parseSnapshotCommit(msg)).toMatchObject({
      label: 'rollback',
      kind: 'rollback',
      rollbackId: 'rb-1',
      rollbackTarget: 'm2',
      reverts: ['c3', 'c2'],
      protectRef: 'refs/xdt/pre-rollback/rb-1',
      branch: 'main',
    });
  });
});
