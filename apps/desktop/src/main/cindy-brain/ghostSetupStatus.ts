export * from '@cindy/plugin-runtime/ghostSetupStatus';
import { evaluateGhostSetup, type GhostSetupProbes } from '@cindy/plugin-runtime/ghostSetupStatus';
import type { GhostManifest, GhostSetupStatus } from '../../shared/ghost.js';
import { isGhostInstanceId } from '../../shared/pluginIdentity.js';
import { throwIpcError } from '../utils/ipcValidate.js';
/**
 * ghosts:setup-status 的 handler 主体(规则 14:抽成可注入依赖的函数,
 * `ipcMain.handle` 只做 adapter,测试用内存 harness 直接 invoke)。
 * 错误路径:id 形态非法 INVALID_PARAMS、未安装 NOT_FOUND;探针意外抛错
 * **有意不在此捕获**——让 invoke 直接 reject,renderer 侧 catch 后放行
 * (fail-open),绝不把「查询失败」折叠成「未配置」去误拦用户。
 */
export function handleGhostSetupStatusRequest(args: {
  id: unknown;
  /** 现查在装清单并返回运行时清单(oauth 内置 client 已注入);未装 null。 */
  getRuntimeManifest: (id: string) => GhostManifest | null;
  /** 按清单构造探针(index.ts 接各存储真身;测试喂假体)。 */
  probesFor: (manifest: GhostManifest) => GhostSetupProbes;
}): GhostSetupStatus {
  const { id } = args;
  if (typeof id !== 'string' || !isGhostInstanceId(id)) {
    throwIpcError('INVALID_PARAMS', 'id must be a valid Ghost id');
  }
  const manifest = args.getRuntimeManifest(id);
  if (!manifest) throwIpcError('NOT_FOUND', `意识 ${id} 未安装`);
  return evaluateGhostSetup(manifest, args.probesFor(manifest));
}
