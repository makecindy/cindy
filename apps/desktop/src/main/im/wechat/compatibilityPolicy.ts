import { WechatCompatibilityPolicyService as RuntimePolicyService, type WechatCompatibilityPolicyOptions } from '@cindy/app-runtime/wechat/compatibilityPolicy';
import { createLogger, maskPath } from '../../logger';
export * from '@cindy/app-runtime/wechat/compatibilityPolicy';
export class WechatCompatibilityPolicyService extends RuntimePolicyService {
 constructor(options:WechatCompatibilityPolicyOptions){super(options,{log:createLogger('im/wechat/compatibility-policy'),maskPath:file=>maskPath(file)});}
}
