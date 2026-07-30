/**
 * sidebarUpperSingleButton.test.ts
 * ---------------------------------------------------------------------------
 * delayed-create 重构回归(2026-05-03):sidebar 顶部 "+ New" 必须是
 * 单按钮(无 vendor 下拉),并 navigate 到 transient draft 路由 '/cc-agent/new'。
 *
 * 静态扫描风格,与 newCcsToastWhenExists.test.ts 一致——避免组件级 mock 链路过深。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sidebarSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);

describe('sidebar 顶部 + New 单按钮(delayed-create)', () => {
  it('顶部 + 不再暴露 vendor 下拉选项', () => {
    // SidebarUpper 仍可为其它入口（如 Automations 右键菜单）使用 DropdownMenu；
    // delayed-create 的约束是顶部 New 本身不再提供 vendor pick 下拉。
    expect(sidebarSource).not.toMatch(/New Claude Session/);
    expect(sidebarSource).not.toMatch(/New Codex Session/);
  });

  it("源码不再 import VendorReadinessBadge / useVendorReadiness", () => {
    expect(sidebarSource).not.toMatch(/VendorReadinessBadge/);
    expect(sidebarSource).not.toMatch(/useVendorReadiness/);
  });

  it("通用新建进入 /cc-agent/new,并带 generic workspace 提示", () => {
    // sidebar 重构后 expanded 态的“+ New”上移到 shell 的 SidebarTopNav;
    // CCAgentSidebarUpper 内只剩 CollapsedView(rail 态)自带的 handleNewCCS 一处。
    const matches = sidebarSource.match(/navigate\(['`]\/cc-agent\/new['`],\s*\{\s*state:\s*makeNewMakerRouteState\('generic'\)\s*\}\)/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(1);
    expect(sidebarSource).toContain("function makeNewMakerRouteState(workspacePrompt: 'generic' | 'dialogue')");
    expect(sidebarSource).not.toContain('requestId: Date.now()');
  });

  it('顶部只保留一个统一新建入口,不再暴露单独的新建对话入口', () => {
    expect(sidebarSource).toContain("t('ccAgent.layout.new')");
    expect(sidebarSource).not.toContain("t('ccAgent.layout.newDialogue')");
    expect(sidebarSource).not.toContain("navigate('/cc-agent/new-dialogue')");
  });

  it('handleNewCCS 不再接收 agentKind 参数(签名不带 vendor)', () => {
    // 旧: const handleNewCCS = useCallback(async (agentKind: AgentKind = 'cc') => {
    // 新: const handleNewCCS = useCallback(() => {
    expect(sidebarSource).not.toMatch(/handleNewCCS\s*=\s*useCallback\(\s*async\s*\(\s*agentKind/);
    expect(sidebarSource).not.toMatch(/handleNewCCS\(\s*['`]cc['`]\s*\)/);
    expect(sidebarSource).not.toMatch(/handleNewCCS\(\s*['`]codex['`]\s*\)/);
  });

  it('+ New 不再调 createSession(延迟到 NewMakerDraftRoute → handleSend)', () => {
    // handleNewCCS 内部不再出现 createSession() —— 在源码里 createSession 仍可
    // 在其它流程出现(如老 emptyDraft 路径已移除创建);用 handleNewCCS 作用域内的
    // 字符串扫描验证其实现里不含 createSession。
    // sidebar 重构后 CCAgentSidebarUpper 只剩 CollapsedView(rail)一处 handleNewCCS;
    // expanded 态的“+ New”已上移到 SidebarTopNav。
    const matches = sidebarSource.match(/const handleNewCCS = useCallback\([\s\S]*?\}, \[/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1); // CollapsedView (rail);expanded 的 New 在 SidebarTopNav
    for (const block of matches!) {
      expect(block).not.toMatch(/createSession\b/);
    }
  });
});

describe('Project 行内 + 也对标统一 New(delayed-create)', () => {
  const projectNodeSource = readFileSync(
    resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'sections', 'ProjectNode.tsx'),
    'utf8',
  );

  it('ProjectNode + 按钮不再用 DropdownMenu 包裹 vendor 选项', () => {
    // 注意 ProjectNode 内右键菜单(Archived All)仍用 DropdownMenu,所以不能整文件
    // 禁止;改用语义校验:不再出现 New Claude Session / New Codex Session 这种
    // vendor pick 文案。
    expect(projectNodeSource).not.toMatch(/New Claude Session/);
    expect(projectNodeSource).not.toMatch(/New Codex Session/);
  });

  it('ProjectNode 不再 import VendorReadinessBadge / Readiness 类型', () => {
    expect(projectNodeSource).not.toMatch(/VendorReadinessBadge/);
    expect(projectNodeSource).not.toMatch(/import\s+type\s+\{\s*Readiness\s*\}/);
  });

  it('Project 行内新建会话使用段头新建对话同款图标', () => {
    expect(projectNodeSource).toContain('SquarePen');
    expect(projectNodeSource).toContain('<SquarePen size={14} strokeWidth={2} />');
  });

  it('handleCreateInProject 调用 patchDraft({workingDir}) 后 navigate /cc-agent/new', () => {
    // device-link:草稿现在带 deviceLinkDeviceId(远程项目新建会话需要),与 SSH remoteHostId 互斥。
    // 断言关键字段而非整块字面量(对格式 / 字段增减鲁棒)。
    expect(sidebarSource).toContain('workingDir: project.workingDir');
    expect(sidebarSource).toContain('deviceLinkDeviceId: project.deviceLinkDeviceId');
    expect(sidebarSource).toMatch(/navigate\(['`]\/cc-agent\/new['`],\s*\{\s*state:\s*makeNewMakerRouteState\('dialogue'\)\s*\}\)/);
  });

  it('Projects 段头新建项目先选择目录，再预填 workingDir 进入 /cc-agent/new', () => {
    expect(sidebarSource).toContain('const handleCreateProject = useCallback(async () =>');
    expect(sidebarSource).toContain('window.electronAPI.showOpenDirectoryDialog()');
    expect(sidebarSource).toContain('patchNewMakerDraft({ workingDir: result.path, remoteHostId: null })');
    expect(sidebarSource).toContain('onCreateProject={handleCreateProject}');
  });
});

describe('archive dirty-worktree warning', () => {
  it('only skips the archive dialog when the preflight confirms the worktree is clean', () => {
    // 钉的是预检顺序与放行判据,不是排版:末段用 [\s\S]*? 容忍换行。
    //   · 菜单归档与行内 archive-now 共用 isArchiveLike 这一条无弹窗路径 ——
    //     归档可逆,只有 worktree 有情况才升级到 ConfirmDialog;
    //   · 判据必须是 `preflight !== 'clean'`,**不能**退回布尔的「不是脏的就放行」:
    //     预检失败是 'unknown',塌成放行就会静默回收带未提交改动的 worktree
    //     (greptile review);
    //   · 走 resolveWorktreeRemovalPreflight(而非直调 fetch)才吃得到菜单打开 /
    //     亮出 Confirm 胶囊时的预取,见 worktreeRemovalWarning 的预取缓存;
    //   · activeSessionId 取 viewedSessionIdRef.current(而非 viewedSessionId)是为了
    //     让 handleActionClick 的 useCallback deps 保持稳定,见 sessionRowRenderIsolation
    //     的行渲染隔离不变量。
    expect(sidebarSource).toMatch(
      /if \(isArchiveLike\) \{[\s\S]*?resolveWorktreeRemovalPreflight\([\s\S]*?if \(preflight !== 'clean'\) \{[\s\S]*?setConfirm\(\{[\s\S]*?action: 'archive',[\s\S]*?dirtyWorktree: preflight === 'dirty',[\s\S]*?\}\);[\s\S]*?return;[\s\S]*?await runSessionAction\(sessionId, 'archive', \{[\s\S]*?activeSessionId: viewedSessionIdRef\.current,[\s\S]*?\}\);/,
    );
  });

  it('resolves the worktree preflight last, after the attachment gate', () => {
    // 预检之后再 await 任何东西都会给 clean 结论留失效窗口(codex review):
    // 接管查询必须先结算,worktree 预检是最后一个前置条件。
    const archiveBranch = sidebarSource.match(
      /if \(isArchiveLike\) \{[\s\S]*?await runSessionAction\(sessionId, 'archive'/,
    )?.[0];
    expect(archiveBranch).toBeTruthy();
    expect(archiveBranch!.indexOf('blockedByAttachment()')).toBeLessThan(
      archiveBranch!.indexOf('resolveWorktreeRemovalPreflight('),
    );
  });

  it('keeps the delete confirm dialog — deletion is irreversible', () => {
    expect(sidebarSource).toMatch(
      /if \(action === 'delete'\) \{[\s\S]*?resolveWorktreeRemovalPreflight\([\s\S]*?setConfirm\(\{ open: true, sessionId, action, dirtyWorktree \}\);/,
    );
  });
});
