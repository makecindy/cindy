/**
 * Codex 命令沙箱**初始化失败**的输出形状检测(#3793)。
 *
 * 受限 Linux 宿主(容器 / 禁用非特权 user namespace / 缺 CAP_NET_ADMIN)上,
 * codex 的 bubblewrap 沙箱会在配置 namespace / loopback 阶段直接死掉
 * (如 `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`),
 * 用户命令从未执行。此时 exec item 以 failed 收尾,aggregatedOutput 里
 * **只有** bwrap 自身的诊断行 —— 命令一旦真正跑起来,bwrap 即静默,输出
 * 全部来自命令本身。据此把「全部非空行都是 `bwrap: ` 前缀」作为初始化
 * 失败的判定形状:任何一行命令输出都会破坏该形状,不会误伤命令自身失败。
 *
 * 检出后在 tool_result 末尾追加宿主标注:模型不再对同一命令盲目重试,
 * 用户在工具卡里能看到归因。恢复入口(重试按钮 / 切 Full access 确认)
 * 属 renderer / 产品面,不在本模块范围。
 */

const BWRAP_LINE_PREFIX = 'bwrap: ';

/** 判定形状只看头部若干行,防御异常超长输出(热路径仅 failed item 走到这里)。 */
const MAX_SHAPE_LINES = 64;

export function isBwrapSandboxInitFailureOutput(output: string | null | undefined): boolean {
  if (!output) return false;
  const lines = output.split('\n');
  let nonEmpty = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    nonEmpty += 1;
    if (nonEmpty > MAX_SHAPE_LINES) return false;
    if (!line.startsWith(BWRAP_LINE_PREFIX)) return false;
  }
  return nonEmpty > 0;
}

/**
 * 追加进 tool_result 的宿主标注。英文(模型消费面,与其余宿主注入一致);
 * `[Cindy]` 前缀明示这是宿主归因而非命令输出。
 */
export const CODEX_SANDBOX_INIT_FAILURE_NOTE =
  '[Cindy] The Codex command sandbox (bubblewrap) failed to initialize on this restricted Linux host — ' +
  'the command above was never executed. This typically means the host blocks unprivileged user ' +
  'namespaces or network namespace setup (CAP_NET_ADMIN). Retrying the same command will fail ' +
  'identically; do not retry. Tell the user the sandbox cannot start in this environment and that ' +
  'they can either switch this task to Full access (their explicit choice) or run Cindy on a host ' +
  'that permits sandbox namespaces.';

/**
 * 命令本身就在调用 bwrap 时不做归因:此时 `bwrap: ` 诊断行来自**用户命令内层**
 * 的 bwrap(参数错误 / 嵌套沙箱被拒等),把它归因为 Codex 外层沙箱初始化失败并
 * 建议切 Full access 是误导(review P1)。外层沙箱真的起不来时,任意命令都会
 * 中招,下一条非 bwrap 命令仍会得到标注 —— 跳过的漏报代价可忽略。
 */
const COMMAND_INVOKES_BWRAP_RE = /(^|[\s/\\;|&('"`])bwrap(\s|$|['"`)])/;

export function commandInvokesBwrap(command: string | null | undefined): boolean {
  if (!command) return false;
  return COMMAND_INVOKES_BWRAP_RE.test(command);
}

/** failed exec item 收口时对 fullText 的最终改写:检出初始化失败则追加标注。 */
export function annotateSandboxInitFailure(
  fullText: string,
  isError: boolean,
  command?: string | null,
): string {
  if (!isError || commandInvokesBwrap(command) || !isBwrapSandboxInitFailureOutput(fullText)) {
    return fullText;
  }
  return `${fullText.trimEnd()}\n\n${CODEX_SANDBOX_INIT_FAILURE_NOTE}`;
}
