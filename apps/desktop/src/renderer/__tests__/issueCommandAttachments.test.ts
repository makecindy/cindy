/**
 * issueCommandAttachments.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for: fix-issue-cmd-image-attachments
 *
 * 背景:桌面端 `/issue` 反馈命令(desktop slash command)在发送时只带预设整理
 * 指令、丢弃了 composer 里贴的图片附件 —— 图片在发送那一刻就没进对话,agent
 * 根本收不到。修复让 `/issue` 携带的 composer 附件正确随消息送达 agent。
 *
 * `/issue` 的附件**不随命令 payload 走 main IPC 往返**(AttachedFile 是 renderer
 * 层类型,且发送后 composer 会 clearFiles),而是在 dispatch 前于 renderer 侧
 * 快照到一个 ref,待 main 广播 DESKTOP_COMMAND_TRIGGERED 回流时由 issue effect
 * 取用。本文件两部分:
 *   1) 纯逻辑镜像 —— 复刻 CCAgentSessionView 里 relay 的核心时序契约,不渲染 React;
 *   2) 源码不变式 —— 断言 CCAgentSessionView.tsx 三处接线存在,防被后续改动回退。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// ── Part 1: relay 时序契约(镜像 maybeDispatchDesktopSlashCommand + issue effect)──
// 复刻真实决策流,独立于 React / IPC 单测:
//   - dispatch 前:仅当命中的是 desktop `/issue` 命令,才把 composer 附件快照进 relay;
//     其它 desktop 命令(/help /clear /cmd ...)不写,避免污染下一次 /issue。
//   - 回流:取用即清(consume 后 ref 归 undefined)。
interface RelayCmd {
  name: string;
  kind: 'desktop' | 'agent-builtin' | 'agent-skill';
}

function makeIssueFilesRelay<F>() {
  let snapshot: F[] | undefined;
  return {
    /** 对应 maybeDispatchDesktopSlashCommand:命中 desktop 命令返回 true(且仅 /issue 快照 files)。 */
    dispatch(hit: RelayCmd | undefined, files: F[] | undefined): boolean {
      if (hit?.kind !== 'desktop') return false;
      if (hit.name === 'issue') {
        snapshot = files && files.length > 0 ? files : undefined;
      }
      return true;
    },
    /** 对应 issue effect:取用即清。 */
    consume(): F[] | undefined {
      const f = snapshot;
      snapshot = undefined;
      return f;
    },
  };
}

const ISSUE: RelayCmd = { name: 'issue', kind: 'desktop' };
const HELP: RelayCmd = { name: 'help', kind: 'desktop' };
const COMPACT: RelayCmd = { name: 'compact', kind: 'agent-builtin' };

describe('/issue attachment relay contract', () => {
  it('snapshots composer files on /issue dispatch and hands them back on consume', () => {
    const relay = makeIssueFilesRelay<string>();
    const handled = relay.dispatch(ISSUE, ['xdt-image://a.png', 'xdt-image://b.png']);
    expect(handled).toBe(true);
    expect(relay.consume()).toEqual(['xdt-image://a.png', 'xdt-image://b.png']);
  });

  it('yields undefined when /issue carries no attachments', () => {
    const relay = makeIssueFilesRelay<string>();
    relay.dispatch(ISSUE, undefined);
    expect(relay.consume()).toBeUndefined();

    relay.dispatch(ISSUE, []); // 空数组视同无附件
    expect(relay.consume()).toBeUndefined();
  });

  it('does NOT snapshot files for non-issue desktop commands (no cross-command leak)', () => {
    const relay = makeIssueFilesRelay<string>();
    const handled = relay.dispatch(HELP, ['xdt-image://a.png']);
    expect(handled).toBe(true); // 仍作为 desktop 命令被处理
    expect(relay.consume()).toBeUndefined(); // 但附件没被 /help 误捕
  });

  it('is consume-once: a second consume without re-dispatch is empty', () => {
    const relay = makeIssueFilesRelay<string>();
    relay.dispatch(ISSUE, ['xdt-image://a.png']);
    expect(relay.consume()).toEqual(['xdt-image://a.png']);
    expect(relay.consume()).toBeUndefined();
  });

  it('a later /issue overwrites an un-consumed snapshot (latest wins)', () => {
    const relay = makeIssueFilesRelay<string>();
    relay.dispatch(ISSUE, ['xdt-image://old.png']);
    relay.dispatch(ISSUE, ['xdt-image://new.png']);
    expect(relay.consume()).toEqual(['xdt-image://new.png']);
  });

  it('returns false for non-desktop commands (forwarded to agent, relay untouched)', () => {
    const relay = makeIssueFilesRelay<string>();
    expect(relay.dispatch(COMPACT, ['xdt-image://a.png'])).toBe(false);
    expect(relay.dispatch(undefined, ['xdt-image://a.png'])).toBe(false);
    expect(relay.consume()).toBeUndefined();
  });
});

// ── Part 2: 源码不变式(锁住 CCAgentSessionView.tsx 三处接线)────────────────
const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);

describe('CCAgentSessionView /issue attachment wiring', () => {
  it('declares the pendingIssueFilesRef snapshot ref', () => {
    expect(sessionViewSource).toContain(
      'const pendingIssueFilesRef = useRef<AttachedFile[] | undefined>(undefined);',
    );
  });

  it('snapshots files only for the /issue command before dispatch', () => {
    const guard = sessionViewSource.indexOf("if (hit.name === 'issue') {");
    const snapshot = sessionViewSource.indexOf('pendingIssueFilesRef.current = files', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(guard);
  });

  it('passes composer files through both dispatch entry points', () => {
    // 已有会话:handleSend 把当前 composer files 交给命令 dispatch。
    expect(sessionViewSource).toMatch(
      /maybeDispatchDesktopSlashCommand\(message, files(?:,|\))/,
    );
    // 新建会话:首条消息补发时把 pending.files 交给命令 dispatch(此前被静默丢弃)。
    expect(sessionViewSource).toMatch(
      /maybeDispatchDesktopSlashCommand\(\s*pending\.text,\s*pending\.files,/,
    );
  });

  it('consumes the snapshot (consume-once) and forwards it to handleSend in the issue effect', () => {
    const read = sessionViewSource.indexOf('const issueFiles = pendingIssueFilesRef.current;');
    const clear = sessionViewSource.indexOf('pendingIssueFilesRef.current = undefined;', read);
    const forward = sessionViewSource.indexOf('issueFiles,', clear);
    expect(read).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(read);
    expect(forward).toBeGreaterThan(clear);
  });
});
