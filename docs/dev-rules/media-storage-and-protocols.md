# Desktop 媒体存储与协议

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改图片、视频、音频、3D 模型的生成、导入、附件、缓存、
> 持久化、协议解析、远程传递或回收逻辑之前

本文治理 Desktop 中由 Cindy 管理副本的媒体字节。Electron 协议与进程安全另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)，
数据库变更另见 [`database-and-migrations.md`](database-and-migrations.md)。

> **增量适用原则**：所有新媒体写入必须进入 `cindy-media`。历史协议和目录仅维持已有
> 地址兼容，不要求借普通功能改动迁移或删除存量文件。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 统一入库流程 | `apps/desktop/src/main/cindy-media/ingest.ts` |
| 内容寻址字节仓与安全解析 | `apps/desktop/src/main/cindy-media/blobStore.ts` |
| blob、引用和归属账本 | `apps/desktop/src/main/cindy-media/ledger.ts` |
| `cindy-media://` 读取协议 | `apps/desktop/src/main/cindy-media/cindyMediaProtocol.ts` |
| 引用归零与缓存回收 | `apps/desktop/src/main/cindy-media/recycler.ts` |
| 行为与安全不变量 | `apps/desktop/src/main/cindy-media/__tests__/` |

文档与实现冲突时先停下核对，不另建媒体存储或协议绕过现有契约。

## 哪些内容进入媒体总仓

- Cindy 需要拥有、缓存或持久化副本的图片、视频、音频和 3D 模型，统一进入
  `apps/desktop/src/main/cindy-media/` 管理的内容寻址仓。
- 用户磁盘上的原始文件如果只需就地读取，可以继续走已有受控本地文件通道；不要仅为
  预览就复制一份。远程设备或 SSH 文件必须保留真实来源，不能把远程绝对路径当成本机路径。
- docx、PDF、zip 等非媒体文件不进入媒体字节仓，继续使用已有 `xdt-file` 等受控文件
  通道。`xdt-audio` 只保留播放用户本地散文件的直读职责，不作为新的托管媒体写入口。

## 写入与记账

- 新写入优先调用 `ingestMedia` 或已有业务适配器，不新建专用媒体目录、cache store、
  数据表或协议，也不在调用方重复实现“写 blob、记账、挂引用”。
- 标准顺序是：主机核验媒体类型 → 按字节计算 SHA-256 并原子落盘 → 记录 blob → 挂业务
  引用。外部、插件或远端自报的指纹、扩展名和 Content-Type 不能单独作为可信依据。
- 持久附件或作品必须使用符合业务生命周期的引用。业务删除时只删除自己名下的引用，
  不直接删除共享 blob；物理回收由 `recycler.ts` 根据账本统一处理。
- `isCache: true` 只用于可以重新获取或重新生成的缓存。缓存一旦成为聊天历史、作品或其他
  不可再生用户内容，必须沿用现有 pin／引用流程转为不可按缓存回收。
- 零引用入仓只适用于已有草稿或生成结果提交链路。新增零引用窗口时，必须证明内容在消息
  落库前不会被回收，并用测试覆盖成功、失败、取消和重试。

## 读取、协议与边界

- 持久地址统一使用 `cindy-media://blobs/<sha256>.<ext>`。路径解析必须走
  `blobStore.resolveSafe` 或现有上层适配器，不根据 URL 字符串手工拼磁盘路径。
- `cindy-media://` 的 scheme privilege 和 handler 只在现有集中入口注册。不要为单一功能
  新增媒体协议；确需改变协议能力时，同时按 Electron 安全规则审查 CSP、fetch、Range、
  路径校验和 Renderer 暴露面。
- 默认不把媒体仓绝对路径直接暴露给 Renderer、插件或远端。跨边界传递使用托管 URL、
  受控 grant／deposit／ledger，或已有上传与远程媒体服务。
- 唯一的路径揭示例外是：用户明确询问某个受管媒体地址在本机的存储位置时，Host 先用
  安全解析器核验为现存普通文件，再通过 Host-owned 确认卡展示精确单文件路径；只有用户
  点击允许后，路径才可返回当前 Agent 并进入会话记录（因此也可能同步到用户的配对设备）。
  提示词或 Agent 自报“用户已同意”不能替代该确认，也不能借此给插件或远端开放文件读取。
- `xdt-image://`、`xdt-video://`、`xdt-model://` 和 `userData/cc-agent/` 是冻结的历史兼容层。
  可以读取已有地址，不得新增写入路径、扩展生命周期或把新功能接回旧仓。
- 删除或清理历史目录必须走已有的显式名单、复验和用户确认流程；不得新增任意
  `cc-agent` 子目录删除能力。

## 多端与远程

- 媒体记录必须保留设备、会话、插件或远程主机等真实归属信息，不能相信调用方自报的
  本机路径或 owner id。
- 远程来源无法证明、路径归属不明确或媒体类型无法安全确认时应 fail closed，不得回退读取
  本机同名路径。
- 跨端传递只改变传输形态，不改变账本和权限语义；上传缓存、临时副本和持久引用要分别
  设计生命周期。

## 已知待收口项（不得随旧文档删除而视为完成）

以下缺口在触及相关链路时必须一并修复，或在 PR 中保留明确的正式跟踪，不得静默丢弃：

- 插件持久引用的 per-插件 字节配额只覆盖 **寄存**（`ghost-deposit`，cindy 槽
  `deposit_media`）：上限 `GHOST_CINDY_DEPOSIT_QUOTA_BYTES`，插件详情逐项展示该上限，
  释放口是 `release_media`，卸载插件时按 refKind 清理。**画廊（`ghost-gallery`：模型
  代办产物与 network `as:'media'` 下载）仍无字节配额、仍不随卸载回收** —— 这两条是
  存量语义，改动它们属于产品决策，触及时另行拍板，不得当作已完成。
- 缓存默认上限与设置可见性、对账工具入口仍待收口。
- `userData/cc-agent/` 历史仓治理仍待收口（该目录是冻结的历史兼容层，见「读取、协议与
  边界」节）。

## Review 清单

1. Cindy 是否真的需要拥有该媒体副本？非媒体或就地读取是否误进总仓？
2. 新字节是否通过统一入库，且类型、指纹和路径均由主机验证？
3. blob、引用、缓存属性和业务删除是否表达同一生命周期？
4. 是否直接删除共享文件，或新增了专用目录、store、协议和旧仓写入？
5. Renderer、插件、设备和 SSH 边界是否只收到必要且经过归属校验的引用？
6. 定向测试是否覆盖去重、非法 URL、引用提交、回收、远程来源和失败清理？

修改媒体链路时，按 [`desktop-development.md`](desktop-development.md) 运行类型检查和
相关定向测试；涉及 schema、IPC 或协议时还必须追加对应专项规则要求的验证。
