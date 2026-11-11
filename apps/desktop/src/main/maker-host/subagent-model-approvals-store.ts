// Subagent 模型执行审批 —— 只有 Host(用户设置入口)能写,Agent 不能创建/修改。
//
// 安全约束(见 SECURITY_DESIGN.md):
//  - approval 必须带明确 scope(session|project)、有效期、成本上限(可选);
//  - 不是长期全开:expiresAt 必填且 > grantedAt;
//  - Agent 无权调用本模块的写入口 —— 写入口只从设置 UI 暴露,本文件不导出任何
//    "agent 自批"路径。
import { app } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { activeOwnerScopeKey, getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';
import type { ModelExecutionApproval } from '@cindy/maker-core';

const log = desktopMakerLogger.child('subagent-model-approvals-store');

const DEFAULTS = { approvals: [] as ModelExecutionApproval[] };

interface ApprovalsState {
  approvals: ModelExecutionApproval[];
}

function normalize(raw: unknown): ApprovalsState {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const list = Array.isArray(record.approvals) ? record.approvals : [];
  const approvals: ModelExecutionApproval[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const approval = item as Record<string, unknown>;
    if (typeof approval.id !== 'string' || !approval.id) continue;
    if (approval.grantedBy !== 'user') continue;
    if (typeof approval.provider !== 'string' || !approval.provider) continue;
    if (typeof approval.model !== 'string' || !approval.model) continue;
    if (approval.scope !== 'session' && approval.scope !== 'project') continue;
    if (typeof approval.grantedAt !== 'number' || typeof approval.expiresAt !== 'number') continue;
    if (!(approval.expiresAt > approval.grantedAt)) continue;
    approvals.push({
      id: approval.id,
      provider: approval.provider,
      model: approval.model,
      ...(typeof approval.sourceProviderId === 'string' && approval.sourceProviderId
        ? { sourceProviderId: approval.sourceProviderId }
        : {}),
      scope: approval.scope,
      ...(typeof approval.sessionId === 'string' && approval.sessionId
        ? { sessionId: approval.sessionId }
        : {}),
      ...(typeof approval.projectRoot === 'string' && approval.projectRoot
        ? { projectRoot: approval.projectRoot }
        : {}),
      grantedBy: 'user',
      grantedAt: approval.grantedAt,
      expiresAt: approval.expiresAt,
      ...(typeof approval.maxCostUsd === 'number' && Number.isFinite(approval.maxCostUsd)
        ? { maxCostUsd: approval.maxCostUsd }
        : {}),
    });
  }
  return { approvals };
}

function settingsFilePath(rootPath?: string): string {
  return path.join(rootPath ?? app.getPath('userData'), 'subagent-model-approvals.json');
}

const stores = new Map<string, ReturnType<typeof createOverrideSettingsFile<ApprovalsState>>>();

function currentStore(rootPath?: string) {
  const ownerRoot = rootPath
    ?? (getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null);
  const key = ownerRoot ?? '<global>';
  let current = stores.get(key);
  if (!current) {
    current = createOverrideSettingsFile<ApprovalsState>({
      filePath: () => settingsFilePath(ownerRoot ?? undefined),
      defaults: DEFAULTS,
      normalize,
      log,
      label: 'subagent-model-approvals',
      scopeKey: rootPath ? () => `root:${rootPath}` : activeOwnerScopeKey,
    });
    stores.set(key, current);
  }
  return current;
}

export async function readSubagentModelApprovals(
  options?: { rootPath?: string },
): Promise<ModelExecutionApproval[]> {
  return (await currentStore(options?.rootPath).read()).approvals;
}

export interface GrantApprovalInput {
  provider: string;
  model: string;
  sourceProviderId?: string;
  scope: 'session' | 'project';
  sessionId?: string;
  projectRoot?: string;
  maxCostUsd?: number;
  /** 毫秒时间戳;默认 24 小时。 */
  ttlMs?: number;
}

/**
 * 唯一写入口:仅供设置 UI(用户主动点击)调用。Agent 永远走不到这里 ——
 * 它不在 AgentDeps 上,也不经 IPC 暴露给 renderer 以外的调用方。
 */
export async function grantSubagentModelApproval(
  input: GrantApprovalInput,
): Promise<ModelExecutionApproval> {
  const now = Date.now();
  const ttlMs = typeof input.ttlMs === 'number' && input.ttlMs > 0 ? input.ttlMs : 24 * 60 * 60 * 1000;
  const approval: ModelExecutionApproval = {
    id: `appr-${randomUUID()}`,
    provider: normalizeId(input.provider),
    model: normalizeId(input.model),
    ...(input.sourceProviderId ? { sourceProviderId: normalizeId(input.sourceProviderId) } : {}),
    scope: input.scope,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    grantedBy: 'user',
    grantedAt: now,
    expiresAt: now + ttlMs,
    ...(typeof input.maxCostUsd === 'number' && Number.isFinite(input.maxCostUsd)
      ? { maxCostUsd: input.maxCostUsd }
      : {}),
  };
  const store = currentStore();
  const state = await store.read();
  await store.write({ approvals: [...state.approvals, approval] });
  log.info('subagent model approval granted', {
    approvalId: approval.id, provider: approval.provider, model: approval.model, scope: approval.scope,
  });
  return approval;
}

export async function revokeSubagentModelApproval(approvalId: string): Promise<boolean> {
  const store = currentStore();
  const state = await store.read();
  const next = state.approvals.filter((approval) => approval.id !== approvalId);
  if (next.length === state.approvals.length) return false;
  await store.write({ approvals: next });
  log.info('subagent model approval revoked', { approvalId });
  return true;
}

function normalizeId(value: string): string {
  return value.trim();
}

export type { OverrideSettingsState };
