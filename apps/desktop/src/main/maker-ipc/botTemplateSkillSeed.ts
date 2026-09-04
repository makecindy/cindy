import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { BotTemplatePresetId } from '../../shared/botTemplatePreset.js';
import { botSkillRootDir, seedBotSkillIfMissing, type BotSkillRecord } from './botSkillStore.js';

type TemplateSkillSeed = {
  slug: string;
  name: string;
  description: string;
  body: string;
};

export interface BotTemplateSkillSeedResult {
  /** 本次是否刚把整套模板安装推进到“完成”；用于刷新已经存在的运行时。 */
  completedNow: boolean;
  skills: Array<{ record: BotSkillRecord; created: boolean }>;
}

const TEMPLATE_SKILLS: Record<BotTemplatePresetId, readonly TemplateSkillSeed[]> = {
  cindy: [
    {
      slug: 'everyday-work-coordination',
      name: '日常工作推进',
      description: '处理写作、整理、分析、计划和跨伙伴协作时使用。',
      body: [
        '# 日常工作推进',
        '',
        '## 先判断工作形态',
        '',
        '- 可以直接完成的，就直接交付结果，不把步骤重新甩给用户。',
        '- 涉及专门判断或长时间执行的，先写清目标、输入、限制和期望产物，再请合适的伙伴接手。',
        '- 收到对方结果后自己检查、整合并回到当前交流中收口，不让用户负责转述和追问。',
        '',
        '## 形成可用成果',
        '',
        '- 写作和整理先确定受众、用途与语气，再产出可直接使用的版本。',
        '- 分析要区分事实、推断和建议，并标出重要的不确定性。',
        '- 计划要包含明确负责人、下一步和必要时间点。',
        '- 需要留档、分享或继续编辑时，使用当前可用的文档能力生成正式文件。',
        '',
        '## 收口检查',
        '',
        '- 结果是否真正回答了用户的问题。',
        '- 引用、数字、附件和文件是否可用。',
        '- 是否仍有需要用户决定的事项；若有，只问最关键的问题。',
      ].join('\n'),
    },
  ],
  dash: [
    {
      slug: 'executive-decision-review',
      name: '决策与审批',
      description: '处理方向取舍、经营判断、管理决策和重要工作审批时使用。',
      body: [
        '# 决策与审批',
        '',
        '## 建立决策题',
        '',
        '- 用一句话说明要决定什么，以及不决定的代价。',
        '- 分开列出已知事实、关键假设、约束和仍缺的信息。',
        '- 只保留少量真正不同的可选方案，不用细枝末节制造假选择。',
        '',
        '## 综合判断',
        '',
        '- 产品：用户价值、差异化、体验完整度和长期方向。',
        '- 财务：投入、回报、现金与机会成本。',
        '- 审美：表达是否准确、克制、一致，是否符合品牌与使用场景。',
        '- 管理：负责人、资源、组织能力、依赖与执行风险。',
        '',
        '## 给出结论',
        '',
        '- 顺序固定为：结论、理由、主要风险、下一步。',
        '- 审批必须明确回答“通过”“补充信息”或“暂缓”，并写清条件。',
        '- 需要讨论、签批或长期留档时，使用当前可用的文档能力形成决策文档。',
        '- 信息不足时说明缺口，不编造数字，也不把个人偏好包装成公司原则。',
      ].join('\n'),
    },
  ],
  lizi: [
    {
      slug: 'technical-delivery',
      name: '技术问题交付',
      description: '处理开发、架构、故障、发布和技术风险时使用。',
      body: [
        '# 技术问题交付',
        '',
        '## 定位',
        '',
        '- 先读取真实环境、代码和日志，复现或建立足够可信的证据。',
        '- 区分症状、直接原因和根因；无法确认时明确写成假设。',
        '- 检查现有约束、用户改动和相关架构边界。',
        '',
        '## 推进',
        '',
        '- 制定最小但完整的方案，避免顺手扩大范围。',
        '- 复杂工作拆成边界清楚的部分，可以请合适的执行伙伴并行处理。',
        '- 汇总时统一检查接口、行为和风险，不能把不同部分的结论直接拼接。',
        '',
        '## 验证与交付',
        '',
        '- 运行与改动风险相匹配的检查，验证真实输出而不只验证代码路径。',
        '- 汇报结果、关键证据、尚未验证的部分和剩余风险。',
        '- 方案、评审、排障或发布说明需要继续使用时，使用当前可用的文档能力形成技术文档。',
        '- 没有证据不宣布完成，不绕过测试、安全或数据保护边界。',
      ].join('\n'),
    },
  ],
};

function completionMarkerPath(
  userDataDir: string,
  botId: string,
  templateId: BotTemplatePresetId,
): string {
  return path.join(botSkillRootDir(userDataDir, botId), `.template-skills-${templateId}.seeded`);
}

async function isSeedComplete(
  userDataDir: string,
  botId: string,
  templateId: BotTemplatePresetId,
): Promise<boolean> {
  try {
    return (await fs.stat(completionMarkerPath(userDataDir, botId, templateId))).isFile();
  } catch {
    return false;
  }
}

/** 创建预设伙伴时安装真实 Skill；同 slug 已存在则完整保留用户版本。 */
export async function seedBotTemplateSkills(
  userDataDir: string,
  botId: string,
  templateId: BotTemplatePresetId,
): Promise<BotTemplateSkillSeedResult> {
  // 完成标记比“Skill 当前是否存在”多表达一层用户意图：成功装过以后，即使用户
  // 主动删除内置 Skill，也不能在下次任务中擅自装回来。
  if (await isSeedComplete(userDataDir, botId, templateId)) {
    return { completedNow: false, skills: [] };
  }
  const skills = await Promise.all(
    TEMPLATE_SKILLS[templateId].map((skill) => seedBotSkillIfMissing(userDataDir, botId, skill)),
  );
  const markerPath = completionMarkerPath(userDataDir, botId, templateId);
  try {
    await fs.writeFile(markerPath, `${templateId}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== 'EEXIST') throw cause;
  }
  return { completedNow: true, skills };
}
