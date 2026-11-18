/**
 * 手机推送在 Agent-Net 是主连接时的补发（2026-11-17 排查）。主连接只把推送交给在 Agent-Net 上登记了推送的设备
 * （目录里有 notificationKey）；没开 Agent-Net 的手机、登记失败的手机收不到这台电脑的任何推送，Agent-Net 中继断开时谁都收不到。
 * Device Link 时服务端会推给本账号全部登记了推送的手机。这里决定同一条推送还要经 Device Link 中转连接再发哪几份，
 * 只发给 Agent-Net 没送到的，同一台手机不收两遍：
 * - Agent-Net 没发出去（没在线、中继不支持推送）：不指定设备发一份，和只有 Device Link 时一样。
 * - 推送指定了一台手机：它不在 Agent-Net 覆盖里才补发。
 * - Agent-Net 一台都没覆盖：不指定设备发一份（服务端照常发给全部手机，和只有 Device Link 时一样）。
 * - 否则：给每台已知、但 Agent-Net 没覆盖的手机各发一份（指定设备）。「已知」是 presence 见过的，加上账号 Device Link 设备列表
 *   里的手机（在后台、此刻离线的也在，agentNetListedPhones）；两边都没有的（列表还没读到过的新手机）这时收不到。
 * 只在允许旧连接时由调用方发出（「仅使用 Agent-Net」时没有 Device Link 中转连接，不补发：那条路服务端看得见内容）。
 */
import type { NotifyPayload } from '@cindy/device-link';

export function notifyOutsideAgentNet(payload: NotifyPayload, sentOnAgentNet: boolean, covered: ReadonlySet<string>,
  phones: readonly string[], selfDeviceId: string | null): NotifyPayload[] {
  if (!sentOnAgentNet) return [payload];
  if (payload.targetDeviceId) return covered.has(payload.targetDeviceId) ? [] : [payload];
  if (covered.size === 0) return [payload];
  return phones.filter((id) => id !== selfDeviceId && !covered.has(id)).map((targetDeviceId) => ({ ...payload, targetDeviceId }));
}
