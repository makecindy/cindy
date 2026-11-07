/**
 * xdt-helper/backgroundCommand.ts —— run_command_background tool
 *
 * 把一条长耗时 shell 命令交给宿主后台运行,本回合立即返回;命令结束时宿主把
 * 「后台命令完成」报告(退出码 + 日志尾部 + 日志路径)注入本任务,空闲即派发、
 * 正忙则排队。这是「跑测试/门禁不干等」的回调化通道:启动后可以结束回合或做
 * 别的事,不要 sleep 轮询。
 *
 * 命令在**本机**、以当前任务工作目录为 cwd 运行;远程(SSH)会话直接拒绝。
 * 每次调用都走会话权限档确认(prompt-each-time,见 mcp-tool-approval-policy)。
 */

import { z } from "zod";

import type { LiziMcpSessionContext } from "../types.js";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import { errorPayload, okPayload } from "./_payload.js";

export interface BackgroundCommandStartRequest {
  sessionId: string;
  /** 调用时的会话实例;宿主用它拒绝过期实例的启动请求。 */
  sessionInstanceId?: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
}

export interface BackgroundCommandToolDeps {
  getSessionContext: () => LiziMcpSessionContext | undefined;
  /** 宿主侧服务入口(maker-host/background-commands);缺失 = HOST_NOT_READY。 */
  start: (
    request: BackgroundCommandStartRequest,
  ) => Promise<
    | { ok: true; runId: string; logPath: string; pid: number | undefined }
    | { ok: false; errorCode: string; message: string }
  >;
}

const DESCRIPTION =
  "把一条长耗时 shell 命令交给宿主在本机后台运行,调用立即返回 run_id 与 log_path,本回合可以结束或继续做别的;" +
  "命令结束时宿主会自动向本任务发来一条「后台命令完成」消息(退出码 + 日志尾部 + 完整日志路径),无需轮询等待。" +
  "适用:预计超过一两分钟的测试、构建、门禁、`gh run watch --exit-status` 等;短命令仍用普通 bash。" +
  "注意:命令以当前任务工作目录为 cwd 在本机执行(远程/SSH 会话不可用);日志文件保留 14 天、单条上限 5MB(超限保头部丢弃后续,完成报告仍带最后的输出);应用重启会丢失完成回报,但日志文件保留;并发上限 8 条,命令自行脱离的后代(`&`/`start /b`)同样计入名额。" +
  "不要让命令自行后台化:请让命令自身持续运行,宿主会在 24h 硬顶到点时连同子进程树一起结束它。POSIX 上同进程组的后代随硬顶一并清理;Windows 上 shell 退出后宿主不再按 PID 查杀后代(防 PID 复用误杀),这类自行脱离的后代不受硬顶治理。" +
  "启动成功后不要 sleep 或反复查看,直接向主人说明会在完成时汇报,然后结束回合。";

export function registerBackgroundCommandTool(
  registry: XdtHelperToolRegistry,
  deps: BackgroundCommandToolDeps,
): void {
  registry.register({
    name: "run_command_background",
    category: "control",
    description: DESCRIPTION,
    inputShape: {
      command: z
        .string()
        .min(1)
        .describe(
          "要后台运行的 shell 命令(整条命令行,stdout/stderr 会写入日志文件)",
        ),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(86400)
        .optional()
        .describe("时限(秒),超时强制终止并汇报;缺省 86400(24 小时硬顶)"),
    },
    handler: async (args) => {
      const context = deps.getSessionContext();
      if (!context?.sessionId) {
        return errorPayload(
          "NO_SESSION_CONTEXT",
          "当前调用没有绑定的 Cindy 任务,无法投递完成回报。",
        );
      }
      if (context.remoteHostId) {
        return errorPayload(
          "REMOTE_SESSION_NOT_SUPPORTED",
          "远程(SSH)会话的工作目录在远端机器上;本命令只能在本机运行,请在远端 shell 里执行。",
        );
      }
      const result = await deps.start({
        sessionId: context.sessionId,
        ...(context.sessionInstanceId
          ? { sessionInstanceId: context.sessionInstanceId }
          : {}),
        command: args.command,
        cwd: context.workingDir,
        ...(args.timeout_seconds
          ? { timeoutMs: args.timeout_seconds * 1000 }
          : {}),
      });
      if (!result.ok)
        return errorPayload(
          result.errorCode,
          `后台命令启动失败:${result.message}`,
        );
      return okPayload({
        run_id: result.runId,
        log_path: result.logPath,
        pid: result.pid ?? null,
        note: "命令已在后台运行。本任务会在它结束时自动收到退出码与日志尾部;应用若在期间重启,回报会丢失但日志保留。结束回合即可,不要轮询。",
      });
    },
  });
}
