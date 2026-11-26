/**
 * 模式跟着任务走(model-groups.md §6.3 原则)：新建任务时按模式选第一个来源并记下任务经哪个模式建的(之后撞配额或
 * 故障的接替都按这条记录走，首轮也算)；这个任务第一轮消息派发的那一刻提交选路，并在那条消息下面写说明。
 * 入口(定时任务、IM、Hook……)只做两件事：要新建任务时 `prepare` 拿到选中的来源当作具体模型用，
 * 把凭据随建任务参数交给新建任务(bootstrapSession 调 `attach`)。派发由所有发送共用的钩子调 `dispatched`。
 * 发到已有任务不经这里：那个任务按它自己的模式走。
 */
import {
  modelGroupCandidateKey,
  type ModelGroupResolveRequest,
  type ModelGroupAgentKind,
  type ModelGroupResolveResult,
  type ModelGroupSelection,
} from '../../shared/modelGroups.js';
import {
  buildModelGroupRouteNote,
  type ModelGroupLocationName,
  type ModelGroupRouteNoteBody,
  type ModelGroupTranslate,
} from '../../shared/modelGroupRouteNoteText.js';

export interface ModelGroupSessionStartPorts {
  resolve(request: ModelGroupResolveRequest): Promise<ModelGroupResolveResult>;
  commit(decisionId: string): void;
  bind(sessionId: string, selection: ModelGroupSelection, pickedKey: string): void;
  /** 说明写在这个任务 clientId 为 `anchorClientId` 的那条用户消息下面。 */
  writeNote(sessionId: string, note: ModelGroupRouteNoteBody, options: { clientId: string; anchorClientId: string }): void;
  t: ModelGroupTranslate;
  locale(): string;
  locationName: ModelGroupLocationName;
  now(): number;
  createToken(): string;
}

/** 选中的来源，入口当作这次新建任务的具体模型用。agentDeviceId null = 本机。 */
export interface ModelGroupStartRoute {
  agentKind: ModelGroupAgentKind;
  model: string;
  providerId: string;
  effort?: string;
  agentDeviceId: string | null;
}

export interface ModelGroupStartPrepared {
  /** 模式里都用不了时没有：入口沿用存下的具体模型(说明里写明沿用了它)。 */
  route?: ModelGroupStartRoute;
  token: string;
}

interface Pending {
  selection: ModelGroupSelection;
  result: ModelGroupResolveResult;
  keptModelName: string;
  at: number;
}

/** 选了没建成任务、或建了没发出消息的凭据不会无限留着。 */
const MAX_PENDING = 256;
const PENDING_TTL_MS = 60 * 60_000;

export function createModelGroupSessionStart(ports: ModelGroupSessionStartPorts) {
  const prepared = new Map<string, Pending>();
  const attached = new Map<string, Pending>();

  const prune = (map: Map<string, Pending>) => {
    const now = ports.now();
    for (const [key, item] of map) if (now - item.at > PENDING_TTL_MS) map.delete(key);
    while (map.size >= MAX_PENDING) map.delete(map.keys().next().value!);
  };

  return {
    /**
     * 新建任务前按模式选(不提交)。模式已删除返回 null：按没选模式建任务，不写说明。
     * `localOnly`：只在本机的来源里选(只在本机运行的自动化)。
     */
    async prepare(groupId: string, options: { keptModelName: string; localOnly?: boolean }): Promise<ModelGroupStartPrepared | null> {
      const selection: ModelGroupSelection = { type: 'route', id: groupId };
      const result = await ports.resolve({ selection, ...(options.localOnly ? { location: { agentDeviceId: null } } : {}) });
      if (result.outcome === 'missing') return null;
      prune(prepared);
      const token = ports.createToken();
      prepared.set(token, { selection, result, keptModelName: options.keptModelName, at: ports.now() });
      if (result.outcome !== 'routed') return { token };
      const { route } = result;
      return {
        route: { agentKind: route.agentKind, model: route.model, providerId: route.providerId,
          ...(route.effort ? { effort: route.effort } : {}), agentDeviceId: route.agentDeviceId ?? null },
        token,
      };
    },
    /** 只看模式此刻能不能选出可用来源(保存准入用)，不留凭据、不推进轮流。 */
    async canRoute(groupId: string, options: { localOnly?: boolean } = {}): Promise<boolean> {
      const result = await ports.resolve({ selection: { type: 'route', id: groupId }, dryRun: true,
        ...(options.localOnly ? { location: { agentDeviceId: null } } : {}) });
      return result.outcome === 'routed';
    },
    /** 模式还在不在(没被删)；发到已有任务时据此决定沿用任务当前来源还是按存下的具体模型。 */
    async exists(groupId: string): Promise<boolean> {
      const result = await ports.resolve({ selection: { type: 'route', id: groupId }, dryRun: true });
      return result.outcome !== 'missing';
    },
    /**
     * 新建任务(bootstrapSession)收到凭据：立刻记下任务经哪个模式建的(发送前就要能查到，首轮出错才能按模式接替)，
     * 选路提交与说明等第一轮派发时结算。记录只在任务正用着记下的来源时生效，任务没建成留下的记录不会误用。
     */
    attach(sessionId: string, token: string): void {
      const item = prepared.get(token);
      if (!item) return;
      prepared.delete(token);
      prune(attached);
      attached.set(sessionId, item);
      if (item.result.outcome === 'routed') {
        try {
          ports.bind(sessionId, item.selection, modelGroupCandidateKey(item.result.route));
        } catch {
          // 记录只影响接替与提议；建任务照常。
        }
      }
    },
    /** 所有发送共用的派发钩子：这个任务的第一轮消息(clientId)发出去了。 */
    dispatched(sessionId: string, clientId: string): void {
      const item = attached.get(sessionId);
      if (!item) return;
      attached.delete(sessionId);
      try {
        if (item.result.decisionId) ports.commit(item.result.decisionId);
        const note = buildModelGroupRouteNote(item.result, item.keptModelName, ports.t, ports.locale(), ports.locationName);
        if (note) {
          ports.writeNote(sessionId, note, {
            clientId: `model-group-route:${sessionId}:${item.result.decisionId ?? item.at}`,
            anchorClientId: clientId,
          });
        }
      } catch {
        // 记录与说明只影响撞配额接替和展示；这一轮照常算数。
      }
    },
  };
}

export type ModelGroupSessionStart = ReturnType<typeof createModelGroupSessionStart>;
