/**
 * git-snapshot: commit message ⇄ 保存点元数据 的序列化/解析单测。
 *
 * 保存点用 git 原生 trailer 把 {sessionId, kind, anchor, ...} 落进 commit message,
 * git log 就是唯一事实源。非保存点 commit 必须被识别为 null。
 *
 * 两代前缀并存: X-XDT-*(legacy, 直接 commit 到用户分支)与 X-Cindy-*
 * (shadow savepoint 隐藏引用链)。parse 结果必带 source 区分代际,
 * 两种前缀同现时 X-Cindy 优先。
 */

import { describe, it, expect } from 'vitest';

import {
  buildCindyCommitMessage,
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
      source: 'legacy-xdt',
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
      source: 'legacy-xdt',
    });
  });

  it('buildCindyCommitMessage 往返: turn-start kind + baseHead', () => {
    const msg = buildCindyCommitMessage('本轮开始时的工作区基线', {
      sessionId: 'sess-9',
      kind: 'turn-start',
      anchor: 'msg-9',
      branch: 'main',
      baseHead: 'headsha0001',
    });

    expect(msg).toContain('X-Cindy-Session: sess-9');
    expect(msg).not.toContain('X-XDT-');
    expect(parseSnapshotCommit(msg)).toMatchObject({
      label: '本轮开始时的工作区基线',
      sessionId: 'sess-9',
      kind: 'turn-start',
      anchor: 'msg-9',
      branch: 'main',
      baseHead: 'headsha0001',
      source: 'cindy',
    });
  });

  it('buildCindyCommitMessage 往返: after-edit 带 baselineCommit → source=cindy', () => {
    const msg = buildCindyCommitMessage('AI 修改后', {
      sessionId: 'sess-9',
      kind: 'after-edit',
      anchor: 'msg-10',
      baselineCommit: 'turnstart0001',
    });

    const parsed = parseSnapshotCommit(msg);
    expect(parsed).toMatchObject({
      label: 'AI 修改后',
      sessionId: 'sess-9',
      kind: 'after-edit',
      anchor: 'msg-10',
      baselineCommit: 'turnstart0001',
      source: 'cindy',
    });
  });

  it('buildCindyCommitMessage 往返: rollback marker 带 preRollbackCommit/reverts', () => {
    const msg = buildCindyCommitMessage('rollback marker', {
      sessionId: 'sess-9',
      kind: 'rollback',
      rollbackId: 'rb-9',
      rollbackTarget: 'msg-2',
      reverts: ['s3', 's2'],
      preRollbackCommit: 'prerollback01',
    });

    expect(parseSnapshotCommit(msg)).toMatchObject({
      label: 'rollback marker',
      sessionId: 'sess-9',
      kind: 'rollback',
      rollbackId: 'rb-9',
      rollbackTarget: 'msg-2',
      reverts: ['s3', 's2'],
      preRollbackCommit: 'prerollback01',
      source: 'cindy',
    });
  });

  it('两种前缀同现时 X-Cindy 优先 (构造性用例, 实际不会发生)', () => {
    const msg = [
      'mixed prefixes',
      '',
      'X-XDT-Session: legacy-sess',
      'X-XDT-Kind: manual',
      'X-Cindy-Session: cindy-sess',
      'X-Cindy-Kind: after-edit',
      'X-Cindy-Baseline: base-1',
    ].join('\n');

    expect(parseSnapshotCommit(msg)).toMatchObject({
      label: 'mixed prefixes',
      sessionId: 'cindy-sess',
      kind: 'after-edit',
      baselineCommit: 'base-1',
      source: 'cindy',
    });
  });

  it('X-Cindy 字段不完整时回退到同 commit 的合法 X-XDT 块', () => {
    const msg = [
      'partial cindy',
      '',
      'X-XDT-Session: legacy-sess',
      'X-XDT-Kind: manual',
      'X-Cindy-Baseline: base-1',
    ].join('\n');

    expect(parseSnapshotCommit(msg)).toMatchObject({
      label: 'partial cindy',
      sessionId: 'legacy-sess',
      kind: 'manual',
      source: 'legacy-xdt',
    });
  });
});
