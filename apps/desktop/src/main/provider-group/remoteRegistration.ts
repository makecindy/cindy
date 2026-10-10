/**
 * 把供应商组接到设备互联(docs/product-rules/provider-groups.md §4)：同账号其他电脑的
 * `provider-group:remote` 请求，以及给它们的 `maker:provider:list` 补组摘要。
 * 只服务同账号电脑，dispatch 已拒绝受邀者与共享任务访客。
 */
import { setProviderGroupRemoteHandler } from '../device-link/dispatch.js';
import { isRemoteProviderInvocationAllowed } from '../maker-host/remote-provider-access-store.js';
import {
  decorateProviderListWithGroups,
  handleProviderGroupRemote,
  type ProviderGroupRemoteHandlerDeps,
} from './remoteHandler.js';
import { getProviderGroupExternalLoad, getProviderGroupRouter, pinProviderGroupOwnerRuntime } from './runtime.js';
import { readProviderGroup } from './store.js';

export function registerProviderGroupRemoteHandler(): void {
  const deps: ProviderGroupRemoteHandlerDeps = {
    router: getProviderGroupRouter(),
    externalLoad: getProviderGroupExternalLoad(),
    readGroup: readProviderGroup,
    isRemoteAllowed: isRemoteProviderInvocationAllowed,
    // 换账号后旧请求不写进新账号的负载(等待期间账号可能已换)。
    pin: pinProviderGroupOwnerRuntime,
    now: () => Date.now(),
  };
  setProviderGroupRemoteHandler({
    handle: (controller, raw) => handleProviderGroupRemote(deps, controller, raw),
    decorateProviderList: (result) => decorateProviderListWithGroups(result, readProviderGroup),
  });
}
