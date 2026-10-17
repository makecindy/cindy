/**
 * partner-bridge —— 外部系统经本机回环 HTTP 调 Cindy 伙伴的入口。
 *
 * 组装顺序:生成 token → 起回环 server(内核分配端口)→ 写 0600 端点文件。
 * 关闭顺序相反:停 server(断连接)→ 删端点文件。生命周期与 main 进程一致,
 * 由 bootstrap 的 before-quit 调用 shutdown。
 *
 * 依赖全部来自 maker-ipc 的注入面(register.ts 接线),本模块不直接触碰
 * maker / localDb / 窗口。
 */

import { randomBytes } from 'node:crypto';

import {
  removePartnerEndpointFile,
  writePartnerEndpointFile,
  type PartnerEndpointInfo,
} from './endpointFile.js';
import { startPartnerBridgeServer } from './server.js';
import { createPartnerTaskService } from './taskService.js';
import type { PartnerBridgeDeps } from './types.js';

export { createPartnerTaskService } from './taskService.js';
export type { PartnerTaskService } from './taskService.js';
export { collectPartnerAttachments } from './attachments.js';
export { createPartnerSession } from './sessionFactory.js';
export { readPartnerSessionId, writePartnerSessionId } from './sessionStore.js';
export type { PartnerBridgeDeps, PartnerTaskRecord, PartnerTurnRequest } from './types.js';

export interface PartnerBridgeHandle {
  endpoint: PartnerEndpointInfo;
  endpointFile: string;
  shutdown(): Promise<void>;
}

export async function startPartnerBridge(opts: {
  deps: PartnerBridgeDeps;
  /** 端点文件所在目录(生产:owner 作用域 userData 下的 partner-bridge/)。 */
  endpointDir: string;
}): Promise<PartnerBridgeHandle> {
  const service = createPartnerTaskService(opts.deps);
  const token = randomBytes(32).toString('hex');
  const server = await startPartnerBridgeServer({
    service,
    token,
    log: opts.deps.log,
  });
  const endpoint: PartnerEndpointInfo = {
    port: server.port,
    token,
    pid: process.pid,
    startedAt: Date.now(),
    protocol: 'cindy-partner-bridge/1',
  };
  let endpointFile: string;
  try {
    endpointFile = writePartnerEndpointFile(opts.endpointDir, endpoint);
  } catch (err) {
    // 端点文件写不出来时调用方拿不到 token,服务必须立刻停掉,不能留一个空转的监听端口。
    await server.shutdown();
    throw err;
  }
  opts.deps.log.info('partner bridge endpoint written', { endpointFile, port: server.port });

  return {
    endpoint,
    endpointFile,
    shutdown: async () => {
      await server.shutdown();
      removePartnerEndpointFile(endpointFile);
    },
  };
}
