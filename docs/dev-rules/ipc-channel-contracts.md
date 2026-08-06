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

下列项目内 IPC wrapper / fan-out API 的 channel 参数同样禁止写字符串字面量：

- `createIpcFanOut`
- `broadcastToRenderers`
- `broadcastToAllWindows`
- `tapWindowBroadcast`

`apps/desktop/src` 与 `packages/device-link/src` 内不得重新定义字符串值形式的
`*_CHANNEL` / `*_CHANNELS` 常量（含 `new Set([...])`、`Object.freeze(...)` 等包装形式）。
需要保留 shared 文件作为 payload 类型入口时，只能从 `@cindy/cindy-ipc` re-export 或
派生常量。

channel-keyed 的映射表（如 device-link 的 invoke 超时覆盖表）同样必须用
`[IPC_CHANNELS.X.Y]` 计算键，不得写字符串键：guard 会把生产代码里与已登记 channel
等值的任何字符串字面量（对象 key、Set 成员、case 标签、任意实参位置）判为违规。
已登记 channel 的判定覆盖 `@cindy/cindy-ipc` 里**全部**常量表（含 `MAKER_INVOKE` /
`MAKER_PUSH` 等非 `*_CHANNELS` 命名的表）。

Mobile（`apps/mobile/app`、`apps/mobile/src`）同样在 guard 扫描范围内：mobile 经
device-link 隧道调用的就是同一批 channel，字面量漂移（cindy-ipc 改名后 mobile 还调
旧名）只有扫这里才能拦住。mobile 取常量一律
`import { IPC_CHANNELS } from '@cindy/device-link'`（re-export）；**不得**给
`apps/mobile/package.json` 直接加 `@cindy/cindy-ipc` 依赖——那会改 runtime
fingerprint 触发冷更（见 `mobile-development.md` 冷更边界）。

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
