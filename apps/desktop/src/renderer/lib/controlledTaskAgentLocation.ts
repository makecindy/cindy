/**
 * 远程控制另一台电脑(被控电脑)上的任务时,任务的 Agent 也可以在同账号的第三台电脑上运行
 * (远程 Agent,协议见 docs/dev-rules/protocol-compatibility.md「远程 Agent」)。与手机同一套口径
 * (apps/mobile/src/session/remoteAgentCatalogs.ts):模型列表在被控电脑自己的供应商之后,另列同账号
 * 其他电脑开放了远程调用的供应商;选另一台电脑的模型 = 把 Agent 挪过去,下一条消息生效。
 *
 * 远程控制下新建任务(建到被控电脑上)同样可以选第三台电脑的模型:任务建出来就带 agentDeviceId。
 *
 * 这里只放纯判定,接线在 CCAgentSessionView / NewMakerDraftRoute / ChatInput。
 */
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';

/**
 * 被控电脑支持远程 Agent:它投影的任务带 agentDeviceId 字段(值可以是 null)。旧版被控电脑不投影
 * 这个字段,也不认换位置参数,维持原有调用与展示。
 */
export function controlledTaskSupportsAgentLocation(session: object | null | undefined): boolean {
  return !!session && Object.prototype.hasOwnProperty.call(session, 'agentDeviceId');
}

/**
 * 远程控制下新建任务时,被控电脑认不认 `maker:create-session` 的 agentDeviceId(与手机新建任务同一
 * 判据):它的供应商目录带「允许被远程调用」布尔标记(与远程 Agent 同一版加入)。旧版被控电脑不带,
 * 不提供其他电脑的模型。目录还没读到时同样按不支持处理。
 */
export function controlledComputerSupportsRemoteAgent(
  providers: readonly { remoteInvocationEnabled?: unknown }[],
): boolean {
  return providers.some((provider) => typeof provider.remoteInvocationEnabled === 'boolean');
}

/**
 * 本机能否直接经 device-link 读这台电脑的模型目录。同账号的其他电脑可以;被控电脑收到的分享
 * (`share:<id>`,凭证只在被控电脑上)与本机自己(device-link 不连自己)读不到。
 */
export function isControllerReadableAgentDevice(
  deviceId: string | null | undefined,
  selfDeviceId: string | null,
): deviceId is string {
  return !!deviceId && !isProviderShareAgentDeviceId(deviceId) && deviceId !== selfDeviceId;
}

/**
 * 被控电脑上的任务能不能在本机的模型面板里换 Agent 所在电脑:任务当前与挂着的换位置意图都得是
 * 被控电脑本身(null)或本机读得到目录的电脑。Agent 在被控电脑收到的分享上、或就在本机时,本机
 * 列不出那份目录,维持原有的被控电脑列表与调用。
 */
export function controlledTaskAgentLocationReadable(input: {
  agentDeviceId: string | null | undefined;
  pendingAgentDeviceId: string | null | undefined;
  selfDeviceId: string | null;
}): boolean {
  return [input.agentDeviceId, input.pendingAgentDeviceId].every(
    (deviceId) => deviceId == null || isControllerReadableAgentDevice(deviceId, input.selfDeviceId),
  );
}

/**
 * 被控电脑上的任务(已建任务或新建任务草稿)可以让 Agent 去哪些电脑:本机的可选设备(已排除本机与
 * 手机)里去掉被控电脑本身,留下在线的,以及任务当前 / 挂着的 Agent 所在电脑(离线也保留,让用户
 * 看得到、换得回来)。
 * 本机自己收到的分享不列:被控电脑用不了。被控电脑收到的分享本机读不到目录,同样不列。
 */
export function selectControlledTaskAgentDevices(input: {
  devices: readonly { deviceId: string; name: string; online: boolean }[];
  controlledDeviceId: string;
  keepDeviceIds: readonly (string | null | undefined)[];
}): { deviceId: string; name: string }[] {
  const keep = new Set(input.keepDeviceIds.filter((id): id is string => !!id));
  return input.devices
    .filter(
      (device) =>
        device.deviceId !== input.controlledDeviceId &&
        (device.online || keep.has(device.deviceId)),
    )
    .map(({ deviceId, name }) => ({ deviceId, name }));
}
