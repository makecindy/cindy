# IPC Channel Contracts

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 Electron IPC channel、device-link invoke/push allowlist、
> preload bridge、`ipcMain` / `ipcRenderer` / `webContents.send` 调用点之前

Electron IPC、WebView guest/host 消息与 device-link 隧道 channel 的唯一字符串来源是
`packages/cindy-ipc`（包名 `@cindy/cindy-ipc`）。调用点只引用常量，不直接写
channel 字符串。

## 1. 唯一事实源

- 新增、删除或调整 channel 时，先在 `@cindy/cindy-ipc` 对应业务域文件中定义常量。
- `apps/desktop/src/main/maker-ipc/channels.ts` 只从 `@cindy/cindy-ipc/maker`
  re-export，不能重新维护第二份 maker channel 表。
- `packages/device-link/src/allowlist.ts` 与 `topics.ts` 只消费
  `@cindy/cindy-ipc` 常量。新增远程可用 channel 时，必须同步评估 allowlist
  准入：是否依赖 sender / 窗口对象、是否有本机 UI 或 shell 副作用、语义是否必须在被控端执行。
- WebView guest/host 消息（例如 `webview.send` / `ipcRenderer.sendToHost` 配套
  channel）也必须先进入 `@cindy/cindy-ipc`，shared 文件可以 re-export 常量并继续维护
  payload 类型。
- `@cindy/cindy-ipc` 必须保持零 Electron、零 React、零 Node runtime 依赖；只能放常量、
  类型和纯结构。

## 2. 调用点规则

下列低层 API 的 channel 参数禁止写字符串字面量：

- `ipcMain.handle/on/once/handleOnce`
- `ipcRenderer.invoke/send/on/once/sendSync/postMessage/sendToHost`
- `webContents.send`、`event.sender.send`、`sender.send`

测试里需要构造非法未知 channel 时，使用明显非法值并在同一行或上一行标注
`ipc-channel-literal-ok`。该例外只用于负例测试，不得用于真实 handler、bridge 或
broadcast。

## 3. 验证

- `pnpm check:ipc-channels` 阻断低层 IPC 调用点的字符串 channel。
- 修改 `@cindy/cindy-ipc` 后至少运行：

```bash
pnpm --filter @cindy/cindy-ipc build
pnpm check:ipc-channels
```

触及 Desktop 或 device-link 行为时，按 `desktop-development.md` 与
`development-workflow.md` 追加对应 package typecheck、定向测试和提交前门禁。
