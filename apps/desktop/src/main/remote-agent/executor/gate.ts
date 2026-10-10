/**
 * 远程 Agent 执行器的权限上限(控制端)。
 *
 * 分工：Agent 所在电脑上的 Cindy 用与本机任务完全相同的权限逻辑决定「问不问」(权限档、
 * 自动审查、会话内允许规则)，需要问的都弹到本机界面上让用户点。执行器在本机这一侧再守一道
 * 上限，保证另一台电脑无论如何不能越过本机用户：
 *  - 全权：一律放行(用户在本机为这个任务选了全权)；
 *  - 凭证类路径、静态可证的高危命令：本机任务这类操作总是逐次问用户，执行器只认本机用户
 *    刚批准过的同一操作；
 *  - 可写根外的写与工作区外的递归读：本机任务同样必问(auto-review 对区外写返回 prompt)，
 *    执行器只认本机用户批准过的同一操作 —— 反向请求按本机策略与规范批准重建，发起方那台
 *    电脑不可信时也不能绕过本机用户的目录授权；
 *  - 抓取网页：本机地址、内网与云 metadata 这类地址(与本机任务里 WebFetch / curl 同一判定)
 *    只认本机用户刚批准过的同一地址；批准过的地址抓取时放开内网(域名也可能解析到内网)；
 *  - 计划模式：只允许读取、抓取网页和静态可证只读的命令，其余同样要本机用户批准过；
 *  - 供应商分享的受邀者任务：内容会经过分享者的电脑，凭证类的读写与读取凭证的命令即使在全权下
 *    也只认本机用户批准过的同一操作(credentials.ts)。
 * 批准记录只在短时间内有效；命令与抓取的批准用一次即失效，路径批准在有效期内覆盖同一路径的读写
 * (编辑会先读后写)。
 */
import path from 'node:path';

import { classifyShellCommand, reviewAction } from '@cindy/maker-core';

import { isShareCredentialCommand, isShareCredentialPath } from '../credentials';
import { realPathOrAncestor, type ExecutorWorkspace } from './workspace';

/**
 * 与本机任务权限对应的上限档位：`full` = 全权；`plan` = 计划模式；其余权限档统一为 `normal`
 * (问不问由 Agent 侧的权限逻辑决定，这里只守高危上限)。
 */
export type ExecutorGateMode = 'full' | 'plan' | 'normal';

export type ExecutorAction =
  | { kind: 'read'; path: string; scope?: 'tree' }
  | { kind: 'write'; path: string }
  | { kind: 'exec'; command: string; cwd: string }
  | { kind: 'fetch'; url: string };

export interface ExecutorGateDecision {
  ok: boolean;
  /** 拒绝时给 Agent 看的原因。 */
  reason?: string;
  /** 放行来自全权或本机用户的批准，而不只是普通上限之内(抓取网页据此决定能否访问内网)。 */
  elevated?: boolean;
}

/** 批准记录的有效期：覆盖「确认后到真正执行」之间的间隔，过期须重新确认。 */
export const EXECUTOR_APPROVAL_TTL_MS = 2 * 60_000;
const MAX_APPROVALS = 256;

interface Approval {
  kind: 'path' | 'exec' | 'fetch';
  key: string;
  expiresAt: number;
}

export function executorGateModeFor(
  permissionMode: string | null | undefined,
  planMode = false,
): ExecutorGateMode {
  if (planMode || permissionMode === 'plan') return 'plan';
  return permissionMode === 'bypassPermissions' ? 'full' : 'normal';
}

function pathKey(target: string): string {
  return path.resolve(target);
}

function execKey(command: string, cwd: string): string {
  return `${path.resolve(cwd)}\\0${command}`;
}

