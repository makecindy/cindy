/**
 * cindy_slackMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server for Slack tools over the hook channel. Attached to
 * every session once the user's Slack hook binding is confirmed (isEnabled in
 * providers.ts), so "帮我搜下 Slack 上周的讨论" works from any desktop chat.
 *
 * 架构(2026-07 Slack 能力并轨, 接替退役的 cindy-slack 意识):
 *   - 本 server 是纯网关: 三个工具(slack_status / slack_list_tools /
 *     slack_call_tool)全部经 SlackToolBridge -> hook-control manager ->
 *     tool.request 帧 -> slack-hook-server, 由 server 以托管 user token 调
 *     Slack 官方 MCP。工具清单动态来自 Slack 官方, 本地零硬编码。
 *   - 工具面固定 3 个、描述构建期一次确定 —— 会话内字节稳定, 不影响
 *     prompt cache(规则 10)。
 *   - 大结果泄洪: 超过上限或显式 out_file 时写会话工作目录(路径经
 *     resolvePathInsideRoot 钳制), 只交路径 —— 与意识时代同一套语义。
 *   - 错误结构化: bridge 的 {code, message} 1:1 映射为 errorCode + hint,
 *     agent 按 code 分支提示用户(规则 9)。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { jsonObjectArg } from './json-object-arg.js';
import { withAccountDataAccess } from './account-data-access.js';
import { PathBoundaryError, resolvePathInsideRoot } from './shared/assertInsidePath.js';
import type { SlackHookMcpDeps, SlackToolBridgeLike } from './types.js';

import descStatus from './prompts/cindy_slack/tools/slack_status.md?raw';
import descListTools from './prompts/cindy_slack/tools/slack_list_tools.md?raw';
import descCallTool from './prompts/cindy_slack/tools/slack_call_tool.md?raw';

/** 交卷体量护栏: 超过即落盘工作目录只交路径(写盘不可用才回落截断)。 */
const RESULT_MAX_CHARS = 50_000;

/** 工具结果形状(MCP content block; 索引签名对齐 SDK CallToolResult)。 */
interface SlackToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

function jsonResult(payload: unknown, isError = false): SlackToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

/** 错误码 -> 面向 agent 的行动指引(桥/服务端 message 原样附带)。 */
const CODE_HINTS: Record<string, string> = {
  NOT_BOUND: '请让用户到 设置 → Slack 打开开关完成绑定后重试',
  NO_USER_TOKEN: '请让用户到 设置 → Slack 关闭再打开开关, 重新完成一次授权(旧版绑定没有工具权限)',
  TOKEN_EXPIRED: '请让用户到 设置 → Slack 关闭再打开开关, 重新完成一次授权',
  HOOK_NOT_CONNECTED: 'Slack 连接暂时不在线, 稍后重试; 持续失败请让用户检查 设置 → Slack 与网络',
  SERVER_TOO_OLD: '服务端暂不支持 Slack 工具, 请让用户联系管理员升级 slack-hook-server',
  RATE_LIMITED: 'Slack 侧限流, 等待片刻再重试',
  BUSY: '并发请求过多, 排队稍后重试',
  TIMEOUT: '请求超时, 可稍后重试; 大范围搜索可缩小查询范围',
  AMBIGUOUS_TEAM:
    '本设备绑定了多个 Slack workspace, 必须用 team_id 指明以哪个 workspace 身份执行 —— 先调 slack_status 查看 bindings 列表再重试',
};

function errorResult(code: string, message: string): SlackToolResult {
  return jsonResult(
    {
      ok: false,
      errorCode: code,
      message,
      ...(CODE_HINTS[code] !== undefined ? { hint: CODE_HINTS[code] } : {}),
    },
    true,
  );
}

/**
 * 取桥并做调用期 fail-closed 复查: isEnabled 只在会话构建期评估一次, 会话
 * 存续期间用户可能解绑/断线(Codex 共享 bridge 场景同理), 每次调用现查。
 */
function requireBridge(deps: SlackHookMcpDeps): SlackToolBridgeLike | { err: SlackToolResult } {
  const bridge = deps.getBridge();
  if (bridge === null) {
    return { err: errorResult('NOT_BOUND', 'Slack 通道未初始化(hook-control 未就绪)') };
  }
  return bridge;
}

/**
 * 交卷: 超限或显式 out_file 时写进会话工作目录(路径钳制), 只交路径;
 * 写盘失败回落截断预览。data 为网关工具的成功 result。
 */
