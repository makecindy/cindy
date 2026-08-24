/**
 * 装入确认框的风险分档(纯函数,无 React、无 i18n)。
 *
 * 只在 **Agent 单方面发起** 装入时改变确认框行为——手动入口不受影响。分档决定
 * 是否加重(高危:手输插件 id 才能确认;中危:只加来源横幅)。判据一律按
 * `ghostPermissionItems` 产出的权限项 **key** 归类,与用户在确认框里实际看到的
 * 逐项清单同源——不另立一套"作者声明"口径,避免"分档看到的"与"清单展示的"分叉。
 *
 * 分档(2026-08 产品拍板):
 * - 高危:skill(技能指令以用户全部权限执行、跨项目)/ node(本机执行,浏览器
 *   沙箱管不住)/ network.secrets 任意来源(含 oauth,能把用户凭证发往声明域名)/
 *   agent.background(后台自动触发)/ agent.errand(替它干活并取走结果)。
 * - 中危:fs(写文件——最危险那档写会话工作目录已受会话 permission 模式约束,
 *   免批模式下 Agent 本就能直写,插件多这能力不改变攻击面)/ network.hosts(出网
 *   域名)/ agent.schedule(能反复弹自动化面板、烧模型额度,但须用户在面板上
 *   亲手保存才生效)。
 * - 低危:纯沙箱 tool / card / panel 及其它未列入的能力。
 */
import type { GhostPermissionItem } from '../../shared/ghost';

export type GhostRiskTier = 'high' | 'mid' | 'low';

export interface GhostRiskAssessment {
  tier: GhostRiskTier;
  /** 高危能力命中标记(来源横幅据此点破最该被看见的那一两条)。 */
  hazards: {
    skill: boolean;
    node: boolean;
    /** 声明了需要凭证(network.secrets 任意来源,含 oauth / 组织身份)。 */
    secret: boolean;
    agentBackground: boolean;
    agentErrand: boolean;
  };
  /** 声明的出网域名(凭证外发对象;凭证点破文案用)。 */
  networkHosts: string[];
}

/** 单条权限项的风险档(按 key 归类,与清单展示同源)。 */
function itemRiskTier(item: GhostPermissionItem): GhostRiskTier {
  const key = item.key;
  if (
    key.startsWith('skill:') ||
    key.startsWith('node:') ||
    key.startsWith('network:secret:') ||
    key === 'agent:background' ||
    key === 'agent:errand'
  ) {
    return 'high';
  }
  if (key === 'fs' || key.startsWith('network:host:') || key === 'agent:schedule') {
    return 'mid';
  }
  return 'low';
}

/**
 * 汇总一份权限清单的整体风险档 + 高危命中标记 + 出网域名。
 * 传全量清单 = 新装分档;传更新 diff 的新增项 = 更新扩权分档(tier !== 'low'
 * 即"新增了高危或中危能力")。
 */
export function assessGhostInstallRisk(items: GhostPermissionItem[]): GhostRiskAssessment {
  const hazards = {
    skill: false,
    node: false,
    secret: false,
    agentBackground: false,
    agentErrand: false,
  };
  const networkHosts: string[] = [];
  let hasHigh = false;
  let hasMid = false;
  for (const item of items) {
    const tier = itemRiskTier(item);
    if (tier === 'high') hasHigh = true;
    else if (tier === 'mid') hasMid = true;
    if (item.key.startsWith('skill:')) hazards.skill = true;
    else if (item.key.startsWith('node:')) hazards.node = true;
    else if (item.key.startsWith('network:secret:')) hazards.secret = true;
    else if (item.key === 'agent:background') hazards.agentBackground = true;
    else if (item.key === 'agent:errand') hazards.agentErrand = true;
    if (item.key.startsWith('network:host:')) {
      const host = item.labelArgs?.host;
      if (host) networkHosts.push(host);
    }
  }
  const tier: GhostRiskTier = hasHigh ? 'high' : hasMid ? 'mid' : 'low';
  return { tier, hazards, networkHosts };
}
