/**
 * Agent 发起的插件安装／更新确认，投成任务里的宿主权限确认卡。
 *
 * 复用通用 `permission` 交互（hostOwnedConfirmation 标记），因此桌面对话、手机远控和
 * IM 渠道卡都能直接显示「允许／拒绝」，旧版手机也不需要升级；它由 Main 主动发起，
 * 不经 Agent 自身的审批回调，Full Access 也跳不过。
 *
 * 文案在 Main 侧按当前界面语言渲染成纯文本：第一行是版本与来源，其后是权限清单。
 * 手机按原样逐行显示；桌面卡片把第一行作为说明、其余放进可滚动的操作区。
 */
import { randomUUID } from 'node:crypto';

import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';

import type { GhostPermissionItem } from '../../shared/ghost.js';
import {
  GHOST_INSTALL_CONSENT_TOOL_NAME,
  type GhostInstallConsentRequest,
} from '../../shared/ghostInstallConsent.js';
import { t as mainTranslate } from '../i18n.js';
import {
  trackGhostInstallConsentPrompt,
  type GhostInstallConsentPrompt,
} from './ghostInstallConsent.js';

export const GHOST_INSTALL_CONSENT_HOST_CONFIRMATION = 'plugin_install';

type Translate = (key: string) => string;

function interpolate(template: string, args: Record<string, string> | undefined): string {
  if (!args) return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(args, name) ? args[name]! : match,
  );
}

function consentText(translate: Translate, key: string, args?: Record<string, string>): string {
  return interpolate(translate(`settings.ghosts.installConsent.${key}`), args);
}

/** 来源说明：包从哪里来，Agent 发起时再标明发起方。桌面确认框与任务卡共用。 */
export function ghostInstallConsentSourceText(
  translate: Translate,
  request: Pick<GhostInstallConsentRequest, 'initiator' | 'origin' | 'originLabel'>,
): string {
  const origin =
    request.origin === 'market'
      ? consentText(translate, 'originMarket')
      : request.origin === 'custom-market'
        ? request.originLabel
          ? consentText(translate, 'originCustomMarket', { name: request.originLabel })
          : consentText(translate, 'originCustomMarketUnnamed')
        : request.origin === 'local-file'
          ? consentText(translate, 'originLocalFile')
          : consentText(translate, 'originForge');
  return request.initiator === 'agent'
    ? consentText(translate, 'initiatedByAgent', { origin })
    : origin;
}

function permissionLine(translate: Translate, item: GhostPermissionItem): string {
  const lines = [
    `• ${interpolate(translate(`settings.ghosts.perm.${item.labelKey}`), item.labelArgs)}`,
  ];
  if (item.detailKey) {
    lines.push(
      `  ${interpolate(translate(`settings.ghosts.perm.${item.detailKey}`), item.detailArgs)}`,
    );
  }
  if (item.detail) {
    for (const detailLine of item.detail.split('\n')) {
      lines.push(`  ${detailLine}`);
    }
  }
  return lines.join('\n');
}

/** 把一次确认渲染成标题、首行说明与权限清单（纯文本）。 */
export function renderGhostInstallConsentText(
  request: Omit<GhostInstallConsentRequest, 'requestId'>,
  translate: Translate = mainTranslate,
): { title: string; description: string } {
  const { facts } = request;
  const source = ghostInstallConsentSourceText(translate, request);
  const lines: string[] = [];
  if (facts.kind === 'install') {
    lines.push(consentText(translate, 'installMeta', { version: facts.version, source }));
    lines.push(consentText(translate, 'installDescription'));
    if (facts.permissions.length === 0) {
      lines.push(consentText(translate, 'noPermissions'));
    } else {
      lines.push(consentText(translate, 'grantsTitle'));
      for (const item of facts.permissions) lines.push(permissionLine(translate, item));
    }
    return {
      title: consentText(translate, 'installTitle', { name: facts.name }),
      description: lines.join('\n'),
    };
  }
  lines.push(
    consentText(translate, 'updateMeta', { from: facts.previousVersion, to: facts.version, source }),
  );
  lines.push(consentText(translate, 'updateDescription'));
  if (facts.builtinOauthClientChanged) lines.push(consentText(translate, 'oauthClientChanged'));
  if (facts.added.length > 0) {
    lines.push(consentText(translate, 'addedTitle'));
    for (const item of facts.added) lines.push(permissionLine(translate, item));
  }
  if (facts.removed.length > 0) {
    lines.push(consentText(translate, 'removedTitle'));
    for (const item of facts.removed) lines.push(permissionLine(translate, item));
  }
  if (facts.unchangedCount > 0) {
    lines.push(consentText(translate, 'unchangedCount', { count: String(facts.unchangedCount) }));
  }
  return {
    title: consentText(translate, 'updateTitle', { name: facts.name }),
    description: lines.join('\n'),
  };
}

/** 构造投给任务的宿主权限确认卡。不带会话级「总是允许」建议，每次都要用户点头。 */
export function buildGhostInstallConsentInteraction(
  requestId: string,
  request: Omit<GhostInstallConsentRequest, 'requestId'>,
  translate: Translate = mainTranslate,
): Extract<InteractionRequest, { kind: 'permission' }> {
  const text = renderGhostInstallConsentText(request, translate);
  return {
    kind: 'permission',
    requestId,
    toolName: GHOST_INSTALL_CONSENT_TOOL_NAME,
    input: { ghost_id: request.facts.ghostId, version: request.facts.version },
    title: text.title,
    description: text.description,
    metadata: { hostOwnedConfirmation: GHOST_INSTALL_CONSENT_HOST_CONFIRMATION },
  };
}

/** 向指定任务投宿主权限确认卡并等待回答；会话不存在或实例不匹配返回 null。 */
export type HostPermissionRequester = (
  sessionId: string,
  sessionInstanceId: string,
  request: Extract<InteractionRequest, { kind: 'permission' }>,
  signal: AbortSignal,
) => Promise<InteractionDecision | null>;

/** 路由不存在或处理失败：确认根本没送到用户面前，不能当成用户拒绝。 */
const INSTALL_CONSENT_UNDELIVERED_REASONS = new Set([
  'no_interaction_route',
  'interaction_handler_failed',
  'duplicate_request_id',
]);

/**
 * Agent 发起的插件安装／更新确认：投给调用所在的任务，桌面、手机远控与 IM 渠道卡
 * 都能处理。缺任务语境或宿主未注入时 fail closed，由调用方按「无法显示确认」收口。
 */
export function createTaskInstallConsentPrompt(
  task: { sessionId: string; sessionInstanceId: string } | null,
  requestHostPermission: HostPermissionRequester | undefined,
): GhostInstallConsentPrompt {
  return async (request) => {
    if (!task || !requestHostPermission) {
      throw new Error('Plugin install confirmation requires the calling task');
    }
    const controller = new AbortController();
    const untrack = trackGhostInstallConsentPrompt(controller);
    try {
      const decision = await requestHostPermission(
        task.sessionId,
        task.sessionInstanceId,
        buildGhostInstallConsentInteraction(randomUUID(), request),
        controller.signal,
      );
      if (!decision || decision.kind !== 'permission') {
        throw new Error('The calling task is no longer active');
      }
      if (decision.behavior === 'allow') return true;
      if (decision.reason && INSTALL_CONSENT_UNDELIVERED_REASONS.has(decision.reason)) {
        throw new Error(`Plugin install confirmation was not delivered: ${decision.reason}`);
      }
      return false;
    } finally {
      untrack();
    }
  };
}
