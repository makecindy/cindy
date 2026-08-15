import { describe, expect, it } from 'vitest';

import {
  getDesktopClaudeReadOnlyAllowedTools,
  getDesktopMcpToolApprovalPolicy,
  getDesktopMcpToolApprovalPresentation,
} from '../mcp-tool-approval-policy.js';
import { setMainLocale } from '../../i18n.js';

describe('desktop Claude read-only allowlist', () => {
  it('allows only explicitly reviewed read-only tools', () => {
    const tools = getDesktopClaudeReadOnlyAllowedTools();

    expect(tools).toEqual(
      expect.arrayContaining([
        'mcp__cindy__ghost_list',
        'mcp__cindy__ghost_info',
        'mcp__cindy__ghost_manual',
        'mcp__cindy__ghost_forge_guide',
        'mcp__cindy_ios_simulator__list_tools',
        'mcp__cindy_helper__list_tools',
        'mcp__cindy_slack__slack_status',
      ]),
    );
    expect(tools).not.toEqual(
      expect.arrayContaining([
        'Bash',
        'Edit',
        'Write',
        'Agent',
        'Skill',
        // 外发网络请求(搜索词/URL 出境),与 maker-core READ_ONLY_CLAUDE_TOOLS 边界一致,
        // 不免审批(Greptile P1 security)。
        'WebSearch',
        'WebFetch',
        'mcp__cindy__ghost_call',
        'mcp__cindy_helper__call_tool',
        'mcp__cindy_slack__slack_list_tools',
      ]),
    );
    expect(tools.every((tool) => !tool.includes('*'))).toBe(true);
    expect(tools.every((tool) => !tool.endsWith('__call_tool'))).toBe(true);
  });

  // allowedTools 进 SDK options，属于请求前缀的一部分（maker-core-and-agent-behavior.md
  // §3.1 缓存率）。内容或顺序变化都会打断 prompt cache，所以这里锁死精确顺序，而不是
  // 只做 arrayContaining 的包含性检查。
  it('keeps the exact tool list and order stable for prompt-cache prefix', () => {
    expect(getDesktopClaudeReadOnlyAllowedTools()).toEqual([
      'mcp__cindy__ghost_list',
      'mcp__cindy__ghost_info',
      'mcp__cindy__ghost_manual',
      'mcp__cindy__ghost_forge_guide',
      'mcp__cindy_browser__list_tools',
      'mcp__cindy_android__list_tools',
      'mcp__cindy_ios_simulator__list_tools',
      'mcp__cindy_computer__list_tools',
      'mcp__cindy_feishu_bot__list_tools',
      'mcp__cindy_scheduler__list_tools',
      'mcp__cindy_ssh__list_tools',
      'mcp__cindy_helper__list_tools',
      'mcp__cindy_memory__list_tools',
      'mcp__cindy_contacts__list_tools',
      'mcp__cindy_slack__slack_status',
    ]);
  });

  it('returns an isolated copy', () => {
    const first = getDesktopClaudeReadOnlyAllowedTools();
    first.push('Bash');
    expect(getDesktopClaudeReadOnlyAllowedTools()).not.toContain('Bash');
  });

  // allowedTools 只是同一份只读声明在 CLI 层的提前短路(省掉 auto 模式的远程分类器)。
  // 两个出口必须来自同一张表, 否则会出现"静态白名单放行、动态策略却弹窗"的自相矛盾。
  it('stays consistent with the shared approval policy', () => {
    for (const tool of getDesktopClaudeReadOnlyAllowedTools()) {
      const [serverName, ...rest] = tool.slice('mcp__'.length).split('__');
      expect(
        getDesktopMcpToolApprovalPolicy({ serverName, toolName: rest.join('__') }),
        `${tool} should also be auto-approved by the shared policy`,
      ).toBe('auto-approve');
    }
  });
});

