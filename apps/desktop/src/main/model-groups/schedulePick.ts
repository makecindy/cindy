/**
 * 定时任务与自动化按模式选来源(model-groups.md §6.3)：每次运行前按模式的规则重新选一个，额度与时段按这一刻算；
 * 这次运行用选出的来源，schedule 里存的具体模型只在选不出来时沿用。运行真的开始后才提交选路记录、
 * 记下任务用着哪个来源(撞配额时据此提议)，并在任务里这次的消息下面写一行说明。
 *
 * - 绑定已有任务(含持续会话第二次起)：只在那个任务所在的运行位置里选，换模型时沿用它，不借模式换电脑。
 * - 新建任务：模式自己决定这次在哪台运行，与新任务草稿相同。
 * - 模式已删除：按没选模式运行，不写说明；里面都用不了：沿用存下的具体模型，说明写明沿用了它。
 * - 绑定的是 SSH 任务：模式现在不用于 SSH(model-groups.md §6、§9)，按存下的具体模型运行，不选不写。
 */
import type { Schedule } from '@cindy/maker-scheduler';

import {
  modelGroupCandidateKey,
  type ModelGroupResolveRequest,
  type ModelGroupResolveResult,
  type ModelGroupSelection,
} from '../../shared/modelGroups.js';
import {
  buildModelGroupRouteNote,
  type ModelGroupLocationName,
  type ModelGroupRouteNoteBody,
  type ModelGroupTranslate,
} from '../../shared/modelGroupRouteNoteText.js';
import type { ScheduleModelGroupPick } from '../scheduler-host/runner.js';

export interface ScheduleModelGroupPorts {
  resolve(request: ModelGroupResolveRequest): Promise<ModelGroupResolveResult>;
  commit(decisionId: string): void;
  bind(sessionId: string, selection: ModelGroupSelection, pickedKey: string): void;
  /**
   * 绑定任务现在在哪里运行：agentDeviceId null = 本机；ssh = 任务在 SSH 主机上。
   * undefined = 任务已不存在(这次会新建)。
   */
  sessionLocation(sessionId: string): Promise<{ agentDeviceId: string | null; ssh: boolean } | undefined>;
  /** 写说明：放在 `sinceMs` 之后这个任务的第一条用户消息下面(就是这次运行发出的那条)。 */
  writeNote(sessionId: string, note: ModelGroupRouteNoteBody, options: { clientId: string; sinceMs: number }): void;
  t: ModelGroupTranslate;
  locale(): string;
  locationName: ModelGroupLocationName;
  now(): number;
}

function keptModelName(schedule: Schedule): string {
  return schedule.model?.trim() || schedule.modelAgentKind || schedule.agentKind;
}

export function createScheduleModelGroupPicker(ports: ScheduleModelGroupPorts) {
  return async function pickScheduleModelGroup(schedule: Schedule): Promise<ScheduleModelGroupPick | null> {
    const groupId = schedule.modelGroup?.trim();
    if (!groupId) return null;
    const selection: ModelGroupSelection = { type: 'route', id: groupId };
    const pickedAt = ports.now();
    const boundSessionId = schedule.targetSessionId?.trim() || null;
    const boundLocation = boundSessionId ? await ports.sessionLocation(boundSessionId) : undefined;
    if (boundLocation?.ssh) return null;
    const bound = boundLocation !== undefined;
    const result = await ports.resolve({
      selection,
      ...(bound ? { location: { agentDeviceId: boundLocation.agentDeviceId } } : {}),
    });
    if (result.outcome === 'missing') return null;
    const note = buildModelGroupRouteNote(result, keptModelName(schedule), ports.t, ports.locale(), ports.locationName);
    const started = (sessionId: string) => {
      try {
        if (result.decisionId) ports.commit(result.decisionId);
        if (result.outcome === 'routed') {
          ports.bind(sessionId, selection, modelGroupCandidateKey(result.route));
        }
        if (note) {
          ports.writeNote(sessionId, note, {
            clientId: `model-group-route:${sessionId}:${result.decisionId ?? pickedAt}`,
            sinceMs: pickedAt,
          });
        }
      } catch {
        // 记录与说明只影响撞配额提议和展示；这次运行照常算数。
      }
    };
    if (result.outcome !== 'routed') return { started };
    const { route } = result;
    return {
      route: {
        modelAgentKind: route.agentKind === 'cc' ? 'claude-code' : route.agentKind,
        model: route.model,
        providerId: route.providerId,
        effort: route.effort,
        // 绑定任务跟着任务现在的位置(上面已只在那里选)；新建任务按选出的来源所在的位置，'' = 本机。
        modelAgentDeviceId: bound ? undefined : (route.agentDeviceId ?? ''),
      },
      started,
    };
  };
}
