import {
  humanizeRemoteError as humanizeRemoteErrorShared,
  isDeviceUnresponsiveRemoteError,
} from '@cindy/maker-shared/device-link-contract';
import { i18n } from '@/i18n';

export {
  connectionIssueHint,
  connectionIssueTitle,
  describeAgentAuthError,
  describeRemoteError,
  formatRemoteError,
  isPreconditionFailedRemoteError,
  relayStatusHint,
  relayStatusLabel,
} from '@cindy/maker-shared/device-link-contract';

/**
 * mobile 侧的 humanizeRemoteError:熔断快速失败(DEVICE_UNRESPONSIVE)先走
 * 四语言 i18n(与 ConnectionBanner 同一组文案),其余委托 maker-shared 原实现。
 * 共享层的文案是中文硬编码(历史现状),直接透出会让 en/ja/ko 用户在
 * Alert 里看到中文(review P1)——本 PR 新增的错误码不再走那条老路。
 */
export function humanizeRemoteError(error: unknown): string {
  if (isDeviceUnresponsiveRemoteError(error)) {
    return i18n.t('deviceLink.deviceUnresponsiveHint');
  }
  return humanizeRemoteErrorShared(error);
}
