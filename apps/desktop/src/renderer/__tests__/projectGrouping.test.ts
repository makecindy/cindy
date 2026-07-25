/**
 * projectGrouping — vitest unit tests
 *
 * 覆盖：normalize、displayName 同名消歧、groupSessions 边界。
 */

import { describe, expect, it } from 'vitest';

import {
  deviceLinkProjectKey,
  extractDisplayName,
  groupSessions,
  normalizeProjectKey,
  normalizeWorkingDir,
  projectIdentityKey,
  pinnedSessionIdsInDisplayOrder,
} from '@/features/cc-agent/lib/projectGrouping';
import type { Session } from '@/lib/ccAgent.types';

/* ---------------- helpers ---------------- */

let id = 0;
function s(partial: Partial<Session>): Session {
  id += 1;
  // 默认把 userSendAt 与 updatedAt 对齐 —— 表示该 session 已开聊（非草稿），
  // 应按 workingDir 归类。模拟"未发过任何消息的草稿"时显式传 userSendAt: null。
  const updatedAt = partial.updatedAt ?? '2026-01-01T00:00:00.000Z';
  const userSendAt = partial.userSendAt !== undefined ? partial.userSendAt : updatedAt;
  return {
    id: partial.id ?? `s${id}`,
    userId: 'u',
    title: partial.title ?? `t${id}`,
    workingDir: partial.workingDir ?? null,
    workspaceKind: partial.workspaceKind ?? 'project',
    model: 'm',
    effort: 'medium' as Session['effort'],
    permissionMode: 'default' as Session['permissionMode'],
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: partial.pinnedAt ?? null,
    userSendAt,
    status: partial.status ?? 'active',
    agentKind: partial.agentKind ?? 'cc',
    source: partial.source,
    remoteHostId: partial.remoteHostId ?? null,
    deviceLinkDeviceId: partial.deviceLinkDeviceId,
    deviceLinkDeviceName: partial.deviceLinkDeviceName,
    deviceLinkConnectionStatus: partial.deviceLinkConnectionStatus,
    extraDirs: partial.extraDirs ?? [],
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt,
    _count: partial._count,
  };
}

/* ============================== normalizeWorkingDir ============================== */

describe('normalizeWorkingDir', () => {
  it('returns null for nullish / empty / whitespace', () => {
    expect(normalizeWorkingDir(null)).toBeNull();
    expect(normalizeWorkingDir(undefined)).toBeNull();
    expect(normalizeWorkingDir('')).toBeNull();
    expect(normalizeWorkingDir('   ')).toBeNull();
  });

  it('converts Windows backslash to POSIX', () => {
    expect(normalizeWorkingDir('D:\\AIWork\\xdt-maker')).toBe('D:/AIWork/xdt-maker');
    expect(normalizeWorkingDir('C:\\foo\\bar\\')).toBe('C:/foo/bar');
  });

  it('strips trailing slash but keeps single root', () => {
    expect(normalizeWorkingDir('/foo/bar/')).toBe('/foo/bar');
    expect(normalizeWorkingDir('/foo/bar///')).toBe('/foo/bar');
    expect(normalizeWorkingDir('/')).toBe('/');
    expect(normalizeWorkingDir('D:/')).toBe('D:/');
    expect(normalizeWorkingDir('D:\\')).toBe('D:/');
  });

  it('leaves already-clean POSIX path unchanged', () => {
    expect(normalizeWorkingDir('/Users/sam/work/xdt-maker')).toBe('/Users/sam/work/xdt-maker');
  });

  it('normalizes project worktree paths to the base repo for sidebar grouping', () => {
    expect(normalizeWorkingDir('D:\\AI\\tl_web_agent\\.worktrees\\cx-20260526-104440')).toBe(
      'D:/AI/tl_web_agent',
    );
    expect(normalizeWorkingDir('\\\\?\\D:\\AI\\tl_web_agent\\.worktrees\\cx-20260526-104440')).toBe(
      'D:/AI/tl_web_agent',
    );
    expect(normalizeWorkingDir('/repo/.cindy-worktrees/auto-kypf0e/server')).toBe('/repo');
    expect(normalizeWorkingDir('/repo/.xdt-worktrees/auto-kypf0e/server')).toBe('/repo');
    expect(normalizeWorkingDir('/repo/.claude/worktrees/agent-a123/server')).toBe('/repo');
  });
});

/* ============================== normalizeProjectKey ============================== */

