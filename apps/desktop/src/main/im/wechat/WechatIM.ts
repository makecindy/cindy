import { WechatIM as RuntimeWechatIM, type WechatIMDeps as RuntimeWechatIMDeps } from '@cindy/app-runtime/wechat/WechatIM';
import { stageWechatTaskMedia, removeUncommittedWechatFiles, removeReleasedWechatFiles } from './mediaStaging';
export { WECHAT_AUTH_BASE_URL, sessionIdFor, wechatPreDispatchFailureText, __testing } from '@cindy/app-runtime/wechat/WechatIM';
export type { WechatBotPhase, WechatBotState } from '@cindy/app-runtime/wechat/WechatIM';
export type WechatIMDeps = Omit<RuntimeWechatIMDeps, 'media'>;
export class WechatIM extends RuntimeWechatIM {
 constructor(deps:WechatIMDeps){super({...deps,media:{stageWechatTaskMedia,removeUncommittedWechatFiles,removeReleasedWechatFiles}});}
}
