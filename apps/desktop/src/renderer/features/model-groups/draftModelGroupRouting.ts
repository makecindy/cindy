/**
 * 新任务按模式选路时，由哪台电脑选(model-groups.md §6.3)：
 * - 远程控制另一台电脑的草稿：被控那台按自己的模式选，任务建在那台，记录与说明也由那台写。
 * - 本机草稿选了「其他电脑」那一段的模式：那台按自己的模式、只在它自己的来源里选；任务在本机，
 *   Agent 在那台运行，说明写在本机，选路记录提交给那台。
 * - 其余：本机。
 */
import {
  type ModelGroupResolveRequest,
  type ModelGroupResolveResult,
  type ModelGroupSelection,
} from '../../../shared/modelGroups';
import { resolveModelGroup } from './modelGroupsClient';
import { resolveDeviceModelGroup } from './remoteModelGroups';

/** 选路的那台电脑；null = 本机。 */
export function modelGroupOwnerDevice(
  selection: ModelGroupSelection,
  draftDeviceId: string | null | undefined,
): string | null {
  return draftDeviceId || selection.deviceId || null;
}

export async function resolveDraftModelGroup(
  selection: ModelGroupSelection,
  options: { draftDeviceId?: string | null; context?: ModelGroupResolveRequest['context']; sshHostId?: string },
): Promise<ModelGroupResolveResult | null> {
  const { draftDeviceId, context, sshHostId } = options;
  if (draftDeviceId) return resolveDeviceModelGroup(draftDeviceId, selection, context, undefined, sshHostId ? { sshHostId } : undefined);
  if (!selection.deviceId) return resolveModelGroup(selection, context, undefined, sshHostId ? { sshHostId } : undefined);
  const owner = selection.deviceId;
  // 只选那台电脑自己的、允许被远程调用的来源：它眼里的「另一台电脑」或分享这台不一定连得上；
  // Agent 在那台为这台运行，与选「其他电脑」那一段里的普通模型同一条件。
  const result = await resolveDeviceModelGroup(owner, selection, context, { agentDeviceId: null }, { remoteInvocableOnly: true });
  return result?.outcome === 'routed' ? { ...result, route: { ...result.route, agentDeviceId: owner } } : result;
}