describe('normalizeProjectKey', () => {
  it('maps legacy bare workingDir keys to local keys', () => {
    expect(normalizeProjectKey('/Users/sam/xdt-maker')).toBe('local:/Users/sam/xdt-maker');
  });

  it('keeps local-prefixed keys canonical', () => {
    expect(normalizeProjectKey('local:/Users/sam/xdt-maker/')).toBe('local:/Users/sam/xdt-maker');
  });

  it('keeps remote keys canonical', () => {
    expect(normalizeProjectKey('remote:host-a:/repo/')).toBe('remote:host-a:/repo');
  });
});

/* ============================== extractDisplayName ============================== */

describe('extractDisplayName', () => {
  it('returns 1-segment basename when no collision', () => {
    const r = extractDisplayName('/Users/sam/xdt-maker', ['/Users/sam/claude-mem']);
    expect(r).toEqual({ name: 'xdt-maker', segments: 1 });
  });

  it('uses 2 segments to disambiguate same basename', () => {
    const all = ['/Users/sam/xdt-maker', '/workspace/xdt-maker'];
    expect(extractDisplayName('/Users/sam/xdt-maker', all)).toEqual({
      name: 'sam/xdt-maker',
      segments: 2,
    });
    expect(extractDisplayName('/workspace/xdt-maker', all)).toEqual({
      name: 'workspace/xdt-maker',
      segments: 2,
    });
  });

  it('falls back to 3 segments when 2 still collide', () => {
    const all = ['/a/b/foo', '/c/b/foo'];
    const r = extractDisplayName('/a/b/foo', all);
    expect(r.segments).toBe(3);
    expect(r.name).toBe('a/b/foo');
  });

  it('accepts exact duplicate residual collision as basename', () => {
    const all = ['/x/a/b/foo', '/x/a/b/foo'];
    const r = extractDisplayName('/x/a/b/foo', all);
    expect(r.segments).toBe(1);
    expect(r.name).toBe('foo');
  });

  it('expands beyond 3 segments when deeper same-tail paths still collide', () => {
    const all = [
      'D:/tl_linhengze_main/frontend/trunk/Editor/UE_game/Script/Lua',
      'D:/tl_linhengze_test/frontend/trunk/Editor/UE_game/Script/Lua',
    ];
    const r = extractDisplayName(all[0], all);
    expect(r.name).toBe('tl_linhengze_main/frontend/trunk/Editor/UE_game/Script/Lua');
    expect(r.segments).toBe(7);
  });

  it('honors project aliases before automatic display-name disambiguation', () => {
    const a = s({ workingDir: '/workspace/main/frontend/trunk/Editor/UE_game/Script/Lua' });
    const b = s({ workingDir: '/workspace/test/frontend/trunk/Editor/UE_game/Script/Lua' });
    const r = groupSessions([a, b], {
      projectAliases: new Map([
        ['local:/workspace/main/frontend/trunk/Editor/UE_game/Script/Lua', '主线 Lua'],
      ]),
    });
    const aliased = r.projects.find(
      (p) => p.workingDir === '/workspace/main/frontend/trunk/Editor/UE_game/Script/Lua',
    );
    const automatic = r.projects.find(
      (p) => p.workingDir === '/workspace/test/frontend/trunk/Editor/UE_game/Script/Lua',
    );
    expect(aliased?.displayName).toBe('主线 Lua');
    expect(aliased?.segments).toBe(0);
    expect(automatic?.displayName).toBe('test/frontend/trunk/Editor/UE_game/Script/Lua');
  });

  it('handles single-segment workingDir', () => {
    // 验证：own 只有 1 段 ['projects'] 时，basename 与 '/Users/me/projects' 冲突
    //   → segments=1 时两边 tailJoin(1) 都是 'projects'，冲突；
    //   → 升到 segments=2：own.tailJoin(2) 仍是 'projects'（不足 2 段取全部），
    //     other.tailJoin(2)='me/projects'，不再冲突 → 算法返回 segments=2。
    //   注意 name 仍是 'projects'（own 段数不足），但 segments 字段记 2，反映
    //   "在 2 段消歧层级被接受"——这是算法对单段输入的合理结果。
    const r = extractDisplayName('/projects', ['/Users/me/projects']);
    expect(r.segments).toBe(2);
    expect(r.name).toBe('projects');
  });

  it('honors minSegments=2 to skip 1-segment shortcut', () => {
    // 即使无冲突，也强制至少 2 段——用于"先创建保留 basename，后创建必须加 parent"
    const r = extractDisplayName('/Users/sam/xdt-maker', ['/workspace/xdt-maker'], 2);
    expect(r).toEqual({ name: 'sam/xdt-maker', segments: 2 });
  });
});

/* ============================== groupSessions ============================== */

