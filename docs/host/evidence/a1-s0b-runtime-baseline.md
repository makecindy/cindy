# A1 · S0b 基线（运行时实测，2026-11-06）

在独立 profile（`/tmp/a1-s0b/profile`）下运行 `cindy-host` 与 Electron dev 客户端模式实测，截获了完整的日志与截图。

## 关键实测发现

### 1. 运行时抛错的缺失通道清单（实际阻断前台 UI）

前端加载后触发的未注册 IPC 调用：
1. `maker:get-capabilities`（27 次）：前端模型目录无法刷新，模型选择器卡住
2. `maker:provider:list`（9 次）：前端拿不到 provider 清单
3. `maker:list-active`（1 次）：活动任务清单获取失败
4. `maker:project-automation:pending-imports`（1 次）
5. `maker:remote-ssh:cc-mgr-list-pending-upgrades`（4 次）

### 2. 根因剖析：为什么这几个通道在 `PROXIED_CHANNELS` 里却依然报 "No handler registered"？

通过代码核查 `bootstrap-electron.ts`：
```typescript
const registerMakerIpcsAfterSplash = async (): Promise<void> => {
  if (makerIpcsRegistered) return;
  if (hostClientMode) {
    makerIpcsRegistered = true;
    return; // <-- 客户端模式下直接返回，跳过了正常注册！
  }
...
```
而在启动阶段：
1. `installHostClientMode()` 执行时虽然调用了 `registerHostDelegatedIpc`，但在 `bootstrap-electron.ts` 后续或 splash 过程中，被后续的通道清理/重新注册覆盖或注册时序竞争。
2. 更严重的是，未包含在 `PROXIED_CHANNELS` 里的其他 `maker:*`（如 `pending-imports`, `remote-ssh:*` 等）因为 `registerMakerIpcsAfterSplash` 直接 return，**完全没有注册任何兜底 handler**，直接抛出 `No handler registered`。

### 3. `ensureReady` 实际表现验证
在客户端模式下未观察到 UI 弹出硬崩溃对话框，但由于核心通道缺失，UI 无法进入正常就绪交互状态。

## S0b 结论

静态分析（S0）和运行时实测（S0b）结论完全闭环：
- 桌面端客户端模式必须拥有一致的代理通道分发器。
- 未代理通道不能直接裸漏报错（导致前端无限报错/重试），必须统一显式返回 `UNSUPPORTED_CAPABILITY` 或安全空态。
- S2（统一通道契约）是彻底修复此问题的核心。
