/**
 * 定时任务检查脚本失败时，判断原因是不是「脚本所属的插件不可用」。
 *
 * 插件随包的技能（含 PR 跟进用的检查脚本）投影在
 * `<approvalStateRoot>/agent-skills/skills/<storagePart>--<skill>/`。插件卸载或停用时
 * 整个目录被撤下，检查命令只会以「找不到文件」失败，用户看到的只有退出码。
 * 这里从命令里找出这类目录：目录已不存在，就把所属插件交给界面提示安装或启用。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import type { PreRunHookMissingPlugin } from '@cindy/maker-scheduler';

import { parsePluginStoragePart } from '../../shared/pluginIdentity.js';

export interface PluginSkillDirReference {
  storagePart: string;
  skillDir: string;
}

/** 命令里第一个指向插件技能投影目录的路径；没有返回 null。 */
export function findPluginSkillDirInCommand(
  command: string,
  skillsRoot: string,
): PluginSkillDirReference | null {
  const root = path.resolve(skillsRoot);
  // 命令可能被引号包住，也可能用另一种分隔符写（Windows），两种前缀都认。
  const prefixes = [...new Set([`${root}${path.sep}`, `${root.split(path.sep).join('/')}/`])];
  for (const prefix of prefixes) {
    let from = 0;
    while (from < command.length) {
      const at = command.indexOf(prefix, from);
      if (at < 0) break;
      from = at + prefix.length;
      const linkName = /^[^/\\'"\s]+/.exec(command.slice(from))?.[0];
      const sep = linkName?.lastIndexOf('--') ?? -1;
      if (!linkName || sep <= 0) continue;
      return { storagePart: linkName.slice(0, sep), skillDir: path.join(root, linkName) };
    }
  }
  return null;
}

export interface ScheduleHookPluginDiagnosisDeps {
  skillsRoot: string;
  /** 已安装（不论是否启用）的同一插件；未安装返回 null。 */
  findInstalled(ghostId: string, namespace: string | null): { name: string; enabled: boolean } | null;
  /** 市场信息，尽力而为：拿不到返回 null，不影响诊断结论。 */
  lookupMarket(ghostId: string, namespace: string | null): Promise<{ pluginId?: string; name?: string } | null>;
}

export async function diagnoseScheduleHookPlugin(
  command: string,
  deps: ScheduleHookPluginDiagnosisDeps,
): Promise<PreRunHookMissingPlugin | undefined> {
  const ref = findPluginSkillDirInCommand(command, deps.skillsRoot);
  // 目录还在说明插件可用，失败属于脚本自身，照原样报告。
  if (!ref || existsSync(ref.skillDir)) return undefined;
  const identity = parsePluginStoragePart(ref.storagePart);
  if (!identity) return undefined;
  const { ghostId, namespace } = identity;
  const installed = deps.findInstalled(ghostId, namespace);
  // 已启用却缺技能目录（例如插件更新去掉了某项技能）不是「没装/没启用」，不乱下结论。
  if (installed?.enabled) return undefined;
  const market = await deps.lookupMarket(ghostId, namespace).catch(() => null);
  const name = installed?.name || market?.name;
  return {
    ghostId,
    ...(namespace ? { namespace } : {}),
    ...(market?.pluginId ? { pluginId: market.pluginId } : {}),
    ...(name ? { name } : {}),
    ...(installed ? { installed: true } : {}),
  };
}
