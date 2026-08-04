/**
 * custom-mcp-provider —— 把一条用户自定义 MCP 配置(custom-mcp-store 的 CustomMcpConfig)
 * 适配成 maker-core 的 `McpProvider`,让同一份配置同时被 Claude Code 与 Codex 调用。
 *
 * 支持远程 transport(http/sse) 与本机 stdio:
 *   - Claude:`toClaudeSdkConfig` 返回原生 { type:'http'|'sse', url, headers }
 *     (本地 cc 直用;纯 JSON 也能存活 remote cc 的可序列化过滤)。
 *   - Codex:`toCodexMcpConfig` 返回 { type:'http', url, bearerTokenEnvVar? }
 *     (codex 远程 MCP 统一走 http 分支;sse 也交给它)。
 *
 * 鉴权:可选 bearer token 存 safeStorage(mcp_token_<id>),由注入的 tokenReader 读取。
 *   - Claude:合成 Authorization: Bearer <token> 进 headers。
 *   - Codex:token 不能进 process args,通过 getExtraEnv 注入 env var(CUSTOM_MCP_<id>_TOKEN),
 *     toCodexMcpConfig.bearerTokenEnvVar 指向它;缺 env 时 codexEnvironment 会跳过该 server。
 *   - 自定义 header:Codex 侧同样走 env——每个 header 值注入一个 CUSTOM_MCP_<id>_HDR_<name>
 *     env var,toCodexMcpConfig.envHttpHeaders 把 header 名映射到该 env var 名,
 *     codexEnvironment 序列化成 mcp_servers.<name>.env_http_headers.<header>="<envVar>"。
 *     用 env_http_headers 而非静态 http_headers,是为了让密钥类 header(如 API key)
 *     不暴露在 codex 子进程的 process args 里(与 bearer token 同款保护)。
 */

import type {
  CodexHttpMcpServerConfig,
  CodexStdioMcpServerConfig,
  McpProvider,
  McpProviderContext,
} from '@cindy/maker-core';

import type { CustomMcpConfig } from '../maker-host/custom-mcp-store.js';

/**
 * 把 MCP id 规整成合法且**对不同 id 单射**的 env var 名。
 *
 * id ∈ /^[a-z0-9_-]+$/;env var 名只允许 [A-Z0-9_]。若简单地把 `-`/`_` 都转成 `_`,
 * 则 `foo-bar` 与 `foo_bar` 会撞同一个 var —— codexEnvironment 把所有 getExtraEnv
 * 合并成一个 env 对象后,两个 server 会共用同一 token,发生串号。
 *
 * 用 `_` 作转义引导符:`_` → `_5F`、`-` → `_2D`(ASCII hex),字母数字直接大写。
 * 输出里不存在**裸** `_`(全部来自转义两字符序列),故编码可逆、单射。
 */
function tokenEnvVar(id: string): string {
  const encoded = id.replace(/[_-]/g, (c) => (c === '_' ? '_5F' : '_2D')).toUpperCase();
  return `CUSTOM_MCP_${encoded}_TOKEN`;
}

/**
 * 把任意字符串单射编码进 env var 允许的字符集 [A-Z0-9_]。
 *
 * 规则:字母数字直接大写,其它字符转义成 `_<HEX>`(大写十六进制,ASCII 恰为两位;
 * `padStart(2,'0')` 仅保证最短两位,code point > 255 会更长,但 HTTP header 名受
 * RFC 7230 限制为可打印 ASCII token,实践中不会出现)。
 * 由于裸 `_` 本身也会被转义成 `_5F`,输出里的 `_` 只可能是转义引导符,
 * 因此可逆、单射(HTTP header 名大小写不敏感,大写归一不引入语义歧义)。
 * 供 header env var 名生成用;id 段(受 /^[a-z0-9_-]+$/ 约束)在此编码下与
 * tokenEnvVar 的 `_5F`/`_2D` 方案结果一致。
 */
