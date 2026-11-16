import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface ModelGroupsCallbacks {
  /** 只读：当前账号在这台电脑的模式配置；宿主负责账号与共享任务边界。 */
  list(input: { callerSessionId?: string }): Promise<Record<string, unknown>>;
}

export function registerModelGroupsTools(registry: XdtHelperToolRegistry,
  callbacks: ModelGroupsCallbacks, context: () => LiziMcpSessionContext): void {
  registry.register({
    name: 'list_model_groups',
    category: 'settings',
    description: [
      '只读查询用户在设置「模型组」里建的模式(代码里叫 routes)：稳定 id、名称、选法(strategy)、推理强度、来源列表(agent/model/provider_id/agent_device_id，off=已停用)与例外。',
      '用户要求「用某个模式 / 模型组开 Worker」时，把对应 routes[].id 作为 create_worker / create_workers 的 model_group_id，由宿主在创建时按模式规则选来源；不要自己从来源里挑一个模型代替。',
      '只读这台任务电脑上当前账号的配置，不读其它电脑，不修改模式、不切换任何任务的模型。',
    ].join(''),
    inputShape: {},
    handler: async () => {
      const caller = context();
      if ((!caller.sessionId && !caller.hostCaller) || caller.remoteHostId)
        return errorPayload('CAPABILITY_NOT_AVAILABLE', '请在模式所在电脑上的本机任务中查询模型组。');
      try { return okPayload(await callbacks.list({ callerSessionId: caller.sessionId })); }
      catch (error) {
        const code = (error as { code?: unknown })?.code;
        if (code === 'PERMISSION_DENIED') return errorPayload('PERMISSION_DENIED', '共享中的任务不能读取主人的模型组。');
        return errorPayload('MODEL_GROUP_READ_FAILED', '模型组读取失败，请重新查询；未修改模型或配置。');
      }
    },
  });
}
