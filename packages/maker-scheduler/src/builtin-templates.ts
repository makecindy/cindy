import type { ScheduleTemplate, TemplateCategory } from './types.js';

/**
 * 内置自动化模板。
 *
 * 本文件的中文文案是唯一正本：desktop renderer 通过
 * `apps/desktop/src/renderer/i18n/locales/<locale>/common.json` 的
 * `scheduler.builtinTemplates` 块做多语言覆盖（zh-CN 块必须与这里逐字一致，
 * 由 desktop 侧 schedulerTemplateLocalization 测试锁死）；mobile 经
 * `maker:schedule:list-templates` 拿到的仍是这里的中文正本。
 *
 * 选题原则（2026-07-22 与产品确认）：
 * - 数据来源只限工作目录/仓库（agent 本来就有权限的范围）和公开 Web；
 *   绝不周期性读取用户私人账号数据（邮箱、IM、日程）——那类任务每次运行
 *   都消耗用户 token 并把隐私数据喂进定时任务，不作为官方推荐。
 * - 产出必须是可交付物（报告 / 草稿 / PR），不是提醒。
 * - 兼顾开发与非开发办公场景。
 * - 每个分类固定 2 条：desktop 模板网格是两列，超过 2 条会折行（2026-07-24）。
 */

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_NOTIFY = { desktop: true, feishu: false } as const;

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  { id: 'dev-automation', name: '开发自动化', order: 1 },
  { id: 'info-radar', name: '信息雷达', order: 2 },
  { id: 'office-docs', name: '文档与办公', order: 3 },
];

export const BUILTIN_TEMPLATES: ScheduleTemplate[] = [
  {
    id: 'nightly-test-heal',
    name: '夜间自愈测试',
    description: '每晚跑测试，失败项在隔离工作区尝试最小修复',
    category: 'dev-automation',
    source: 'builtin',
    prompt: `运行项目的测试套件，如果有失败项，在隔离工作区尝试给出最小修复。
约束：
- 先按仓库文档或 package 脚本确定标准测试命令，再完整运行
- 只修复有明确失败证据的问题，采用影响面最小的改法，避免顺手重构
- 修复后重跑相关测试确认通过，并复核完整 diff
- 按仓库工作流交付修复（如创建分支并开 PR），不要直接改动主分支
- 无法安全修复的失败项，输出失败原因、疑点文件和建议的排查步骤`,
    cronExpr: '0 2 * * *',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: true,
    notify: DEFAULT_NOTIFY,
    capabilities: ['worktree', 'pr'],
  },
  {
    id: 'pr-gatekeeper',
    name: 'PR 守门人',
    description: '工作日预审开放 PR 的新增改动，按严重程度报告风险',
    category: 'dev-automation',
    source: 'builtin',
    prompt: `检查仓库当前开放的 PR，对新增改动做一轮预审。
约束：
- 逐个查看过去 24 小时内有新提交的开放 PR（周一回看整个周末），引用 PR 编号、文件路径和具体 diff
- 重点找正确性、安全、数据丢失和兼容性问题，按严重程度分级
- 只报告有证据支撑的问题，说明失败场景，不要凭风格偏好挑刺
- 除非用户明确授权，只输出审查结论，不要直接在 PR 上留言或改动代码`,
    cronExpr: '0 10 * * 1-5',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
    capabilities: ['pr'],
  },
  {
    id: 'domain-radar',
    name: '领域雷达',
    description: '定期搜集你关注领域的最新动态，输出有观点的摘要',
    category: 'info-radar',
    source: 'builtin',
    prompt: `围绕主题「{{topic}}」搜集过去 24 小时的最新动态（周一回看整个周末），输出一份有观点的摘要。
约束：
- 用 Web 搜索获取信息，交叉核对多个来源后再采信，标注每条信息的来源链接
- 优先收录有实质内容的进展（发布、研究、政策、重要讨论），过滤营销软文和重复转载
- 对每条动态给出一句"为什么值得关注"的判断，而不是罗列链接
- 信息不足或来源存疑时如实说明，不要臆造`,
    cronExpr: '0 9 * * 1-5',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
    parameters: [
      {
        key: 'topic',
        label: '关注主题',
        type: 'string',
        required: true,
        placeholder: '如：AI Agent、新能源、前端框架',
      },
    ],
    capabilities: ['web', 'params'],
  },
  {
    id: 'competitor-watch',
    name: '竞品动态追踪',
    description: '每周汇总竞品的产品与市场动态，分析对我们的影响',
    category: 'info-radar',
    source: 'builtin',
    prompt: `追踪以下竞品最近一周的动态：{{competitors}}。
约束：
- 用 Web 搜索覆盖产品更新、版本发布、定价变化、市场动作和用户口碑，标注来源
- 区分官方信息和第三方转述，未经证实的传闻要明确标注
- 对每条重要动态给出"对我们意味着什么"的分析和建议
- 没有实质动态时如实说明，不要凑数`,
    cronExpr: '0 9 * * 1',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
    parameters: [
      {
        key: 'competitors',
        label: '竞品名单',
        type: 'string',
        required: true,
        placeholder: '如：Notion、Linear、Figma',
      },
    ],
    capabilities: ['web', 'params'],
  },
  {
    id: 'weekly-work-draft',
    name: '周报草稿助手',
    description: '从工作目录的文档和产出物整理本周工作，生成周报草稿',
    category: 'office-docs',
    source: 'builtin',
    prompt: `根据工作目录中本周的文档、笔记和产出物变化，整理一份周报草稿。
约束：
- 只使用工作目录内有实际修改痕迹的内容作为证据，注明对应文件
- 按"本周完成 / 进行中 / 下周计划 / 需要协调"组织，语言简洁可直接提交
- 区分实质进展和例行事务，突出有价值的产出
- 材料不足以判断的部分留出占位并说明，方便用户补充`,
    cronExpr: '0 16 * * 5',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
  },
  {
    id: 'knowledge-freshness',
    name: '知识库保鲜',
    description: '每月体检工作目录文档，找出过期与矛盾内容',
    category: 'office-docs',
    source: 'builtin',
    prompt: `体检工作目录中的文档，找出需要更新的内容。
约束：
- 检查过期信息（旧日期、失效链接、已废弃的流程或工具）、前后矛盾和重复内容
- 每个问题都注明文件路径和具体位置，说明判断依据
- 按"建议更新 / 建议合并 / 建议删除"分类，给出修订建议清单
- 只输出体检报告，不要直接修改文档`,
    cronExpr: '0 10 1 * *',
    timezone: DEFAULT_TIMEZONE,
    recurring: true,
    agentKind: 'claude-code',
    useWorktree: false,
    notify: DEFAULT_NOTIFY,
  },
];
