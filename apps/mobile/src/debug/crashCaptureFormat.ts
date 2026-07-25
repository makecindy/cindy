/**
 * crashCapture 的纯格式化 / 判定逻辑(零依赖:不 import react-native / expo)。
 * 拆出来是为了能在 node 环境下直接单测,不必 mock 任何原生模块;IO 与副作用留在
 * crashCapture.ts。见 crashCapture.ts 的模块头注。
 *
 * 安全:崩溃日志可被用户从设置页导出/分享,error message/stack/rejection 里可能夹带
 * token、Authorization、Cookie 等可复用凭证(见 credentials-and-local-storage 规则)。
 * 所有落盘文本在 formatCrashEntry 里统一过 redactSensitiveText 脱敏;这是仓内既有的
 * 纯字符串洗刷器(幂等,零依赖,可在 node 测试环境直接用)。
 */

import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';

/**
 * 启动阶段。前 5 个随启动闸门顺序推进('ready' 为走到首屏的正常终态);
 * 'reloading' 是额外的正常终态——预期内主动重载(如冷启动 OTA 换包)在调用 reloadAsync
 * 前写入,避免把"进程被主动换掉、没走到 ready"误判成崩溃。
 * 'crashed' 是显式的异常终态——JS 致命异常 / React 渲染崩溃发生时写入,使「上次退出异常」
 * 能反映**运行期崩溃**,而不仅是「启动没走到 ready」(否则 ready 之后崩溃会被误报为正常)。
 */
export type BootPhase =
  | 'starting'
  | 'endpoints'
  | 'ota'
  | 'auth'
  | 'ready'
  | 'reloading'
  | 'crashed';

/** 启动闸门的顺序阶段(不含 'reloading' 这种旁路终态)。 */
export const BOOT_PHASE_ORDER: readonly BootPhase[] = [
  'starting',
  'endpoints',
  'ota',
  'auth',
  'ready',
];

/** 崩溃日志滚动上限(字节/字符,近似)。超出则从头部截断保留尾部最新记录。 */
export const MAX_CRASH_LOG_CHARS = 256 * 1024;

/** 崩溃记录来源分类。 */
export type CrashSource = 'uncaught' | 'unhandledRejection' | 'react-render';

/** 把任意 throw 值规整为 { message, stack }(error 可能不是 Error 实例)。 */
export function normalizeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message || error.name || 'Error', stack: error.stack };
  }
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

/**
 * 格式化一条崩溃记录(纯函数)。时间戳由调用方传入,便于测试可复现。
 * `extra` 用于承载 React componentStack 等附加上下文。
 */
export function formatCrashEntry(input: {
  source: CrashSource;
  error: unknown;
  isFatal?: boolean;
  at: number;
  extra?: string;
}): string {
  const { message, stack } = normalizeError(input.error);
  const iso = new Date(input.at).toISOString();
  const fatal = input.isFatal ? ' FATAL' : '';
  const lines = [
    `[${iso}] ${input.source}${fatal}: ${message}`,
    stack ? stack.trimEnd() : '(no stack)',
  ];
  if (input.extra && input.extra.trim()) {
    lines.push(`componentStack:${input.extra.trimEnd()}`);
  }
  // 整条脱敏后再落盘:覆盖 message / stack / componentStack 里可能夹带的凭证。
  return redactSensitiveText(lines.join('\n')) + '\n';
}

/**
 * 追加并按上限截断(纯函数)。超出 maxChars 时从头部丢弃,保留尾部最新内容,
 * 并在开头标注被截断,避免让人误以为拿到的是完整历史。
 */
export function appendWithCap(existing: string, entry: string, maxChars = MAX_CRASH_LOG_CHARS): string {
  const next = existing + entry;
  if (next.length <= maxChars) return next;
  const marker = '…<日志已从头部截断 / truncated>…\n';
  // 极端:上限比截断标记还短,放不下标记时直接返回尾部 maxChars,保证返回长度 <= 上限。
  if (marker.length >= maxChars) return next.slice(next.length - maxChars);
  const keep = maxChars - marker.length;
  return marker + next.slice(next.length - keep);
}

/**
 * 判定上次启动是否异常退出(纯函数):有上次面包屑且其阶段不是「正常终态」即为异常。
 * 正常终态 = 'ready'(走到首屏)或 'reloading'(预期内主动重载,如冷启动 OTA 换包)。
 * 无面包屑(首次安装/已清理)视为正常。
 */
export function isAbnormalPreviousBoot(previous: { phase?: string } | null | undefined): boolean {
  if (!previous || typeof previous.phase !== 'string') return false;
  return previous.phase !== 'ready' && previous.phase !== 'reloading';
}

/**
 * 选择在何处安装未处理 Promise rejection 追踪(纯函数,便于单测)。
 * 参照 RN 0.85 的 polyfillPromise 决策:
 * - dev 下 RN 自己已装 tracker,再装会「最后一个赢」覆盖它 → 让给 RN,返回 'none';
 * - 正式包 Hermes(hasPromise)RN 不装任何 tracker(其安装被 __DEV__ 剥离)→ 用
 *   HermesInternal.enablePromiseRejectionTracker,返回 'hermes';
 * - 正式包非 Hermes(JSC)→ 用 promise polyfill 的 rejection-tracking,返回 'polyfill'。
 */
export function selectRejectionTracker(env: {
  isDev: boolean;
  hermesHasPromise: boolean;
}): 'none' | 'hermes' | 'polyfill' {
  if (env.isDev) return 'none';
  return env.hermesHasPromise ? 'hermes' : 'polyfill';
}
