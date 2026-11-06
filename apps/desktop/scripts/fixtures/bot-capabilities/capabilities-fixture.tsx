import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { BotCapabilitySettings } from '../../../src/renderer/features/bots/BotCapabilitySettings';
import type { BotCapabilities, BotProfile } from '../../../src/renderer/features/bots/botStore';
import { withBotSystemSkill } from '../../../src/shared/botSystemSkills';

// The owner's real catalog on 2026-11-01 (descriptions shortened only where the source is long).
const LEARNED = [
  { slug: 'diagnose-moviepilot-missing-episodes', name: 'diagnose-moviepilot-missing-episodes', description: '排查 MoviePilot 订阅漏集：核对订阅、站点搜索结果与下载器状态。', updatedAt: '2026-10-30T09:00:00.000Z', enabled: true },
  { slug: 'review-personal-memory', name: 'review-personal-memory', description: '定期回看关于主人的记忆，合并重复、删掉过时内容。', updatedAt: '2026-10-28T09:00:00.000Z', enabled: true },
];
const LOCAL = [
  ['agent-ops', '仅在创建、修改、删除 schedule/常驻监控，或按授权创建独立项目 session、明确启动 subagent/worker/team 编排前使用。'],
  ['cindy-plugin-creator', 'Create or update a Cindy plugin'],
  ['cindy-skill-creator', 'Create or update a Cindy Skill'],
  ['git-workflow', 'Cindy/Codex 产品设计、高保真原型、模拟器验收与工程交付；设计/UI 迭代、使用模拟器、建 worktree、改仓库时加载。'],
  ['gog-google-workspace', 'Use gog for explicit multi-account Google Workspace access'],
  ['learn', 'Distill a reusable Skill with Cindy'],
  ['personal-memory', '个人背景/历史缺口或记住请求按需用。'],
  ['search-verify', 'Search and verify public information with the local Search Gateway.'],
  ['skill-creator', 'Create or update a skill'],
  ['taptap-maker', '使用 Cindy 的 TapTap Maker 插件完成账号连接、项目检查或初始化、构建预览。'],
  ['ui-design', 'Chris 本机工程的 UI 设计标准。凡是产出或改动用户看得见的界面都要加载。'],
  ['x-ops', '在 X(Twitter)上做舆情搜索与发帖的操作手册。'],
].map(([name, description]) => ({ name, description, path: `/skills/${name}/SKILL.md`, enabled: true }));
const TOOLS = ['docs', 'browser', 'computer', 'android', 'contacts', 'feishu', 'feishu_bot', 'google', 'slack', 'wechat', 'ssh', 'collab']
  .map((id) => ({ id, name: id, description: '', available: id !== 'android' }));
const CORE = '## teammate-guide — 伙伴核心技能\nThis core is shared by every teammate and updated with the app.\n### Tasks and teammates\nPrefer finishing work in this chat.';

function Page({ initial }: { initial: BotCapabilities }) {
  const [capabilities, setCapabilities] = useState(initial);
  return (
    <div className="mx-auto max-w-xl p-5">
      <BotCapabilitySettings expanded bot={{ id: 'fixture', canonicalSessionId: 'session-1' } as BotProfile}
        capabilities={capabilities} skills={[]} onChange={() => {}} onConfigure={() => {}}
        onSystemSkillChange={(id, on) => setCapabilities((current) => ({ ...current, systemSkillsOff: withBotSystemSkill(current.systemSkillsOff, id, on) }))}
        onInputHandoffChange={(allowed) => setCapabilities((current) => ({ ...current, inputHandoff: allowed }))} />
    </div>
  );
}

mountPage({
  host: (ctx) => {
    const learned = ctx.case === 'empty' ? [] : LEARNED;
    return {
      localDb: {
        sessions: { get: async () => ({ id: 'session-1', agentKind: 'pi', workingDir: '/fixture' }) },
        sessionsPush: { onPatched: subscription('sessions') },
        bots: {
          listSkills: async () => learned,
          skills: {
            core: async () => ({ name: 'teammate-guide', description: 'Teammate core', body: CORE }),
            read: async (_bot: string, slug: string) => {
              const item = learned.find((entry) => entry.slug === slug);
              return item ? { ...item, body: '## 什么时候用\n每周一次，或主人说“整理一下记忆”时。\n\n## 做法\n- 列出所有记忆，按主题分组。\n- 合并内容重复的条目，保留最新说法。' } : null;
            },
            save: async () => {}, setEnabled: async () => {}, delete: async () => {},
          },
        },
      },
      maker: {
        onMcpChanged: subscription('mcp'),
        listCustomMcpServers: async () => ({ agentKind: 'pi', servers: [{ id: 'search-gateway', name: 'Search Gateway', available: true }] }),
        listAgentSkills: async () => ({ success: true, skills: LOCAL }),
        plugins: { list: async () => TOOLS },
      },
    };
  },
  render: (ctx) => <Page initial={{
    modelChain: [], modelChainOverride: null, skillMode: 'allowlist', skillsExcluded: [], mcpMode: 'inherit', mcpServers: [],
    toolsetMode: 'inherit', toolsets: [], memory: true, permissions: 'ask',
    ...(ctx.case === 'system-off' ? { systemSkillsOff: ['todo'] } : {}),
  } as unknown as BotCapabilities} />,
});
