import type { PiAgent, PiMcpServerRef } from "@cindy/maker-core";
import type { SshPiHostHooks } from "./sshPiHost.js";
type Extra = Awaited<
  ReturnType<
    NonNullable<
      ConstructorParameters<typeof PiAgent>[0]["preparePiExtraSpawnConfig"]
    >
  >
>;
export async function forwardSshPiMcp(
  extra: Extra,
  remoteHostId: string | null | undefined,
  rewriter: SshPiHostHooks["rewriteRemotePiMcpBridgeUrl"] | undefined,
): Promise<Extra> {
  if (!extra?.mcpBridge || extra.mcpBridge.servers.length === 0) return extra;
  // 远端会话:把 in-process bridge 的 loopback URL 改成 remote-forward 地址
  // (SSH 隧道转发回本地 bridge)。身份 query / token 不变。

  if (remoteHostId && rewriter) {
    let servers;
    // 轮 24 HIGH-2:rewriter 每次调用建一条远端 forward, 会话结束必须关闭
    // —— 收集 close, 包装进 disposeSessionCtx, 否则端口随会话累积泄漏。
    const forwardClosers: Array<() => void> = [];
    // 轮 40-w4-t8 HIGH:并发重写时一个 rewriter reject 后, 其它 pending 的
    // rewriter 晚到 resolve 仍会 push close 并创建 forward —— Promise.all
    // 的 catch 只关当时已收集的, 晚到的 forward 永不关闭(端口/句柄泄漏)。
    // 改 Promise.allSettled: 全部 settle 后统一判定, 任一失败则关闭所有
    // 已成功项(含晚到的), 再重抛。
    const settled = await Promise.allSettled(
      extra.mcpBridge.servers.map(async (s) => {
        if (s.remote) return s; // 外部 HTTP MCP 直连,不改。
        const rewritten = await rewriter(remoteHostId, s.url);
        forwardClosers.push(rewritten.close);
        // 轮 29 LOW-2:显式标 PiMcpServerRef —— rewrite 后 URL 指向 SSH
        // 隧道本地端(不再是远端直连), remote 字段缺省 = undefined。
        const ref: PiMcpServerRef = {
          name: s.name,
          url: rewritten.url,
        };
        return ref;
      }),
    );
    const failed = settled.find((r) => r.status === "rejected");
    if (failed) {
      // URL 改写失败(SSH forward 不可用等):**所有**已建立的 forward 一并
      // 关闭(含晚到 resolve 的), 再注销已注册的 session ctx(否则 bridge
      // 端残留引用泄漏 —— R2 凭证 Bug7)。然后重抛,由 PiAgent 的 catch
      // 降级为「远端无 MCP」。
      for (const close of forwardClosers) {
        try {
          close();
        } catch {
          /* best-effort */
        }
      }
      try {
        extra.disposeSessionCtx?.();
      } catch {
        /* best-effort */
      }
      const reason = (failed as PromiseRejectedResult).reason;
      throw reason instanceof Error ? reason : new Error(String(reason));
    }
    servers = settled.map(
      (r) => (r as PromiseFulfilledResult<PiMcpServerRef>).value,
    );
    const baseDispose = extra.disposeSessionCtx;
    return {
      ...extra,
      mcpBridge: { ...extra.mcpBridge, servers },
      disposeSessionCtx: () => {
        for (const close of forwardClosers) {
          try {
            close();
          } catch {
            /* best-effort */
          }
        }
        baseDispose?.();
      },
    };
  }
  return extra;
}
