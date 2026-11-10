# 原生触控：WebView 销毁回归

显式 macOS / Electron 集成验证，不进入默认单测。运行时打开独立测试窗口和临时
profile，不连接账号；只监听随机 loopback 端口，结束后清理 profile。

```sh
node apps/desktop/scripts/native-trackpad-teardown/run.mjs
```

测试加载生产 `installNativeTrackpad`，在真实 webview 中创建跨站 iframe（OOPIF），
以悬停启用触控后移除 webview，循环 30 次。只替代原生触控采样和业务日志，
Electron debugger、子页面生命周期、宿主清理代码均是真实实现。
成功须 `arms=30`、`detaches=30`、`completed=30`、退出码 0。
它覆盖宿主的原生销毁时序，不代表物理双指手势实测。

可传一个旧版 `nativeTrackpad.ts` 文件路径作为唯一参数，对照相同输入；该文件的
相对依赖仍从当前 checkout 的 `src/main` 解析。不要在正在使用的 Cindy 实例里复现。

## 2026-11-08 崩溃定位

Electron 42.11.12 / macOS arm64 的主进程在切换任务、移除插件 webview 时
发生 `SIGBUS`，地址为 `0xefefefefefefefef`。匹配官方 Electron Framework
Breakpad MODULE ID `4C4C449355553144A1B0969055B262660` 后，栈顶为：

- `0x12177d0` — `base::internal::WeakReferenceOwner::GetRef`
- `0x4263ecc` — `content::DevToolsSession::DispatchProtocolMessage`
- `0x28709ac` — `electron::api::Debugger::SendCommand`

下面的调用链是 `WebContentsImpl` 销毁 iframe → `TargetHandler::Session::Detach`
→ `Target.detachedFromTarget` → JS 清理 → 再次发送 CDP 命令。
原始系统报告只给出附近的导出符号（如 `node::AsyncWrap`），不能据此归因 Node。

`isDestroyed()` 在此通知发出时仍为 false；Promise 微任务也可能在同一原生回调栈内执行，
所以仅用 `.then` 推迟清理无效。生产入口在该通知期间将所有 CDP 命令推迟到下一轮
事件循环，执行前重新检查 root 和 child session 是否仍存活；原生采样仍立即停止。

旧代码在真实 webview fixture 中复现了相同 SIGBUS、异常地址和以上三个偏移。
同机修复后 30 次捕获／分离／关闭全部完成，退出码 0；17 项单测全部通过。
单测还覆盖无活动手势、活动手势、旧采样失效、
根页面存活时取消触摸以及替换 iframe 后恢复捕获。
