import { z } from "zod";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import { errorPayload, okPayload } from "./_payload.js";

export interface GithubToolCallbacks {
  call(
    callerSessionId: string,
    method: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}
const pr = z.union([
  z.object({ url: z.string().url().max(2048) }).strict(),
  z
    .object({
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      number: z.number().int().positive().safe(),
    })
    .strict(),
]);
const device = z
  .string()
  .min(1)
  .max(512)
  .optional()
  .describe("省略为本机；跨电脑传同账号已连接设备 ID。");
const freshness = z.enum(["cached_or_refresh", "refresh"]).optional();
const after = z.string().min(1).max(2048).optional();
const limit = z.number().int().min(1).max(100).optional();

export function registerGithubTools(
  registry: XdtHelperToolRegistry,
  deps: GithubToolCallbacks,
  current: () => string | undefined,
): void {
  const call = async (method: string, args: Record<string, unknown>) => {
    const caller = current();
    if (!caller)
      return errorPayload("SESSION_REQUIRED", "需要宿主绑定的当前任务。");
    try {
      const result = await deps.call(caller, method, args);
      return result.ok === false
        ? errorPayload(
            String(result.errorCode ?? "GITHUB_READ_FAILED"),
            "查询未完成；请根据错误码重新同步或检查 GitHub 登录。",
            result,
          )
        : okPayload(result);
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z_0-9-]+$/i.test(error.message)
          ? error.message
          : "GITHUB_OPERATION_FAILED";
      return errorPayload(
        code,
        "操作未完成；请检查参数、目标电脑与 GitHub 登录后重试。",
      );
    }
  };
  registry.register({
    name: "get_pr_status",
    category: "github",
    description:
      "读取明确 PR 的状态、当前提交 CI、评审汇总、采集时间与版本。本机或跨电脑，与界面共用缓存。查询不会关联任务或启动跟进；CI 通过不等于可合并。",
    inputShape: { pr, device, freshness },
    handler: (args) => call("get_pr_status", args),
  });
  registry.register({
    name: "get_pr_changes",
    category: "github",
    description:
      "读取观察到的 PR/提交/CI/评审/评论/线程变化。首次不传 after 建立基线，当前待办另读详情；后续传 next_cursor。读取不确认投递，成功处理后自行保存游标。RESYNC_REQUIRED 时重同步并沿已有回执去重。无周期监听副作用。",
    inputShape: { pr, device, after, limit, freshness },
    handler: (args) => call("get_pr_changes", args),
  });
  registry.register({
    name: "get_pr_details",
    category: "github",
    description:
      "按需获取检查、评审线程（含评论）、普通评论、reviews 或目标分支规则。保留原始事实与链接，按 next_cursor 分页；partial 不代表完整。",
    inputShape: {
      pr,
      device,
      kind: z.enum(["checks", "threads", "comments", "reviews", "rules"]),
      item: z.string().min(1).max(512).optional(),
      after,
      limit,
      freshness,
    },
    handler: (args) => call("get_pr_details", args),
  });
  registry.register({
    name: "manage_session_prs",
    category: "github",
    description:
      "明确管理任务的 PR 关联（本机/跨电脑）。省略 session_id 为当前任务。list 含历史引用与已移除记录；attach 不恢复已移除关系，restore 才恢复。reorder 传同一固定分组内全部 PR。搜索、阅读和引用链接不应 attach；接手处理或成功创建 PR 后显式 attach。此工具不创建自动跟进。",
    inputShape: {
      session_id: z.string().min(1).max(512).optional(),
      device,
      action: z.enum([
        "list",
        "attach",
        "detach",
        "restore",
        "pin",
        "unpin",
        "reorder",
      ]),
      pr: pr.optional(),
      prs: z.array(pr).min(1).max(2000).optional(),
      after,
      limit,
    },
    handler: (args) => call("manage_session_prs", args),
  });
}