describe('groupSessions', () => {
  it('returns empty result for empty input', () => {
    expect(groupSessions([])).toEqual({
      pinned: [],
      dialogues: [],
      unclassified: [],
      projects: [],
    });
  });

  it('groups 1000 same-basename projects with stable display names', () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      s({
        id: `perf-${i}`,
        workingDir: `/workspace/team-${String(i).padStart(4, '0')}/app`,
        createdAt: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        updatedAt: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        _count: { messages: 1 },
      }),
    );

    const r = groupSessions(many);

    expect(r.projects).toHaveLength(1000);
    expect(r.projects.find((p) => p.workingDir === '/workspace/team-0999/app')?.displayName).toBe(
      'team-0999/app',
    );
    expect(r.projects.find((p) => p.workingDir === '/workspace/team-0000/app')?.displayName).toBe(
      'app',
    );
  });

  it('puts pinned sessions in `pinned`, sorted by pinnedAt desc', () => {
    const a = s({ title: 'a', pinnedAt: '2026-04-19T00:00:00.000Z' });
    const b = s({ title: 'b', pinnedAt: '2026-04-20T00:00:00.000Z' });
    const r = groupSessions([a, b]);
    expect(r.pinned.map((x) => x.title)).toEqual(['b', 'a']);
    expect(r.dialogues).toEqual([]);
    expect(r.unclassified).toEqual([]);
    expect(r.projects).toEqual([]);
  });

  it('puts sessions without workingDir in `unclassified`, sorted by updatedAt desc', () => {
    const a = s({ title: 'a', workingDir: null, updatedAt: '2026-04-19T00:00:00.000Z' });
    const b = s({ title: 'b', workingDir: '   ', updatedAt: '2026-04-20T00:00:00.000Z' });
    const r = groupSessions([a, b]);
    expect(r.unclassified.map((x) => x.title)).toEqual(['b', 'a']);
  });

  it('groups Windows slash variants under the same project identity', () => {
    const registrySession = s({
      title: 'registry',
      workingDir: 'D:\\Project-001',
      updatedAt: '2026-04-19T00:00:00.000Z',
    });
    const newSession = s({
      title: 'new',
      workingDir: 'D:/Project-001',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });

    const r = groupSessions([registrySession, newSession]);

    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].projectKey).toBe('local:D:/Project-001');
    expect(r.projects[0].workingDir).toBe('D:/Project-001');
    expect(r.projects[0].sessions.map((x) => x.title)).toEqual(['new', 'registry']);
  });

  it('groups by normalized workingDir', () => {
    const a = s({
      title: 'a',
      workingDir: 'D:\\AIWork\\xdt-maker',
      updatedAt: '2026-04-19T00:00:00.000Z',
    });
    const b = s({
      title: 'b',
      workingDir: 'D:/AIWork/xdt-maker/',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });
    const c = s({
      title: 'c',
      workingDir: '/Users/me/claude-mem',
      updatedAt: '2026-04-18T00:00:00.000Z',
    });
    const r = groupSessions([a, b, c]);
    expect(r.projects.length).toBe(2);
    const xdt = r.projects.find((p) => p.displayName === 'xdt-maker');
    const mem = r.projects.find((p) => p.displayName === 'claude-mem');
    expect(xdt?.sessions.map((x) => x.title)).toEqual(['b', 'a']); // updatedAt desc
    expect(mem?.sessions.map((x) => x.title)).toEqual(['c']);
  });

  it('keeps remote sessions from different hosts in separate projects', () => {
    const a = s({
      title: 'a',
      workingDir: '/repo',
      remoteHostId: 'host-a',
      updatedAt: '2026-04-19T00:00:00.000Z',
    });
    const b = s({
      title: 'b',
      workingDir: '/repo',
      remoteHostId: 'host-b',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });
    const r = groupSessions([a, b]);
    expect(r.projects).toHaveLength(2);
    expect(r.projects.map((p) => p.projectKey).sort()).toEqual([
      'remote:host-a:/repo',
      'remote:host-b:/repo',
    ]);
  });

  it('keeps legacy bare keys readable as local projects', () => {
    const a = s({
      title: 'a',
      workingDir: '/repo',
      updatedAt: '2026-04-19T00:00:00.000Z',
    });
    const r = groupSessions([a]);
    expect(r.projects[0]?.projectKey).toBe('local:/repo');
    expect(r.projects[0]?.scope).toBe('local');
  });

  it('orders projects by latestActivityAt desc', () => {
    const a = s({ workingDir: '/p/alpha', updatedAt: '2026-04-19T00:00:00.000Z' });
    const b = s({ workingDir: '/p/beta', updatedAt: '2026-04-20T00:00:00.000Z' });
    const c = s({ workingDir: '/p/gamma', updatedAt: '2026-04-18T00:00:00.000Z' });
    const r = groupSessions([a, b, c]);
    expect(r.projects.map((p) => p.displayName)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('disambiguates same-basename projects: earliest createdAt keeps basename, others get parent', () => {
    // A 先创建（createdAt 更早）→ 保留纯 basename；B 后创建 → 加 parent 段
    const a = s({
      workingDir: '/Users/sam/xdt-maker',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });
    const b = s({
      workingDir: '/workspace/xdt-maker',
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-19T00:00:00.000Z',
    });
    const r = groupSessions([a, b]);
    const aNode = r.projects.find((p) => p.workingDir === '/Users/sam/xdt-maker');
    const bNode = r.projects.find((p) => p.workingDir === '/workspace/xdt-maker');
    expect(aNode?.displayName).toBe('xdt-maker');
    expect(aNode?.segments).toBe(1);
    expect(bNode?.displayName).toBe('workspace/xdt-maker');
    expect(bNode?.segments).toBe(2);
  });

  it('same-basename: keeps the project containing the earliest-created session as the basename winner', () => {
    // dir-A 包含更早的 session（4/1）→ 即便 dir-A 有别的 session 比 dir-B 晚，
    // dir-A 仍获胜
    const a1 = s({
      workingDir: '/foo/proj',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-15T00:00:00.000Z',
    });
    const a2 = s({
      workingDir: '/foo/proj',
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });
    const b = s({
      workingDir: '/bar/proj',
      createdAt: '2026-04-05T00:00:00.000Z',
      updatedAt: '2026-04-19T00:00:00.000Z',
    });
    const r = groupSessions([a1, a2, b]);
    const fooNode = r.projects.find((p) => p.workingDir === '/foo/proj');
    const barNode = r.projects.find((p) => p.workingDir === '/bar/proj');
    expect(fooNode?.displayName).toBe('proj');
    expect(barNode?.displayName).toBe('bar/proj');
  });

  it('same-basename: createdAt tie falls back to dir lexicographic order', () => {
    // 两个 dir createdAt 完全相同 → 字典序 /a/proj < /z/proj，/a/proj 获胜
    const a = s({
      workingDir: '/z/proj',
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
    });
    const b = s({
      workingDir: '/a/proj',
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
    });
    const r = groupSessions([a, b]);
    const aNode = r.projects.find((p) => p.workingDir === '/a/proj');
    const zNode = r.projects.find((p) => p.workingDir === '/z/proj');
    expect(aNode?.displayName).toBe('proj'); // 字典序更小 → 获胜
    expect(zNode?.displayName).toBe('z/proj');
  });

  it('keeps pinned out of project groups even if workingDir present', () => {
    const a = s({ workingDir: '/p/foo', pinnedAt: '2026-04-20T00:00:00.000Z' });
    const b = s({ workingDir: '/p/foo', updatedAt: '2026-04-19T00:00:00.000Z' });
    const r = groupSessions([a, b]);
    expect(r.pinned).toHaveLength(1);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].sessions).toHaveLength(1);
    expect(r.projects[0].sessions[0]).toBe(b);
  });

  it('handles all-pinned input', () => {
    const a = s({ pinnedAt: '2026-04-20T00:00:00.000Z' });
    const b = s({ pinnedAt: '2026-04-19T00:00:00.000Z' });
    const r = groupSessions([a, b]);
    expect(r.pinned).toHaveLength(2);
    expect(r.dialogues).toEqual([]);
    expect(r.unclassified).toEqual([]);
    expect(r.projects).toEqual([]);
  });

  it('keeps dialogue sessions out of project groups even when workingDir is set', () => {
    const dialogue = s({
      title: 'imported dialogue',
      workingDir: '/Users/me/Documents/Codex/2026-05-12/new-chat',
      workspaceKind: 'dialogue',
      _count: { messages: 3 },
    });
    const project = s({
      title: 'real project',
      workingDir: '/Users/me/work/app',
      _count: { messages: 2 },
    });

    const r = groupSessions([dialogue, project]);

    expect(r.dialogues).toEqual([dialogue]);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].sessions).toEqual([project]);
  });

  it('treats a project session moved to dialogue as dialogue while preserving workingDir', () => {
    const moved = s({
      title: 'moved session',
      workingDir: '/Users/me/work/app',
      workspaceKind: 'dialogue',
      _count: { messages: 4 },
    });

    const r = groupSessions([moved]);

    expect(r.dialogues).toEqual([moved]);
    expect(r.dialogues[0].workingDir).toBe('/Users/me/work/app');
    expect(r.unclassified).toEqual([]);
    expect(r.projects).toEqual([]);
  });

  it('puts local no-folder dialogue sessions into the dialogue section', () => {
    const dialogue = s({
      title: 'local dialogue',
      workingDir: null,
      workspaceKind: 'dialogue',
      userSendAt: '2026-04-20T00:00:00.000Z',
      _count: { messages: 1 },
    });

    const r = groupSessions([dialogue]);

    expect(r.dialogues).toEqual([dialogue]);
    expect(r.unclassified).toEqual([]);
    expect(r.projects).toEqual([]);
  });

  // 草稿判定：userSendAt == null（未真正发过消息）即便选了 folder 也留在未分类
  it('keeps null-userSendAt draft in unclassified even when workingDir is set', () => {
    const draft = s({ workingDir: '/p/foo', userSendAt: null });
    const real = s({ workingDir: '/p/foo' }); // 默认 userSendAt = updatedAt
    const r = groupSessions([draft, real]);
    expect(r.unclassified).toHaveLength(1);
    expect(r.unclassified[0]).toBe(draft);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].sessions).toHaveLength(1);
    expect(r.projects[0].sessions[0]).toBe(real);
  });

  // SDK echo 失败 / 老数据 backfill 漏掉的孤儿：userSendAt 没写上但 messages
  // 表里有 row 的 session 不是草稿，应入 Project，避免堆到未分类。
  it('treats null-userSendAt with messages>0 as non-draft (SDK echo failure fallback)', () => {
    const orphan = s({
      workingDir: '/p/foo',
      userSendAt: null,
      _count: { messages: 3 },
    });
    const r = groupSessions([orphan]);
    expect(r.unclassified).toHaveLength(0);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].sessions[0]).toBe(orphan);
  });

  // scheduler / plugin 来源豁免草稿判定:零消息也落项目分组。scheduler 由
  // 自动化任务显式绑定目录;plugin 是 workspace 槽建的空会话入口——零消息
  // 落在项目分组正是功能本身,掉未分类则功能不成立。
  it('keeps zero-message scheduler/plugin sessions in their project group (draft exemption)', () => {
    const scheduler = s({ workingDir: '/p/auto', userSendAt: null, source: 'scheduler' });
    const plugin = s({ workingDir: '/p/auto', userSendAt: null, source: 'plugin' });
    const r = groupSessions([scheduler, plugin]);
    expect(r.unclassified).toHaveLength(0);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].sessions).toHaveLength(2);
  });

  it('allows manually imported external sessions to create standalone projects', () => {
    const importedCodex = s({
      id: 'codex-019dcd5a-6e54-7960-95e0-aa68117a28d1',
      agentKind: 'codex',
      workingDir: '/p/external-only',
      _count: { messages: 3 },
    });
    const importedClaude = s({
      id: 'claude-15356275-b340-401f-abd1-3bc2bd4824c5',
      agentKind: 'cc',
      workingDir: '/p/claude-only',
      _count: { messages: 2 },
    });

    const r = groupSessions([importedCodex, importedClaude]);

    expect(r.unclassified).toEqual([]);
    expect(r.projects.map((p) => p.workingDir).sort()).toEqual([
      '/p/claude-only',
      '/p/external-only',
    ]);
  });

  it('attaches imported external sessions to an existing native project dir', () => {
    const native = s({
      id: 'native-session',
      workingDir: '/p/xdt-maker',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });
    const imported = s({
      id: 'codex-019dcd5a-6e54-7960-95e0-aa68117a28d1',
      agentKind: 'codex',
      workingDir: '/p/xdt-maker',
      updatedAt: '2026-04-19T00:00:00.000Z',
      _count: { messages: 5 },
    });

    const r = groupSessions([native, imported]);

    expect(r.unclassified).toEqual([]);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].sessions).toEqual([native, imported]);
  });

  it('groups imported Codex worktree sessions under the base project without changing the session cwd', () => {
    const native = s({
      id: 'native-session',
      workingDir: 'D:\\AI\\tl_web_agent',
      updatedAt: '2026-05-26T02:00:00.000Z',
    });
    const imported = s({
      id: 'codex-019e622b-a420-78e3-8e43-a9fcf9bf2ca8',
      agentKind: 'codex',
      workingDir: '\\\\?\\D:\\AI\\tl_web_agent\\.worktrees\\cx-20260526-104440',
      updatedAt: '2026-05-26T03:00:00.000Z',
      _count: { messages: 5 },
    });

    const r = groupSessions([native, imported]);

    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].workingDir).toBe('D:/AI/tl_web_agent');
    expect(r.projects[0].displayName).toBe('tl_web_agent');
    expect(r.projects[0].sessions).toEqual([imported, native]);
    expect(r.projects[0].sessions[0].workingDir).toBe(
      '\\\\?\\D:\\AI\\tl_web_agent\\.worktrees\\cx-20260526-104440',
    );
  });

  // 兜底回落：userSendAt 缺失（老数据）时回落到 updatedAt
  it('falls back to updatedAt when userSendAt is null but workingDir present', () => {
    // 老数据场景：workingDir 有，userSendAt 没有，但实际有消息历史 —— 通过
    // _count 表达"非草稿"在新模型里没用了，改成显式 userSendAt: null 等价于草稿。
    // 这里测的是排序回落：两个 session 都有 userSendAt，但比较时混合 fallback。
    const a = s({
      workingDir: '/p/alpha',
      userSendAt: null,
      updatedAt: '2026-04-19T00:00:00.000Z',
    });
    // a 是 userSendAt == null → 进未分类
    const b = s({
      workingDir: '/p/beta',
      userSendAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    });
    // b 进 Project，sortTime = userSendAt = 4/18
    const r = groupSessions([a, b]);
    expect(r.unclassified).toHaveLength(1);
    expect(r.unclassified[0]).toBe(a);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].displayName).toBe('beta');
  });

  // 2026-04-21 Lizi: filter='all' 时 active 排在 archived 之上，同状态按时间 desc
  describe('status-then-time ordering (filter=all)', () => {
    it('within a project: active sessions sit above archived; each group time-sorted', () => {
      // active 较旧 / 较新 + archived 较旧 / 较新 混在同一 project
      const archivedNew = s({
        title: 'arch-new',
        workingDir: '/p/proj',
        status: 'archived',
        updatedAt: '2026-04-21T00:00:00.000Z',
      });
      const activeOld = s({
        title: 'act-old',
        workingDir: '/p/proj',
        status: 'active',
        updatedAt: '2026-04-15T00:00:00.000Z',
      });
      const archivedOld = s({
        title: 'arch-old',
        workingDir: '/p/proj',
        status: 'archived',
        updatedAt: '2026-04-10T00:00:00.000Z',
      });
      const activeNew = s({
        title: 'act-new',
        workingDir: '/p/proj',
        status: 'active',
        updatedAt: '2026-04-20T00:00:00.000Z',
      });
      const r = groupSessions([archivedNew, activeOld, archivedOld, activeNew]);
      expect(r.projects).toHaveLength(1);
      // 期望：先 active（按时间 desc），再 archived（按时间 desc）
      expect(r.projects[0].sessions.map((x) => x.title)).toEqual([
        'act-new',
        'act-old',
        'arch-new',
        'arch-old',
      ]);
    });

    it('unclassified: active above archived', () => {
      const a1 = s({
        title: 'arch',
        workingDir: null,
        status: 'archived',
        updatedAt: '2026-04-21T00:00:00.000Z',
      });
      const a2 = s({
        title: 'active',
        workingDir: null,
        status: 'active',
        updatedAt: '2026-04-15T00:00:00.000Z',
      });
      const r = groupSessions([a1, a2]);
      expect(r.unclassified.map((x) => x.title)).toEqual(['active', 'arch']);
    });

    it('pinned: active above archived (same status keeps pinnedAt desc)', () => {
      const a = s({
        title: 'arch-pin',
        status: 'archived',
        pinnedAt: '2026-04-21T00:00:00.000Z',
      });
      const b = s({
        title: 'act-pin-old',
        status: 'active',
        pinnedAt: '2026-04-10T00:00:00.000Z',
      });
      const c = s({
        title: 'act-pin-new',
        status: 'active',
        pinnedAt: '2026-04-15T00:00:00.000Z',
      });
      const r = groupSessions([a, b, c]);
      expect(r.pinned.map((x) => x.title)).toEqual(['act-pin-new', 'act-pin-old', 'arch-pin']);
    });

    it('Mac 路径与父级不同的 Windows 路径分别归为独立 project', () => {
      // 模拟导入场景：同一 basename `proj` 在 Mac `/Users/foo/proj` 与 Windows
      // `C:\Work\proj` 上分别有 session（不同机器的导入），分组时应该：
      //   1. 反斜杠归一为正斜杠后，两条 workingDir 不相等 → 两个独立 project
      //   2. 同名消歧：先创建的（Mac，createdAt=4/1）保留纯 basename `proj`，
      //      Windows 那条 2 段消歧得到 `Work/proj`。
      const mac = s({
        workingDir: '/Users/foo/proj',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-19T00:00:00.000Z',
      });
      const win = s({
        workingDir: 'C:\\Work\\proj',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z',
      });
      const r = groupSessions([mac, win]);
      expect(r.projects).toHaveLength(2);
      const macNode = r.projects.find((p) => p.workingDir === '/Users/foo/proj');
      const winNode = r.projects.find((p) => p.workingDir === 'C:/Work/proj');
      expect(macNode?.displayName).toBe('proj');
      expect(macNode?.segments).toBe(1);
      expect(winNode?.displayName).toBe('Work/proj');
      expect(winNode?.segments).toBe(2);
    });

    it('Mac 路径与同尾 Windows 路径 (`/Users/foo/proj` vs `C:\\Users\\foo\\proj`) 追溯到 drive 段消歧', () => {
      // 边界场景：两条路径除盘符 `C:` 段外完全相同，algorithms 的 split('/').filter(Boolean)
      // 会把 `C:` 当作普通段保留，于是：
      //   tail2: 双方都是 `foo/proj` → 冲突
      //   tail3: 双方都是 `Users/foo/proj` → 仍冲突
      //   tail4: Win 变成 `C:/Users/foo/proj`，消歧成功
      // Mac 是先创建者（winner），强制保留 basename `proj`；Win 继续向上追溯到 drive 段。
      const mac = s({
        workingDir: '/Users/foo/proj',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-19T00:00:00.000Z',
      });
      const win = s({
        workingDir: 'C:\\Users\\foo\\proj',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z',
      });
      const r = groupSessions([mac, win]);
      expect(r.projects).toHaveLength(2);
      const macNode = r.projects.find((p) => p.workingDir === '/Users/foo/proj');
      const winNode = r.projects.find((p) => p.workingDir === 'C:/Users/foo/proj');
      expect(macNode?.displayName).toBe('proj');
      expect(macNode?.segments).toBe(1);
      expect(winNode?.displayName).toBe('C:/Users/foo/proj');
      expect(winNode?.segments).toBe(4);
    });

    it('多条全 Windows 路径 session 在同一 drive 下正常分组', () => {
      // 全 Windows 路径场景：两条 session 同盘符同 basename 不同父目录 →
      // 既要分到不同 project，又要按 createdAt 的同名消歧规则生成 displayName。
      const a = s({
        workingDir: 'C:\\Users\\foo\\proj',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z',
      });
      const b = s({
        workingDir: 'C:\\workspace\\proj\\',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-19T00:00:00.000Z',
      });
      const r = groupSessions([a, b]);
      expect(r.projects).toHaveLength(2);
      const aNode = r.projects.find((p) => p.workingDir === 'C:/Users/foo/proj');
      const bNode = r.projects.find((p) => p.workingDir === 'C:/workspace/proj');
      expect(aNode?.displayName).toBe('proj'); // 先创建者保留 basename
      expect(bNode?.displayName).toBe('workspace/proj');
    });

    it('project-level latestUpdatedAt 仍取真实最新（不被 active-first 污染）', () => {
      // Project A: active 较旧 + archived 较新 → latestUpdatedAt 应是 archived 的时间
      // Project B: active 较新                → latestUpdatedAt = active 的时间
      // 两 project 间排序仍按 latestUpdatedAt desc → A(4/21) > B(4/19)
      const aActive = s({
        workingDir: '/p/alpha',
        status: 'active',
        updatedAt: '2026-04-10T00:00:00.000Z',
      });
      const aArchived = s({
        workingDir: '/p/alpha',
        status: 'archived',
        updatedAt: '2026-04-21T00:00:00.000Z',
      });
      const bActive = s({
        workingDir: '/p/beta',
        status: 'active',
        updatedAt: '2026-04-19T00:00:00.000Z',
      });
      const r = groupSessions([aActive, aArchived, bActive]);
      expect(r.projects.map((p) => p.displayName)).toEqual(['alpha', 'beta']);
    });
  });
});

