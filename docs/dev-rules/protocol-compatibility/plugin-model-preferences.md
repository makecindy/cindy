# 插件模型收藏与最近使用（2026-11-17，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Ghost manifest 追加 `agent.modelPreferences?: boolean`（append-only）：客户端协议正本 `packages/plugin-protocol/src/manifest.ts` 与 Desktop `shared/ghost.ts` 同步校验，新包非布尔拒装；只写 `agent: { modelPreferences: true }` 是合法的 agent 详单。未升级的消费者（旧 Desktop、服务端仓同名 plugin-protocol 未同步前的 plugin-server）把它当未知 agent 字段原样保留、不授予、不拒装，服务端补同一校验与 fixture 前不影响上架；补齐时沿用本仓的有效／无效 fixture（`manifest.test.ts`「validates standalone agent.modelPreferences」）。

插件同源端点（本机 Electron 插件页，非 device-link）：`GET /model-preferences` 返回 `{ok:true,favorites:[RemoteModelFavorite],recents:[Omit<RemoteModelFavorite,'uid'>]}`；`POST /model-preferences/favorites` 正文为 `@cindy/device-link` 的 `ModelFavoriteMutation`，成功返回 `{ok:true,favorites}`。条目形状与 device-link 收藏通道一致（`agent: cc|codex|pi`，providerId ≤512），只含本机来源。错误：403 `PERMISSION_DENIED`、400 `INVALID_REQUEST`（含非本机来源）、409 `CONFLICT`、503 `NOT_AVAILABLE`；任何查询参数 400，方法不对 405。旧 Host 返回 404，插件退回只用 `/agent-models`。

`GET /agent-models` 每项追加可选展示字段 `description`、`icon`、`group`、`contextWindow`、`supportsFastMode`、`supportsUltrafastMode`、`effortDisplayNames`、`logoKind`，原字段与语义不变；旧插件忽略多出的字段。

Main↔Renderer 收藏桥 `FavoriteHostRequest` 追加可选 `recents: true`，`FavoriteHostReply` 追加可选 `recents`；两端同包发布，device-link 的 `MODEL_FAVORITES_GET/APPLY` 不带该字段，wire 不变。手机与远程控制页面暂不开放这两个端点。实现与回归见 `cindy-brain/ghostModelPreferences.ts`、`maker-ipc/modelFavoritesSync.ts` 及 `electronSandboxAdapter.ownerPartition.test.ts`、`modelFavoritesSync.test.ts`。
