/**
 * env 组装 —— Codex Codex 实例化用。
 *
 * 与 Claude 对应文件结构对齐，但内容简单：
 * - Codex 当前无 endpoint 覆盖（SDK 不支持），传了 runtimeConfig.endpoint 也忽略
 * - Codex 当前无业务 flag（runtimeConfig.behaviorFlags 一般空）
 * - 真正起作用的只有 auth.getAuthEnv() —— 返回 { CODEX_HOME }
 *
 * 注意：Codex SDK 的 env 不继承 process.env（SDK 0.125.0 文档说明），
 * 所以这里返回 process.env + behaviorFlags + authEnv 合并后的全量字典，
 * 由调用方原样传给 new Codex({ env })。
 */

import path from 'node:path';

import type { AgentCredentialMode, AuthAdapter } from '../../interfaces/auth-adapter.js';
import type { AgentRuntimeConfig } from '../../interfaces/runtime-config.js';
import { applyPlainTextTerminalEnv } from '../shared/terminal-output.js';

function prependPath(env: Record<string, string>, prepends: string[]): void {
  const cleaned = prepends.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) return;

  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
  const key = pathKeys[0] ?? (process.platform === 'win32' ? 'Path' : 'PATH');
  const current = env[key] ?? '';

  for (const k of pathKeys) {
    if (k !== key) delete env[k];
  }

  env[key] = [...cleaned, current].filter(Boolean).join(path.delimiter);
}

export async function buildCodexEnv(
  auth: AuthAdapter,
  runtimeConfig: AgentRuntimeConfig,
  options: { credentialMode?: AgentCredentialMode } = {},
): Promise<Record<string, string>> {
  // Codex 不需要剥 process.env 里的 OAuth token —— 它的鉴权走 CODEX_HOME 文件路径，
  // 不读 process.env 里的 OPENAI_API_KEY（且本项目 D6 决策不补 API key 通道）。
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }

  // 函数形态按 spawn 凭证形态求值(与 claude-code/env-builder 同语义)。
  // spawnMode 恒传 'local':本函数产出的 env 只被**本地** transport 消费——远端
  // spawn 虽也会执行到这里,但产物随后被远端 daemon transport 整体丢弃(见
  // codex/index.ts 远端路径注释),真正落到子进程的只有本地分支。
  const behaviorFlags =
    typeof runtimeConfig.behaviorFlags === 'function'
      ? runtimeConfig.behaviorFlags({ credentialMode: options.credentialMode, spawnMode: 'local' })
      : runtimeConfig.behaviorFlags;
  if (behaviorFlags) {
    Object.assign(env, behaviorFlags);
  }
  // endpoint 字段：Codex SDK 当前无对应 env，跳过
  const authOptions = options.credentialMode
    ? { credentialMode: options.credentialMode }
    : undefined;
  Object.assign(env, await auth.getAuthEnv(authOptions));
  prependPath(env, runtimeConfig.pathPrepends ?? []);

  // Windows 下 Python piped stdout 默认走 locale encoding(cp936/GBK), 不看 chcp 65001。
  // 强制 UTF-8 避免 Bash 工具执行 python 命令时中文乱码。跨平台设置无副作用。
  if (env.PYTHONUTF8 === undefined) env.PYTHONUTF8 = '1';
  if (env.PYTHONIOENCODING === undefined) env.PYTHONIOENCODING = 'utf-8';
  applyPlainTextTerminalEnv(env);

  // 兜底: NO_PROXY 必须包含 127.0.0.1/localhost/::1, 否则 codex 子进程的 rmcp
  // (Rust reqwest) 会把 Cindy MCP HTTP bridge 的 localhost 请求也走 HTTP_PROXY
  // (corp 网络 / PAC 常见现象), 上游代理不识别 localhost, 回 HTML 错误页 →
  // codex 端 MCP transport 全员 UnexpectedContentType 崩, 用户表现为"codex
  // 看不到任何 Cindy MCP / orca worker 工具"。直接合并用户已有 NO_PROXY,
  // 同时把小写 no_proxy 合并进来并删除, 防止大小写双份在 Rust/Go 系生态里
  // 互相覆盖。
  const existingNoProxy = [env.NO_PROXY, env.no_proxy]
    .filter((v): v is string => typeof v === 'string')
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  const localhostEntries = ['127.0.0.1', 'localhost', '::1'];
  env.NO_PROXY = Array.from(new Set([...existingNoProxy, ...localhostEntries])).join(',');
  delete env.no_proxy;

  return env;
}