describe('desktop MCP approval policy', () => {
  it('keeps known safe contacts calls trusted', () => {
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'cindy_contacts',
        toolParams: { name: 'contacts_search', args: { query: 'Carol' } },
      }),
    ).toBe('auto-approve');
  });

  it('prompts each time for destructive and malformed contacts calls', () => {
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'cindy_contacts',
        toolParams: { name: 'contacts_merge', args: { target_id: 'a', source_id: 'b' } },
      }),
    ).toBe('prompt-each-time');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'cindy_contacts' })).toBe(
      'prompt-each-time',
    );
  });

  it('auto-approves only explicitly reviewed builtin servers', () => {
    for (const serverName of [
      'cindy_android',
      'cindy_browser',
      'cindy_computer',
      'cindy_feishu_bot',
      'cindy_slack',
      'cindy_scheduler',
      'cindy_memory',
      'cindy_helper',
      'cindy_orca',
      // worker → lead 回报通道:执行边界在工具内部 fail-closed, 逐次弹窗
      // 会让远端 daemon 等审批超时断链。
      'orca_worker_bridge',
      'cindy_lsp',
    ]) {
      expect(getDesktopMcpToolApprovalPolicy({ serverName })).toBe('auto-approve');
    }

    // gitlab_lizi 已于 2026-07-14 退役(迁入内置意识 cindy-gitlab):
    // `<平台>_lizi` 显式白名单清空后,该名字回落到默认 prompt,不再自动放行。
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'gitlab_lizi' })).toBe('prompt');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'cindy_ssh' })).toBe('prompt');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'cindy_future_tool' })).toBe('prompt');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'third_party' })).toBe('prompt');
  });

  it('prompts for simulator setup actions while device-gated actions stay trusted', () => {
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'cindy_ios_simulator',
        toolName: 'list_tools',
      }),
    ).toBe('auto-approve');
    // Taking control of a device is itself the authorization step.
    for (const name of ['attach_device', 'create_instance']) {
      expect(
        getDesktopMcpToolApprovalPolicy({
          serverName: 'cindy_ios_simulator',
          toolName: 'call_tool',
          toolParams: { name, args: {} },
        }),
      ).toBe('prompt-each-time');
    }
    const route = { instanceId: 'instance-a', generation: 2, leaseId: 'lease-a' };
    for (const name of ['build_app', 'open_simulator_url']) {
      expect(
        getDesktopMcpToolApprovalPolicy({
          serverName: 'cindy_ios_simulator',
          toolName: 'call_tool',
          toolParams: { name, args: { ...route } },
        }),
      ).toBe('prompt-each-time');
      // No owned route means the Host rejects it on route validation, so asking
      // the user to authorize a device this task never attached is pure noise —
      // the shape a mis-routed "open a web URL" call takes.
      expect(
        getDesktopMcpToolApprovalPolicy({
          serverName: 'cindy_ios_simulator',
          toolName: 'call_tool',
          toolParams: { name, args: { url: 'https://example.com' } },
        }),
      ).toBe('auto-approve');
    }
    // A superseded name must not become a way around the same gate.
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'cindy_ios_simulator',
        toolName: 'call_tool',
        toolParams: { name: 'open_url', args: { ...route, url: 'https://example.com' } },
      }),
    ).toBe('prompt-each-time');
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'cindy_ios_simulator',
        toolParams: { name: 'build_app', args: { ...route } },
      }),
    ).toBe('prompt-each-time');
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'cindy_ios_simulator',
        toolName: 'call_tool',
        toolParams: { name: 'tap', args: {} },
      }),
    ).toBe('auto-approve');
  });

  it('judges a stringified simulator payload the way the Host will receive it', () => {
    const route = { instanceId: 'instance-a', generation: 2, leaseId: 'lease-a' };
    // Claude Code's in-process bridge stringifies nested payloads (issue #350) and
    // jsonObjectArg parses them back before dispatch, so a policy that judged the
    // raw string would let a routed device action run unapproved.
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'cindy_ios_simulator',
        toolName: 'call_tool',
        toolParams: { name: 'build_app', args: JSON.stringify(route) },
      }),
    ).toBe('prompt-each-time');
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'cindy_ios_simulator',
        toolName: 'call_tool',
        toolParams: JSON.stringify({ name: 'build_app', args: route }),
      }),
    ).toBe('prompt-each-time');
    // The noise case still resolves through the same representation.
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'cindy_ios_simulator',
        toolName: 'call_tool',
        toolParams: {
          name: 'open_simulator_url',
          args: JSON.stringify({ url: 'https://example.com' }),
        },
      }),
    ).toBe('auto-approve');
    // Anything whose arguments cannot be read fails closed and keeps asking.
    for (const args of [undefined, 'not json', 42, [route]]) {
      expect(
        getDesktopMcpToolApprovalPolicy({
          serverName: 'cindy_ios_simulator',
          toolName: 'call_tool',
          toolParams: { name: 'open_simulator_url', args },
        }),
      ).toBe('prompt-each-time');
    }
  });

  it('discloses host file access before an agent starts an Xcode build', () => {
    setMainLocale('en');
    expect(
      getDesktopMcpToolApprovalPresentation({
        serverName: 'cindy_ios_simulator',
        toolName: 'call_tool',
        toolParams: { name: 'build_app', args: {} },
      }),
    ).toEqual({
      title: 'Allow Xcode to build this project?',
      description: expect.stringMatching(
        /macOS user.*outside the project.*returned to the Agent.*trust this project/i,
      ),
    });
    expect(
      getDesktopMcpToolApprovalPresentation({
        serverName: 'cindy_ios_simulator',
        toolName: 'call_tool',
        toolParams: { name: 'tap', args: {} },
      }),
    ).toBeUndefined();
    expect(
      getDesktopMcpToolApprovalPresentation({
        serverName: 'cindy_ios_simulator',
        toolParams: { name: 'build_app', args: {} },
      })?.description,
    ).toContain('outside the project');
  });

  it('discloses the task-scoped control lease before an agent creates or attaches a simulator', () => {
    setMainLocale('en');
    for (const [name, title] of [
      ['attach_device', /connect to and control this simulator/i],
      ['create_instance', /create and control a simulator/i],
    ] as const) {
      const presentation = getDesktopMcpToolApprovalPresentation({
        serverName: 'cindy_ios_simulator',
        toolName: 'call_tool',
        toolParams: { name, args: {} },
      });
      expect(presentation?.title).toMatch(title);
      expect(presentation?.description).toMatch(
        /current Cindy task.*start or stop.*install or launch.*tap.*swipe.*type.*screenshots.*settings.*without another device-control prompt.*disconnect.*revoke Agent control.*sensitive actions.*separate approval/i,
      );
    }

    // Codex app-server versions that omit the outer progressive tool name
    // must receive the same Host-owned disclosure from the validated payload.
    expect(
      getDesktopMcpToolApprovalPresentation({
        serverName: 'cindy_ios_simulator',
        toolParams: { name: 'attach_device', args: {} },
      })?.description,
    ).toContain('without another device-control prompt');
    expect(
      getDesktopMcpToolApprovalPresentation({
        serverName: 'cindy_ios_simulator',
        toolName: 'call_tool',
        toolParams: { name: 'open_url', args: {} },
      }),
    ).toBeUndefined();
  });

  it('auto-approves read-only discovery entries even on untrusted servers', () => {
    // server 整体不可信, 但列工具清单 / 查连接状态没有副作用。
    expect(
      getDesktopMcpToolApprovalPolicy({ serverName: 'cindy_ssh', toolName: 'list_tools' }),
    ).toBe('auto-approve');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'cindy', toolName: 'ghost_list' })).toBe(
      'auto-approve',
    );
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'cindy', toolName: 'ghost_info' })).toBe(
      'auto-approve',
    );
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'cindy', toolName: 'ghost_manual' })).toBe(
      'auto-approve',
    );

    // 同一个 server 的执行入口不跟着沾光。
    expect(
      getDesktopMcpToolApprovalPolicy({ serverName: 'cindy_ssh', toolName: 'call_tool' }),
    ).toBe('prompt');
    expect(getDesktopMcpToolApprovalPolicy({ serverName: 'cindy', toolName: 'ghost_call' })).toBe(
      'prompt',
    );
  });

  it('auto-approves the browser call_tool entry that Claude used to prompt for every time', () => {
    // 回归锚点: cindy_browser 的真实动作全部走 call_tool。Claude 侧过去只静态放行
    // list_tools, 于是每次 navigate / snapshot / click 都弹一次窗。
    expect(
      getDesktopMcpToolApprovalPolicy({
        serverName: 'cindy_browser',
        toolName: 'call_tool',
        toolParams: { name: 'browser', args: { action: 'navigate', url: 'https://example.com' } },
      }),
    ).toBe('auto-approve');
  });
});
