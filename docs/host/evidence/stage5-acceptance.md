# 阶段 5 / 三条验收证据（2026-11-05）

## 1. 只有一个 Runtime：lease 由 Host 独占

```
$ fuser -v "$CINDY_HOST_DATA_DIR"/cindy-host-runtime-*.lock.db
<user>  <host-pid> F.... node    # 唯一的持锁进程就是 Host
```

Electron 客户端模式运行期间（45 条 `client mode` 日志）锁的持有者**始终只有 Host 的 pid**，
客户端进程没有新建任何租约；客户端退出后 Host 继续服务：

```
$ curl -o /dev/null -w '%{http_code}' http://127.0.0.1:3456/health
200
```

## 2. Electron 不参与 Runtime

- 启动即声明：`[bootstrap-electron] client mode: delegating to http://127.0.0.1:3456`，21 条通道由 Host 提供。
- 客户端模式下 `localDb.ensureReady` 直接拒绝：`localDb.ensureReady` 日志计数为 **0**，
  Desktop 全程没有打开 profile 数据库（`apps/desktop/src/main/host-client-mode.ts` 的守卫 +
  `localDb/index.ts` 早退），因此不可能成为第二个 writer。
- 退出时 `getMaker()` 抛 `cindy-host owns the runtime; this process is a client`（预期）。
- 客户端运行期间唯一错误是 dev server 的 renderer 预打包竞态（`renderer-guard` 自动重载），与 Runtime 无关。

## 3. 关掉浏览器 Host 仍在运行

关闭全部托管标签页后：

```
browser closed; host: ready ready claude-code,codex
```

Host 是独立 Node 进程，不依赖任何浏览器或 Electron 窗口。

## 4. 重开浏览器恢复会话

认证态下已验证（见 `stage4-e2e.md`）：刷新/新标签页恢复同一轮问答。当前测试 profile 已登出，
本轮无法重放；需按阶段 2 的人工登录步骤恢复认证态后再验。
