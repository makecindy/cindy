/**
 * 模型组统一请求处理器(纯 Node，零 Electron 依赖，Desktop 与 Node Host 共用，见 architecture-invariants §5)。
 * 覆盖：get / set / resolve / commit / bind-session / unbind-session / get-session-binding / switch-offer / route-note / decisions。
 */
import {
  MODEL_GROUP_LIMITS,
  modelGroupAgentDeviceId,
  modelGroupCandidateKey,
  modelGroupResolveResultForRemote,
  modelGroupsConfigForRemote,
  modelGroupSelectionForOwner,
  normalizeModelGroupsConfig,
  sanitizeModelGroupRouteNote,
  sanitizeModelGroupSelection,
  type ModelGroupGetOptions,
  type ModelGroupResolveRequest,
  type ModelGroupSessionBindingView,
} from '../../shared/modelGroups.js';
import { pluginEngineKeyFromProviderId } from '../../shared/pluginEngines.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { readModelGroupDecisions } from './decisionLog.js';
import { assertModelGroupsCallerCore } from './remoteAccessCore.js';
import { acceptModelGroupRouteNote, type ModelGroupRouteNotePorts } from './routeNote.js';
import type { ModelGroupRuntime } from './runtimeCore.js';
import {
  bindModelGroupSession,
  projectModelGroupSessionBinding,
  readModelGroupSessionBinding,
  unbindModelGroupSession,
  type ModelGroupSessionTarget,
  type PendingModelGroupTarget,
} from './sessionBindings.js';
import { readModelGroupsConfig, readModelGroupsConfigForSelected, writeModelGroupsConfig } from './store.js';

export interface ModelGroupHandlersPorts {
  runtime(): ModelGroupRuntime;
  isDeviceLink(): boolean;
  deviceLinkOrigin(): 'owner' | 'scoped' | undefined;
  readSessionTarget(sessionId: string): Promise<ModelGroupSessionTarget | null>;
  readPendingSessionTarget?(sessionId: string): PendingModelGroupTarget | null;
  markPendingModelGroupPick?(sessionId: string, pickedKey: string): void;
  routeNotePorts: ModelGroupRouteNotePorts;
}

function sessionIdOf(value: Record<string, unknown>): string {
  const sessionId = value.sessionId;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) {
    throwIpcError('INVALID_PARAMS', 'sessionId is required');
  }
  return sessionId;
}