/* ============================== device-link 远程项目 ============================== */

describe('device-link remote projects', () => {
  it('deviceLinkProjectKey uses an isolated device: prefix and normalizes workingDir', () => {
    expect(deviceLinkProjectKey('dev-B', '/Users/bob/proj/')).toBe('device:dev-B:/Users/bob/proj');
    expect(deviceLinkProjectKey('dev-B', 'C:\\work\\app')).toBe('device:dev-B:C:/work/app');
    // deviceId 含特殊字符要被 encodeURIComponent 编码
    expect(deviceLinkProjectKey('a:b/c', '/p')).toBe('device:a%3Ab%2Fc:/p');
  });

  it('groups device-link sessions as remote scope with device: key, carrying device identity', () => {
    const sess = s({
      workingDir: '/Users/bob/proj',
      deviceLinkDeviceId: 'dev-B',
      deviceLinkDeviceName: 'Bob 的 Mac',
    });
    const r = groupSessions([sess]);
    expect(r.projects).toHaveLength(1);
    const p = r.projects[0];
    expect(p.projectKey).toBe('device:dev-B:/Users/bob/proj');
    expect(p.scope).toBe('remote');
    expect(p.deviceLinkDeviceId).toBe('dev-B');
    expect(p.deviceLinkDeviceName).toBe('Bob 的 Mac');
    expect(p.deviceLinkConnectionStatus).toBe('connected');
    expect(p.remoteHostId).toBeNull();
    expect(p.displayName).toBe('proj');
  });

  it('carries disconnected device-link status into the project node', () => {
    const sess = s({
      workingDir: '/Users/bob/proj',
      deviceLinkDeviceId: 'dev-B',
      deviceLinkDeviceName: 'Bob 的 Mac',
      deviceLinkConnectionStatus: 'disconnected',
    });
    const p = groupSessions([sess]).projects[0];
    expect(p.deviceLinkConnectionStatus).toBe('disconnected');
  });

  it('does NOT collapse same workingDir across local / SSH / device-link into one project', () => {
    const local = s({ workingDir: '/p/app' });
    const ssh = s({ workingDir: '/p/app', remoteHostId: 'my-ssh-host' });
    const devB = s({
      workingDir: '/p/app',
      deviceLinkDeviceId: 'dev-B',
      deviceLinkDeviceName: 'B',
    });
    const devC = s({
      workingDir: '/p/app',
      deviceLinkDeviceId: 'dev-C',
      deviceLinkDeviceName: 'C',
    });
    const r = groupSessions([local, ssh, devB, devC]);
    const keys = r.projects.map((p) => p.projectKey).sort();
    expect(keys).toEqual(
      [
        'local:/p/app',
        projectIdentityKey('remote', '/p/app', 'my-ssh-host'),
        'device:dev-B:/p/app',
        'device:dev-C:/p/app',
      ].sort(),
    );
    // device-link 项目带设备身份、不带 SSH host;SSH 项目反之
    const devProj = r.projects.find((p) => p.projectKey === 'device:dev-B:/p/app');
    if (!devProj) throw new Error('expected device-link project');
    expect(devProj.deviceLinkDeviceId).toBe('dev-B');
    expect(devProj.remoteHostId).toBeNull();
    const sshProj = r.projects.find((p) => p.remoteHostId === 'my-ssh-host');
    if (!sshProj) throw new Error('expected SSH project');
    expect(sshProj.deviceLinkDeviceId).toBeNull();
  });

  it('two device-link sessions on the same device+workdir group together', () => {
    const a = s({ workingDir: '/p/app', deviceLinkDeviceId: 'dev-B', deviceLinkDeviceName: 'B' });
    const b = s({ workingDir: '/p/app', deviceLinkDeviceId: 'dev-B', deviceLinkDeviceName: 'B' });
    const r = groupSessions([a, b]);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].sessions).toHaveLength(2);
  });

  it('normalizeProjectKey round-trips a device: key', () => {
    expect(normalizeProjectKey('device:dev-B:/Users/bob/proj/')).toBe(
      'device:dev-B:/Users/bob/proj',
    );
    expect(normalizeProjectKey('device:a%3Ab:/p')).toBe('device:a%3Ab:/p');
    expect(normalizeProjectKey('device:dev-B')).toBeNull(); // 缺 workingDir 段
  });
});

