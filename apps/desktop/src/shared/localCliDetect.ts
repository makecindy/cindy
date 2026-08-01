/**
 * localCliDetect —— 本机 agent CLI 安装 / 登录态检测的共享类型与映射表。
 *
 * 用途:设置 → 模型供应商的「检测建议」——本机装了 Claude Code / Codex CLI 的用户,
 * 大概率已有对应订阅,左栏建议行 + 添加向导置顶提示引导其直接授权接入,而不是让
 * 用户自己在目录里找渠道。
 *
 * 映射表设计为数据驱动(cliId → 建议 providerId),后续扩国产 CLI(qwen / iflow /
 * gemini / kimi 等)只需加条目;当前只做 claude / codex 两条(优先级最高、判据最稳)。
 *
 * 登录态判据只做**存在性判断**,绝不落盘 / 不进日志(CLAUDE.md 规则 23):
 *   - `file` 探测:stat 凭证文件是否存在(Codex 的 ~/.codex/auth.json)。
 *   - `claude-oauth` 探测:Claude Code 登录态跨平台存两处——macOS 在系统 Keychain
 *     (service `Claude Code-credentials`),其它平台才是 ~/.claude/.credentials.json。
 *     只 stat 文件会漏掉 Mac 上正常登录(且可能连 ~/.claude 目录都没有)的用户,
 *     故改用 host 侧现成的 `hasClaudeAiOAuth()`(只返 boolean,不暴露凭证内容)。
 */

/** 可检测的本机 CLI 标识。 */
export type LocalCliId = 'claude-cli' | 'codex-cli';

/** 登录态探测方式:文件存在性 / Claude 跨平台凭证存(Keychain + 文件)。 */
export type CredentialProbe = 'file' | 'claude-oauth';

/** 单条检测结果:CLI 是否安装 / 是否已登录 + 建议接入的供应商 id。 */
export interface LocalCliDetection {
  cli: LocalCliId;
  /** 建议接入的内置供应商 id(anthropic / openai,与 active-catalog 的 provider id 对齐)。 */
  providerId: string;
  /** 配置目录存在(~/.claude / ~/.codex)。 */
  installed: boolean;
  /** 登录态凭证文件存在(只 stat 不读)。 */
  loggedIn: boolean;
  /**
   * Cindy 当前用的凭证**确实就是这一份本机凭证**(而不是各自登录了不同账号)。
   *
   * 与 `loggedIn` 是两件事,不能互推:codex 有独立的 codex-home,只有双方账号一致时
   * reconcile 才建硬链;账号不同时两边都 loggedIn,但用的不是同一份凭证。据此判定
   * 「已沿用本机订阅」类文案,避免对显式登录了另一个账号的用户报错话
   * (PR #1076 review)。判据按 CLI 分派,见 main 侧 `createLocalCliScanDeps`。
   */
  sharedWithCindy: boolean;
}

/**
 * 检测映射表:cli → { 配置目录, 登录态文件, 建议供应商 }。
 * 路径相对 home 目录,由 main 侧用 path.join 拼接(跨平台,规则 15)。
 */
export const LOCAL_CLI_DETECT_MAP: ReadonlyArray<{
  cli: LocalCliId;
  providerId: string;
  /** 配置目录(相对 home 的路径段)。 */
  configDirSegments: readonly string[];
  /** 登录态探测方式。 */
  credentialProbe: CredentialProbe;
  /** `file` 探测用的凭证文件(相对 home 的路径段);`claude-oauth` 探测不用它。 */
  credentialFileSegments?: readonly string[];
}> = [
  {
    cli: 'claude-cli',
    providerId: 'anthropic',
    configDirSegments: ['.claude'],
    credentialProbe: 'claude-oauth',
  },
  {
    cli: 'codex-cli',
    providerId: 'openai',
    configDirSegments: ['.codex'],
    credentialProbe: 'file',
    credentialFileSegments: ['.codex', 'auth.json'],
  },
];
