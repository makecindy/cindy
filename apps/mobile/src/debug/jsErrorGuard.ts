import {
  JS_ERROR_NAMES,
  type JS_ERROR_KINDS,
} from "./diagnosticEvents";
import { mobileDebugLog } from "./mobileDebugLog";

/**
 * JS 报错兜底：启动稳定之后，JS 报错不再让 App 直接退出。
 *
 * - 渲染报错由根级 `RootErrorBoundary` 接住并显示可重试的错误页；
 * - 回调、定时器等处的未捕获报错经本模块包住的全局处理函数降为非致命，App 继续运行。
 *
 * 启动窗口内（根布局首次提交后的 `LAUNCH_WINDOW_MS` 之内）两者都保持原有的致命行为：
 * expo-updates 的错误恢复在「首屏出现后 10 秒」内靠致命报错回滚坏掉的热更，这里的窗口
 * 取 20 秒，严格覆盖它，回滚行为不变。
 *
 * 记录只进本机诊断日志（`js error` 事件），且只含报错类型与打包文件里的行列号；
 * 报错文本和堆栈原文可能夹带用户内容，从不读取。
 */
export const LAUNCH_WINDOW_MS = 20_000;
const MAX_FRAMES = 3;
/** Hermes / JSC 堆栈行尾的 `:行:列`；只取数字，不取函数名或路径。 */
const FRAME_POSITION = /(?:^\s*at\s|@).*:(\d{1,9}):(\d{1,9})\)?\s*$/;

export type JsErrorKind = (typeof JS_ERROR_KINDS)[number];
type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
export interface ErrorUtilsLike {
  getGlobalHandler(): GlobalHandler;
  setGlobalHandler(handler: GlobalHandler): void;
}

/** 报错的可记录投影：类型名（白名单内）与最上面几帧的行列号。 */
export function describeJsError(
  error: unknown,
): Record<string, number | string> {
  const fields: Record<string, number | string> = { name: "other" };
  if (!error || typeof error !== "object") return fields;
  const { name, stack } = error as { name?: unknown; stack?: unknown };
  const known = JS_ERROR_NAMES.find((value) => value === name);
  if (known) fields.name = known;
  if (typeof stack !== "string") return fields;
  let frame = 0;
  for (const line of stack.split("\n", 64)) {
    const match = FRAME_POSITION.exec(line);
    if (!match) continue;
    frame += 1;
    fields[`line${frame}`] = Number(match[1]);
    fields[`column${frame}`] = Number(match[2]);
    if (frame === MAX_FRAMES) break;
  }
  return fields;
}

export function recordJsError(kind: JsErrorKind, error: unknown): void {
  mobileDebugLog("error", "lifecycle", "js error", {
    kind,
    ...describeJsError(error),
  });
}

export function createJsErrorGuard(deps: {
  now(): number;
  record(kind: JsErrorKind, error: unknown): void;
}) {
  let committedAt: number | undefined;
  const launchSettled = (): boolean =>
    committedAt !== undefined && deps.now() - committedAt >= LAUNCH_WINDOW_MS;
  return {
    /** 根布局首次提交时调用一次；之后的调用不重置窗口。 */
    noteRootCommitted(): void {
      committedAt ??= deps.now();
    },
    launchSettled,
    install(errorUtils: ErrorUtilsLike): void {
      const previous = errorUtils.getGlobalHandler();
      errorUtils.setGlobalHandler((error, isFatal) => {
        if (!isFatal || !launchSettled()) {
          previous(error, isFatal);
          return;
        }
        deps.record("uncaught", error);
        previous(error, false);
      });
    },
  };
}

const guard = createJsErrorGuard({
  now: () => performance.now(),
  record: recordJsError,
});
export const noteRootCommitted = guard.noteRootCommitted;
export const launchSettled = guard.launchSettled;

let installed = false;
/** 入口处调用一次。开发构建保留红屏，不改未捕获报错的行为。 */
export function installJsErrorGuard(): void {
  if (installed || __DEV__) return;
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!errorUtils) return;
  installed = true;
  guard.install(errorUtils);
}
