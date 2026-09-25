/**
 * 插件安装／更新的用户确认（docs/dev-rules/plugin-security-and-authoring.md §3.1）。
 *
 * 两段式，缺一不可：
 * 1. `obtainGhostInstallConsent` 在任何安装锁之外按策略求得确认——弹窗可能等几分钟，
 *    不能卡住其它插件的安装、卸载或自动更新；
 * 2. `assertGhostInstallConsent` 在安装锁内、落位前，用真实包与当前受体重算一次。
 *    确认后包内容或已装版本变了，就不能沿用这次确认。
 *
 * 每条安装路径都必须显式交出一个策略：用户或 Agent 发起的安装走 `prompt`，后台自动
 * 更新走 `automatic`（需要确认就跳过，不替用户点头），只有服务端默认安装走 `exempt`。
 */
import type { GhostManifest, InstalledGhost } from '../../shared/ghost.js';
import {
  evaluateGhostInstallConsent,
  ghostInstallConsentKey,
  type GhostInstallConsentFacts,
  type GhostInstallConsentInitiator,
  type GhostInstallConsentOrigin,
  type GhostInstallConsentRequest,
} from '../../shared/ghostInstallConsent.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** 向用户展示确认并等待回答；true = 用户确认安装。 */
export type GhostInstallConsentPrompt = (
  request: Omit<GhostInstallConsentRequest, 'requestId'>,
) => Promise<boolean>;

export type GhostInstallConsentPolicy =
  | {
      mode: 'prompt';
      prompt: GhostInstallConsentPrompt;
      initiator: GhostInstallConsentInitiator;
      origin: GhostInstallConsentOrigin;
      originLabel?: string;
    }
  /** 后台自动更新：不能弹窗，需要确认时抛 `GhostInstallConsentRequiredError`。 */
  | { mode: 'automatic' }
  /** 服务端默认安装的插件：首装与后续更新都由下发方决定，不向用户确认。 */
  | { mode: 'exempt'; reason: 'server-default-install' };

/** 求得的确认结论；随安装请求一路交到安装锁内复核。 */
export type GhostInstallConsentDecision =
  | { mode: 'confirmed'; key: string }
  /** 求确认时判定无需确认；落位前必须仍然无需确认。 */
  | { mode: 'unprompted' }
  | { mode: 'exempt'; reason: 'server-default-install' };

const pendingPromptAborts = new Set<AbortController>();

/**
 * 登记一次等待中的确认，账号边界时由 `abortAllGhostInstallConsentPrompts` 一并取消。
 * 确认不得占用 owner 租约；取消是为了让等待中的安装调用尽快按用户取消收口。
 * 返回的函数在确认结束后注销。
 */
export function trackGhostInstallConsentPrompt(controller: AbortController): () => void {
  pendingPromptAborts.add(controller);
  return () => {
    pendingPromptAborts.delete(controller);
  };
}

export function abortAllGhostInstallConsentPrompts(): void {
  for (const controller of Array.from(pendingPromptAborts)) controller.abort();
  pendingPromptAborts.clear();
}

/** 后台路径遇到需要用户确认的安装／更新。调用方据此跳过，而不是记为失败。 */
export class GhostInstallConsentRequiredError extends Error {
  readonly code = 'PRECONDITION_FAILED' as const;

  constructor(readonly facts: GhostInstallConsentFacts) {
    super(
      facts.kind === 'install'
        ? 'Plugin installation requires user confirmation'
        : 'Plugin update adds permissions and requires user confirmation',
    );
    this.name = 'GhostInstallConsentRequiredError';
  }
}

export function isGhostInstallConsentRequiredError(
  error: unknown,
): error is GhostInstallConsentRequiredError {
  return error instanceof GhostInstallConsentRequiredError;
}

/**
 * 按策略求得确认。用户拒绝抛 `MUTATION_CANCELLED`；确认界面不可用时 fail closed
 * 抛 `PRECONDITION_FAILED`；后台路径需要确认时抛 `GhostInstallConsentRequiredError`。
 */
export async function obtainGhostInstallConsent(
  policy: GhostInstallConsentPolicy,
  installed: InstalledGhost | null | undefined,
  manifest: GhostManifest,
): Promise<GhostInstallConsentDecision> {
  if (policy.mode === 'exempt') return { mode: 'exempt', reason: policy.reason };
  const facts = evaluateGhostInstallConsent(installed, manifest);
  if (!facts) return { mode: 'unprompted' };
  if (policy.mode === 'automatic') throw new GhostInstallConsentRequiredError(facts);
  let confirmed: boolean;
  try {
    confirmed = await policy.prompt({
      initiator: policy.initiator,
      origin: policy.origin,
      ...(policy.originLabel ? { originLabel: policy.originLabel } : {}),
      facts,
    });
  } catch {
    throwIpcError('PRECONDITION_FAILED', '当前无法显示插件安装确认，请稍后重试');
  }
  if (!confirmed) {
    throwIpcError(
      'MUTATION_CANCELLED',
      facts.kind === 'install' ? '用户取消了插件安装' : '用户取消了插件更新',
    );
  }
  return { mode: 'confirmed', key: ghostInstallConsentKey(facts) };
}

/**
 * 安装锁内、落位前的同步复核。`installedNow` 必须是锁内现读的已装插件，
 * `manifest` 必须来自即将落位的那份真实包。
 */
export function assertGhostInstallConsent(
  decision: GhostInstallConsentDecision,
  installedNow: InstalledGhost | null | undefined,
  manifest: GhostManifest,
): void {
  if (decision.mode === 'exempt') return;
  const facts = evaluateGhostInstallConsent(installedNow, manifest);
  if (!facts) return;
  if (decision.mode === 'confirmed' && decision.key === ghostInstallConsentKey(facts)) return;
  if (decision.mode === 'unprompted') throw new GhostInstallConsentRequiredError(facts);
  throwIpcError('PRECONDITION_FAILED', '插件内容在确认后发生了变化，请重新安装');
}