describe('pinnedSessionIdsInDisplayOrder（拖拽 baseline:与置顶段同序 status→pinnedAt desc，含归档）', () => {
  it('取全部置顶(含归档,active 在前),按 status→pinnedAt desc 排,排除未置顶', () => {
    const sessions = [
      s({ id: 'p-old', pinnedAt: '2026-01-01T00:00:00.000Z' }),
      s({ id: 'unpinned', pinnedAt: null }),
      s({ id: 'p-new', pinnedAt: '2026-03-01T00:00:00.000Z' }),
      s({ id: 'p-archived', pinnedAt: '2026-02-01T00:00:00.000Z', status: 'archived' }),
      s({ id: 'p-mid', pinnedAt: '2026-02-15T00:00:00.000Z' }),
    ];
    // active 段按 pinnedAt desc: p-new, p-mid, p-old;归档置顶排在所有 active 之后。
    expect(pinnedSessionIdsInDisplayOrder(sessions)).toEqual(['p-new', 'p-mid', 'p-old', 'p-archived']);
  });

  it('本地 + 远程置顶合并后统一按 pinnedAt desc 排(不分本地 / 远程)', () => {
    const sessions = [
      s({ id: 'local-old', pinnedAt: '2026-01-01T00:00:00.000Z' }),
      s({ id: 'remote-new', pinnedAt: '2026-05-01T00:00:00.000Z', deviceLinkDeviceId: 'dev-a' }),
    ];
    expect(pinnedSessionIdsInDisplayOrder(sessions)).toEqual(['remote-new', 'local-old']);
  });

  it('无置顶 → 空数组', () => {
    expect(pinnedSessionIdsInDisplayOrder([s({ pinnedAt: null })])).toEqual([]);
  });
});