export function createModelGroupHandlers(ports: ModelGroupHandlersPorts) {
  const assertCaller = (assertLocal?: () => void) =>
    assertModelGroupsCallerCore({
      isDeviceLink: () => ports.isDeviceLink(),
      origin: () => ports.deviceLinkOrigin(),
      assertLocal,
    });

  const assertLocalOnly = (assertLocal?: () => void) => {
    if (ports.isDeviceLink()) {
      throwIpcError('PRECONDITION_FAILED', 'this model groups operation is local-only');
    }
    assertLocal?.();
  };

  const remoteSafeSelection = (raw: unknown) => {
    const selection = sanitizeModelGroupSelection(raw);
    return selection && ports.isDeviceLink() ? modelGroupSelectionForOwner(selection) : selection;
  };

  return {
    async get(rawOptions?: unknown, assertLocal?: () => void) {
      assertCaller(assertLocal);
      const remoteCaller = ports.isDeviceLink();
      const opts = rawOptions && typeof rawOptions === 'object' ? rawOptions as Record<string, unknown> : null;
      const includeSourceRoutes = opts?.includeSourceRoutes === true;
      const getOptions: ModelGroupGetOptions = includeSourceRoutes ? { includeSourceRoutes: true } : {};
      // 远端旧控制端不要求 sourceRoutes，无需白等 2 秒远程目录读取；新控制端显式请求 includeSourceRoutes 时补齐。
      await ports.runtime().refreshAutoModelGroupRoutes({ waitRemote: !remoteCaller || includeSourceRoutes });
      return remoteCaller ? modelGroupsConfigForRemote(readModelGroupsConfig(), getOptions) : readModelGroupsConfig();
    },

    set(raw: unknown, assertLocal?: () => void) {
      assertLocalOnly(assertLocal);
      if (!raw || typeof raw !== 'object') throwIpcError('INVALID_PARAMS', 'model groups config must be an object');
      const keep = (['sourceRoutes', 'hiddenAuto', 'autoStrategy', 'autoSwitchOff', 'autoSources', 'autoExceptions'] as const)
        .filter((key) => !Object.hasOwn(raw, key));
      return writeModelGroupsConfig(normalizeModelGroupsConfig(raw), keep);
    },

    async resolve(raw: unknown, assertLocal?: () => void) {
      assertCaller(assertLocal);
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const selection = remoteSafeSelection(value.selection);
      if (!selection) throwIpcError('INVALID_PARAMS', 'model group selection is required');
      const context = value.context && typeof value.context === 'object' ? value.context as Record<string, unknown> : null;
      const rawLocation = value.location && typeof value.location === 'object' ? value.location as Record<string, unknown> : null;
      const locationId = rawLocation
        ? rawLocation.agentDeviceId === null || rawLocation.agentDeviceId === undefined ? null : modelGroupAgentDeviceId(rawLocation.agentDeviceId)
        : null;
      if (rawLocation && rawLocation.agentDeviceId !== null && rawLocation.agentDeviceId !== undefined && !locationId) {
        throwIpcError('INVALID_PARAMS', 'model group location is invalid');
      }
      const sshHostId = typeof value.sshHostId === 'string' && value.sshHostId.trim() && value.sshHostId.trim().length <= 256
        ? value.sshHostId.trim()
        : undefined;
      const request: ModelGroupResolveRequest = {
        selection,
        dryRun: value.dryRun === true,
        ...(value.cachedQuota === true ? { cachedQuota: true } : {}),
        ...(context ? { context: {
          ...(context.hasImages === true ? { hasImages: true } : {}),
          ...(typeof context.effort === 'string' && /^[a-z]{1,32}$/.test(context.effort) ? { effort: context.effort } : {}),
          ...(context.fastMode === true || context.fastMode === 'ultrafast' ? { fastMode: context.fastMode } : {}),
        } } : {}),
        ...(rawLocation ? { location: { agentDeviceId: locationId } } : {}),
        ...(value.remoteInvocableOnly === true ? { remoteInvocableOnly: true } : {}),
        ...(sshHostId ? { sshHostId } : {}),
      };
      // 在 await 之前读：调用来源只在同步段里可靠。
      const remote = ports.isDeviceLink();
      const result = await ports.runtime().resolver.resolve(request);
      return remote ? modelGroupResolveResultForRemote(result) : result;
    },

    commit(decisionId: unknown, assertLocal?: () => void) {
      assertCaller(assertLocal);
      if (typeof decisionId !== 'string' || decisionId.length > 64) {
        throwIpcError('INVALID_PARAMS', 'decisionId is required');
      }
      return ports.runtime().resolver.commit(decisionId);
    },

    bindSession(raw: unknown, assertLocal?: () => void) {
      assertCaller(assertLocal);
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const sessionId = sessionIdOf(value);
      if (value.selection === null) {
        unbindModelGroupSession(sessionId);
        return;
      }
      const selection = remoteSafeSelection(value.selection);
      const route = value.route && typeof value.route === 'object' ? value.route as Record<string, unknown> : {};
      const agentKind = route.agentKind;
      const providerId = route.providerId;
      const model = route.model;
      const agentDeviceId = route.agentDeviceId === undefined || route.agentDeviceId === null
        ? undefined
        : modelGroupAgentDeviceId(route.agentDeviceId);
      if (!selection || (agentKind !== 'cc' && agentKind !== 'codex' && agentKind !== 'pi' && agentKind !== 'acp')
        || typeof providerId !== 'string' || !providerId || providerId.length > MODEL_GROUP_LIMITS.field
        || (agentKind === 'acp' && !pluginEngineKeyFromProviderId(providerId))
        || typeof model !== 'string' || !model || model.length > MODEL_GROUP_LIMITS.field
        || agentDeviceId === null) {
        throwIpcError('INVALID_PARAMS', 'model group selection and route are required');
      }
      const pickedKey = modelGroupCandidateKey({ agentKind, providerId, model, agentDeviceId });
      if (bindModelGroupSession(sessionId, selection, pickedKey)) {
        ports.markPendingModelGroupPick?.(sessionId, pickedKey);
      }
    },

    unbindSession(raw: unknown, assertLocal?: () => void) {
      assertCaller(assertLocal);
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return { ok: true, unbound: unbindModelGroupSession(sessionIdOf(value)) };
    },

    async getSessionBinding(raw: unknown, assertLocal?: () => void): Promise<ModelGroupSessionBindingView | null> {
      assertCaller(assertLocal);
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const sessionId = sessionIdOf(value);
      await ports.runtime().refreshAutoModelGroupRoutes({ waitRemote: false });
      const entry = readModelGroupSessionBinding(sessionId);
      if (!entry) return null;
      const current = await ports.readSessionTarget(sessionId);
      const pending = ports.readPendingSessionTarget?.(sessionId) ?? null;
      return projectModelGroupSessionBinding({
        binding: entry,
        config: readModelGroupsConfigForSelected(),
        current,
        pending,
      });
    },

    async switchOffer(raw: unknown, assertLocal?: () => void) {
      assertCaller(assertLocal);
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return ports.runtime().readModelGroupRecoveryOffer(sessionIdOf(value));
    },

    async routeNote(raw: unknown, assertLocal?: () => void) {
      assertCaller(assertLocal);
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const sessionId = sessionIdOf(value);
      const note = sanitizeModelGroupRouteNote(value.note);
      if (!note) throwIpcError('INVALID_PARAMS', 'model group route note is invalid');
      if (!(await acceptModelGroupRouteNote(ports.routeNotePorts, sessionId, note))) {
        throwIpcError('NOT_FOUND', 'session not found');
      }
    },

    decisions(assertLocal?: () => void) {
      assertLocalOnly(assertLocal);
      return readModelGroupDecisions();
    },
  };
}