async function deliver(
  data: unknown,
  outFile: string | undefined,
  workingDir: string | undefined,
  assertCurrent: () => Promise<void>,
): Promise<SlackToolResult> {
  const text = JSON.stringify(data ?? null);
  if (outFile === undefined && text.length <= RESULT_MAX_CHARS) {
    return jsonResult({ ok: true, data });
  }
  let spillNote: string | null = null;
  if (workingDir !== undefined && workingDir.trim().length > 0) {
    try {
      const fileName = outFile ?? `slack-result-${Date.now().toString(36)}.json`;
      const abs = await resolvePathInsideRoot(workingDir, fileName);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      try { await assertCurrent(); }
      catch { return errorResult('CAPABILITY_NOT_AVAILABLE', 'Account data is unavailable for this task.'); }
      await fs.writeFile(abs, text, 'utf-8');
      return jsonResult({
        ok: true,
        saved_to: path.relative(workingDir, abs) || fileName,
        bytes: Buffer.byteLength(text, 'utf-8'),
        hint: '完整结果已写入会话工作目录的该相对路径, 用文件工具读取或交给脚本处理',
      });
    } catch (err) {
      // 只有模型显式指定 out_file 才把越界当错误返回; 自动泄洪撞上不可用的
      // workingDir(会话目录被删 / SSH 远程路径在本机不存在)时按普通落盘
      // 失败降级为截断预览 —— 数据已经拿到了, 不能因落盘失败整体报错。
      if (outFile !== undefined && err instanceof PathBoundaryError) {
        return errorResult('PATH_NOT_ALLOWED', err.message);
      }
      spillNote = `落盘未成功(${err instanceof Error ? err.message : String(err)})`;
    }
  } else {
    spillNote = '当前会话无工作目录, 无法落盘';
  }
  if (text.length <= RESULT_MAX_CHARS) {
    return jsonResult({ ok: true, data, note: spillNote });
  }
  return jsonResult({
    ok: true,
    truncated: true,
    hint: `${spillNote}; 响应过大已截断 —— 缩小查询范围(减小 limit / 收窄条件)或分页读取`,
    preview: text.slice(0, RESULT_MAX_CHARS),
  });
}

export function createSlackMcpGatewayServer(deps: SlackHookMcpDeps): McpServer {
  const server = new McpServer({ name: 'cindy_slack', version: '1.0.0' });

  /** team_id 入参的统一描述(multi-team 语境下 3 个工具共用口径)。 */
  const TEAM_ID_DESC =
    '可选: 以哪个 Slack workspace 的绑定身份执行(bindings 列表见 slack_status)。设备绑定了多个 workspace 时必须传, 否则 server 拒绝猜测(AMBIGUOUS_TEAM); 只绑一个时可省略';

  server.tool('slack_status', descStatus.trim(), {}, async () => withAccountDataAccess(deps.withAccountDataAccess, deps.getSessionContext?.().sessionId, async () => {
    const bridge = requireBridge(deps);
    if ('err' in bridge) return bridge.err;
    const local = bridge.availability();
    // 本地不通时直接给本地视角(server 侧 status 反正问不到); multi-team 的
    // 绑定清单本地就有, 一并带上供 agent 决定 team_id
    if (!local.connected || !local.bound || !local.serverSupportsTools) {
      return jsonResult({
        ok: true,
        connected: local.connected,
        bound: local.bound,
        serverSupportsTools: local.serverSupportsTools,
        ...(local.multiTeam === true ? { multiTeam: true, bindings: local.bindings ?? [] } : {}),
        hint: !local.bound
          ? '未绑定 Slack: 请让用户到 设置 → Slack 打开开关完成绑定'
          : !local.connected
            ? 'Slack 连接不在线'
            : '服务端暂不支持 Slack 工具(版本过旧)',
      });
    }
    // 不带 teamId 的 status: 多绑定时 server 返回 { multiTeam, bindings } 总览
    const r = await bridge.callTool('status');
    if (!r.ok) return errorResult(r.error.code, r.error.message);
    return jsonResult({ ok: true, connected: true, ...(r.result as object) });
  }));

  server.tool(
    'slack_list_tools',
    descListTools.trim(),
    {
      team_id: z.string().optional().describe(TEAM_ID_DESC),
      out_file: z
        .string()
        .optional()
        .describe('可选: 把完整清单 JSON 写进会话工作目录的该相对路径, 只返回文件路径'),
    },
    async ({ team_id, out_file }) => withAccountDataAccess(deps.withAccountDataAccess, deps.getSessionContext?.().sessionId, async assertCurrent => {
      const bridge = requireBridge(deps);
      if ('err' in bridge) return bridge.err;
      const r = await bridge.callTool('listTools', undefined, team_id ?? null);
      await assertCurrent();
      if (!r.ok) return errorResult(r.error.code, r.error.message);
      return deliver(r.result, out_file, deps.workingDir, assertCurrent);
    }),
  );

  server.tool(
    'slack_call_tool',
    descCallTool.trim(),
    {
      name: z.string().min(1).describe('工具名(slack_list_tools 可查)'),
      arguments: jsonObjectArg('工具参数(按该工具的 inputSchema 传 JSON 对象; 无参可省略)').optional(),
      team_id: z.string().optional().describe(TEAM_ID_DESC),
      out_file: z
        .string()
        .optional()
        .describe(
          '可选: 把完整结果 JSON 写进会话工作目录的该相对路径(如 tmp/slack-result.json), 只返回文件路径 —— 结果大、要交给脚本处理时用。结果超 50KB 时即使不传也会自动落盘返回路径',
        ),
    },
    async ({ name, arguments: toolArgs, team_id, out_file }) => withAccountDataAccess(deps.withAccountDataAccess, deps.getSessionContext?.().sessionId, async assertCurrent => {
      const bridge = requireBridge(deps);
      if ('err' in bridge) return bridge.err;
      const r = await bridge.callTool('callTool', { name, ...(toolArgs !== undefined ? { arguments: toolArgs } : {}) }, team_id ?? null);
      // Recheck before returning private bytes or spilling them to the workdir.
      await assertCurrent();
      if (!r.ok) return errorResult(r.error.code, r.error.message);
      return deliver(r.result, out_file, deps.workingDir, assertCurrent);
    }),
  );

  return server;
}
