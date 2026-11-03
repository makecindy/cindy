import { LogBox } from "react-native";
import {
  configureReanimatedLogger,
  ReanimatedLogLevel,
} from "react-native-reanimated";

/**
 * 开发模式的日志降噪,只影响提示和 Reanimated 的 strict 检查,不吞普通警告和错误。
 *
 * RN 在支持 Fusebox 的宿主上不逐条弹警告:没连调试器时,第一条警告触发一次这句固定提示,
 * 警告本身只进 console(见 react-native/Libraries/LogBox/Data/LogBoxData.js)。所以屏蔽
 * 这一句即可去掉挡住界面的浮层,警告仍可在调试器和 Metro 里查看,错误弹窗不受影响。
 */
export const DEBUGGER_WARNINGS_HINT = "Open debugger to view warnings.";

/** 仅开发包生效;`isDev` 只为测试注入,生产代码用默认值。由 index.js 在入口最先调用。 */
export function installDevLogFilters(isDev: boolean = __DEV__): void {
  if (!isDev) return;
  LogBox.ignoreLogs([DEBUGGER_WARNINGS_HINT]);
  // strict 只提示「渲染期读取 shared value」,单次页面操作会刷上百条且没有调用栈可定位。
  configureReanimatedLogger({ level: ReanimatedLogLevel.warn, strict: false });
}