function fetchKey(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function approvalOf(action: ExecutorAction): { kind: Approval['kind']; key: string } {
  switch (action.kind) {
    case 'exec':
      return { kind: 'exec', key: execKey(action.command, action.cwd) };
    case 'fetch':
      return { kind: 'fetch', key: fetchKey(action.url) };
    default:
      return { kind: 'path', key: pathKey(action.path) };
  }
}

export interface ExecutorGateOptions {
  /** 供应商分享的受邀者任务：凭证类操作不论权限档都要本机用户确认。 */
  confirmCredentials?: boolean;
}

export class ExecutorGate {
  private mode: ExecutorGateMode;
  private approvals: Approval[] = [];

  constructor(
    private readonly workspace: ExecutorWorkspace,
    mode: ExecutorGateMode = 'normal',
    private readonly now: () => number = Date.now,
    private readonly options: ExecutorGateOptions = {},
  ) {
    this.mode = mode;
  }

  setMode(mode: ExecutorGateMode): void {
    this.mode = mode;
  }

  getMode(): ExecutorGateMode {
    return this.mode;
  }

  /** 本机用户在确认卡上允许了一个操作后调用。 */
  recordApproval(action: ExecutorAction): void {
    this.prune();
    this.approvals.push({ ...approvalOf(action), expiresAt: this.now() + EXECUTOR_APPROVAL_TTL_MS });
    if (this.approvals.length > MAX_APPROVALS) this.approvals.splice(0, this.approvals.length - MAX_APPROVALS);
  }

  /**
   * 这个操作是否要按「凭证类」由本机用户确认(只在供应商分享的受邀者任务里)：读写凭证类路径(链接按
   * 真实目标再判一次)、目录级读取的根本身是凭证目录，或命令读取 / 打出凭证。
   */
  needsCredentialConsent(action: ExecutorAction): boolean {
    if (!this.options.confirmCredentials) return false;
    if (action.kind === 'fetch') return false;
    if (action.kind === 'exec') {
      return isShareCredentialCommand(action.command, this.workspace.allRoots(), { cwd: action.cwd, platform: process.platform });
    }
    return isShareCredentialPath(path.resolve(action.path)) || isShareCredentialPath(realPathOrAncestor(action.path));
  }

  authorize(action: ExecutorAction): ExecutorGateDecision {
    const credential = this.needsCredentialConsent(action);
    if (this.mode === 'full' && !credential) return { ok: true, elevated: true };
    // 抓取网页：本机用户批准过这个地址就放开内网。公网样式的域名也可能解析到内网(公司内网域名)，
    // 只看地址文本判定为不必问，但抓取时会按 DNS 结果被拦下。
    if (action.kind === 'fetch' && this.consume(action)) return { ok: true, elevated: true };
    if (!credential && !this.requiresApproval(action)) return { ok: true };
    if (this.consume(action)) return { ok: true, elevated: true };
    return { ok: false, reason: this.deniedReason(action) };
  }

  private deniedReason(action: ExecutorAction): string {
    return action.kind === 'exec'
      ? 'This command needs the user\'s confirmation on the computer where the task runs, and it was not confirmed.'
      : action.kind === 'fetch'
        ? `Fetching ${action.url} needs the user's confirmation on the computer where the task runs, and it was not confirmed.`
        : `Access to ${action.path} needs the user's confirmation on the computer where the task runs, and it was not confirmed.`;
  }

  private requiresApproval(action: ExecutorAction): boolean {
    if (action.kind === 'fetch') {
      // 只读的网络请求，计划模式也可以；本机、内网与 metadata 地址按本机任务的同一判定必问。
      return reviewAction({ kind: 'network', target: action.url }, this.workspace.allRoots()) === 'prompt-each-time';
    }
    if (action.kind === 'exec') {
      const verdict = classifyShellCommand(action.command, this.workspace.allRoots(), {
        cwd: action.cwd,
        platform: process.platform,
      });
      if (verdict === 'prompt-each-time') return true;
      return this.mode === 'plan' && verdict !== 'auto-approve';
    }
    if (this.workspace.isSensitive(action.path)) return true;
    if (action.kind === 'write') {
      // 本机任务里「可写根外的写必问用户」(auto-review 对区外写返回 prompt)：反向请求不能
      // 只信发起方(同账号电脑也可能被攻破)的权限逻辑代答，区外写只认本机用户刚批准过的同一
      // 操作，否则对方可在 Ask / Auto / accept-edits 下覆盖本机任意非凭证路径。
      return this.mode === 'plan' || !this.workspace.contains(action.path);
    }
    // 目录级递归读(搜索 / 列举)的根在工作区外 → 能遍历到区外的凭证子路径(如在 ~ 上 grep
    // 密钥)，与本机任务同样升级为必问；单文件读仍按本机语义放行。
    return action.scope === 'tree' && !this.workspace.contains(action.path);
  }

  private consume(action: ExecutorAction): boolean {
    this.prune();
    const { kind, key } = approvalOf(action);
    const index = this.approvals.findIndex((approval) => approval.kind === kind && approval.key === key);
    if (index < 0) return false;
    if (kind !== 'path') this.approvals.splice(index, 1);
    return true;
  }

  private prune(): void {
    const t = this.now();
    this.approvals = this.approvals.filter((approval) => approval.expiresAt > t);
  }
}