function encodeEnvSegment(raw: string): string {
  let out = '';
  for (const ch of raw) {
    out += /[A-Za-z0-9]/.test(ch)
      ? ch.toUpperCase()
      : `_${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** 单条自定义 header 的注入 env var 名:CUSTOM_MCP_<id>_HDR_<header>(对 (id, header) 单射)。 */
function headerEnvVar(id: string, headerName: string): string {
  return `CUSTOM_MCP_${encodeEnvSegment(id)}_HDR_${encodeEnvSegment(headerName)}`;
}

/** 是否为 Authorization header(大小写不敏感)——用于避免与 bearer token 双写。 */
function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
}

/**
 * 单条自定义 MCP → McpProvider。tokenReader 同步返回该 MCP 的 bearer token(无则 null)。
 */
export class CustomMcpProvider implements McpProvider {
  readonly name: string;
  private readonly config: CustomMcpConfig;
  private readonly tokenReader: (id: string) => string | null;
  private readonly stdioEnv: Record<string, string>;

  constructor(
    config: CustomMcpConfig,
    tokenReader: (id: string) => string | null,
    envReader: (id: string) => Record<string, string> = () => ({}),
  ) {
    this.config = config;
    this.name = config.id;
    this.tokenReader = tokenReader;
    // Snapshot with the config during registry refresh. An in-flight older provider must not see
    // a newly staged secret before the matching database config has committed.
    this.stdioEnv = config.transport === 'stdio' ? { ...envReader(config.id) } : {};
  }

  /** 合成 Claude 端使用的 headers(用户 headers + 可选 Bearer)。 */
  private buildHeaders(): Record<string, string> | undefined {
    if (this.config.transport === 'stdio') return undefined;
    const headers: Record<string, string> = { ...this.config.headers };
    const token = this.tokenReader(this.config.id);
    if (token && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${token}`;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  toClaudeSdkConfig(context: McpProviderContext): unknown {
    if (this.config.transport === 'stdio') {
      // stdio MCPs execute on the local Desktop host. A remote Claude session runs
      // on the SSH host, so never serialize local commands, cwd, or safeStorage
      // secrets into the remote cc-manager start params.
      if (context.remoteHostId) return null;
      const env = this.stdioEnv;
      return {
        type: 'stdio',
        command: this.config.command,
        args: this.config.args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      };
    }
    const headers = this.buildHeaders();
    return {
      type: this.config.transport, // 'http' | 'sse'
      url: this.config.url,
      ...(headers ? { headers } : {}),
    };
  }

  toCodexMcpConfig(
    _context: McpProviderContext,
  ): CodexHttpMcpServerConfig | CodexStdioMcpServerConfig | null {
    if (this.config.transport === 'stdio') {
      const env = this.stdioEnv;
      return {
        type: 'stdio',
        command: this.config.command,
        args: this.config.args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      };
    }
    // Codex 只支持 Streamable HTTP transport；SSE 协议不兼容，跳过（null = 不注入 Codex）。
    // Claude 侧走 toClaudeSdkConfig，支持 sse，不受此限制。
    if (this.config.transport === 'sse') return null;
    const headers = this.config.headers ?? {};
    const token = this.tokenReader(this.config.id);
    // 有用户自定义 Authorization header 时不再叠加 bearer(与 Claude buildHeaders 语义一致)。
    const useBearer = Boolean(token) && !hasAuthorizationHeader(headers);
    // 每个自定义 header → 一个 env var 引用(值走 env,不进 process args)。
    const envHttpHeaders: Record<string, string> = {};
    for (const name of Object.keys(headers)) {
      envHttpHeaders[name] = headerEnvVar(this.config.id, name);
    }
    return {
      type: 'http',
      // Normalize to URL.href: removes embedded quotes/whitespace that would
      // produce malformed TOML when Codex interpolates the URL into -c args.
      // Additionally percent-encode backslashes: URL.href preserves them in
      // query/fragment, but TOML treats backslash as an escape char inside
      // quoted strings, which would corrupt the generated -c override.
      url: new URL(this.config.url).href.replace(/\\/g, '%5C'),
      ...(useBearer ? { bearerTokenEnvVar: tokenEnvVar(this.config.id) } : {}),
      ...(Object.keys(envHttpHeaders).length > 0 ? { envHttpHeaders } : {}),
    };
  }

  getExtraEnv(_context: McpProviderContext): Record<string, string> | null {
    if (this.config.transport === 'stdio') return null;
    // SSE MCPs are not registered in Codex (toCodexMcpConfig returns null), so
    // neither their token nor their custom headers should be injected into the
    // Codex app-server environment.
    if (this.config.transport === 'sse') return null;
    const headers = this.config.headers ?? {};
    const token = this.tokenReader(this.config.id);
    const env: Record<string, string> = {};
    // 与 toCodexMcpConfig 的 useBearer 保持一致:自定义 Authorization 优先。
    if (token && !hasAuthorizationHeader(headers)) {
      env[tokenEnvVar(this.config.id)] = token;
    }
    // 自定义 header 值:envHttpHeaders 引用的 env var 由此提供。
    for (const [name, value] of Object.entries(headers)) {
      env[headerEnvVar(this.config.id, name)] = value;
    }
    return Object.keys(env).length > 0 ? env : null;
  }
}
