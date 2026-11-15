# @cindy/heartbeat-client

Cindy 客户端在线心跳模块。

- 零运行时依赖,仅用全局 `fetch` + `AbortSignal.timeout`
- Electron-agnostic (浏览器 / Node / Electron 主进程都能跑)
- Host 通过依赖注入提供 `getUid()` / `getPlatform()` / `getVersion()` / `logger`
- 启动立刻发一次,后续按 `intervalMs` 周期 tick
- 静默失败:任何网络/超时/非 2xx 只 warn,绝不抛
- `getUid()` 返回 null 时自动跳过本次 (登录态切换间隙友好)

## Usage

```ts
import { createHeartbeatClient } from '@cindy/heartbeat-client';

const handle = createHeartbeatClient({
  endpoint: 'https://heartbeat.example.com',
  intervalMs: 60_000,
  timeoutMs: 5_000,
  host: {
    getUid: () => currentUser?.id ?? deviceId,
    getPlatform: () => process.platform,
    getVersion: () => app.getVersion(),
    logger: myLogger,
  },
});

// 退出时:
handle.stop();
```

## Server contract

配套 server 位于独立服务端仓库，不在本客户端仓。endpoint 仅一个:

- `POST {endpoint}/heartbeat` body `{ uid, platform?, version? }` → `{ ok: true }`

不需要鉴权。
