import {spawn,type ChildProcess} from 'node:child_process';


export interface ClaudeCliPlanUsage {
  /** `get_usage` 响应的 `rate_limits`(与 claude.ai /usage 同形,由 shared 解析器 fail-safe 解析)。 */
  rateLimits: unknown;
  subscriptionType?: string;
}
export function createClaudeCliPlanUsage(host:{cliBinaryPath():string|null;cliEnv(opts:{network:boolean}):Promise<NodeJS.ProcessEnv>}){const {cliBinaryPath,cliEnv}=host;const optionalString=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():undefined;
const PLAN_USAGE_TIMEOUT_MS = 20_000;
const PLAN_USAGE_REQUEST_ID = 'cindy-plan-usage';

/**
 * 读 Claude 订阅套餐余量:拉起内置 CLI 的 SDK 模式,发 `get_usage` 控制请求(CLI 的
 * /usage 同源,结构化返回),拿到响应即结束进程。请求由 CLI 用自己的登录发出,Cindy
 * 不接触凭证;不发用户消息,不产生模型调用。
 *
 * `get_usage` 是 CLI 标注为 Experimental 的控制请求,响应形状可能变化 —— 这里只取
 * `rate_limits` 原样交给调用方解析。CLI 明确声明当前账号没有套餐余量
 * (`rate_limits_available: false`)时返回 null;启动失败、超时、控制请求报错或响应缺
 * `rate_limits` 时抛错,由调用方退避。
 */
async function readClaudeCliPlanUsage(): Promise<ClaudeCliPlanUsage | null> {
  const binary = cliBinaryPath();
  if (!binary) throw new Error('claude cli unavailable');
  const env = await cliEnv({ network: true });
  // --setting-sources user:不读工作区的项目级设置(它们可改写上游 / 鉴权);
  // --strict-mcp-config:不拉起用户配置的 MCP server;--no-session-persistence:不落会话记录。
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources', 'user',
  ];
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    let buffer = '';
    const finish = (err: Error | null, value?: ClaudeCliPlanUsage | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value ?? null);
    };
    const timer = setTimeout(() => finish(new Error('claude get_usage timed out')), PLAN_USAGE_TIMEOUT_MS);
    child.once('error', (err) => finish(err));
    child.once('close', (code) => finish(new Error(`claude cli exited before get_usage response (code ${code})`)));
    child.stdin?.on('error', () => {
      /* 进程提前退出时写 stdin 会 EPIPE,由 close 分支给结论。 */
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const outcome = parseClaudeCliPlanUsageLine(line);
        if (outcome) finish(outcome.error ? new Error(outcome.error) : null, outcome.usage);
      }
    });
    const write = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    write({ type: 'control_request', request_id: 'cindy-init', request: { subtype: 'initialize' } });
    write({
      type: 'control_request',
      request_id: PLAN_USAGE_REQUEST_ID,
      request: { subtype: 'get_usage', skip_behaviors: true },
    });
  });
}

/**
 * 解析 CLI stream-json 输出的一行。不是 `get_usage` 的 control_response 时返回 null
 * (继续读);是则返回结论:error 为控制请求失败,usage 为 null 表示账号没有套餐余量。
 */
function parseClaudeCliPlanUsageLine(
  line: string,
): { error?: string; usage: ClaudeCliPlanUsage | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const message = parsed as { type?: unknown; response?: unknown };
  if (message.type !== 'control_response' || !message.response || typeof message.response !== 'object') return null;
  const response = message.response as Record<string, unknown>;
  if (response.request_id !== PLAN_USAGE_REQUEST_ID) return null;
  if (response.subtype !== 'success') {
    return { error: `claude get_usage failed: ${optionalString(response.error) ?? 'unknown error'}`, usage: null };
  }
  const body = response.response && typeof response.response === 'object'
    ? (response.response as Record<string, unknown>)
    : {};
  // 只有 CLI 明确声明没有套餐余量才返回 null;缺 rate_limits 按形状变化报错,不当成「没有」。
  if (body.rate_limits_available === false) return { usage: null };
  if (!body.rate_limits || typeof body.rate_limits !== 'object') {
    return { error: 'claude get_usage response has no rate_limits', usage: null };
  }
  const subscriptionType = optionalString(body.subscription_type);
  return { usage: { rateLimits: body.rate_limits, ...(subscriptionType ? { subscriptionType } : {}) } };
}
return {readClaudeCliPlanUsage,parseClaudeCliPlanUsageLine};
}
