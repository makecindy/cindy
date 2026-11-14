# Codex 线程存储：桌面与 Node Host

## 要对齐的结果

线程的历史目录、SQLite 目录与当前登录账号的启动目录是三个不同事实。换账号继续原线程时，不能因新账号目录变化而换掉历史来源；只读查询不能导入、复制、修复或登记历史。cp18d 仅补这些存储/恢复依赖，不推进订阅池选择、远程任务、受邀者产品接入或凭据适配器整体差异。

| 分支/触发 | 桌面实际入口与结果 | 接入前的 Host 缺口 | 共用行为与验证 |
| --- | --- | --- | --- |
| 无 owner，读取历史 | codex-thread-storage.ts 的 readCodexThreadStorageReadOnly 跳过位置索引，走 readCodexThreadStorageForArchiveAsync；读前后核 owner scope | 没接 resolveCodexThreadStorage | 复用同一分支；不创建 owner 索引，读完仍无写入 |
| 无 owner，可写定位 | maker-host/index.ts:1934 的 resolve 回调直接返回 undefined；prepare 回调则走 prepareExternalCodexSessionForResume | 没接 resolve/prepare | 保留两个回调各自语义，不能统一成一次“找不到就修复” |
| 有 owner，只读且已有位置索引 | readCodexThreadStorageReadOnly 优先 ownerCodexThreadLocations().readStorage(id)，不传 legacy 参数 | 未查询位置索引 | 相同索引输入返回相同 historyHome/sqliteHome/rolloutPath，文件字节不变 |
| 有 owner，只读且无索引 | 回退 readCodexThreadStorageForArchiveAsync，先当前 home 后外部 homes | 引擎缺省逻辑未获得原存储三元组 | 共用发现流程；只读不采用/复制历史、不补索引 |
| 有 owner，可写且有索引 | readStorage(id,{home,prepare}) 经 prepareLocation 修复路径；保留原 sqliteHome | 未接此回调 | 复用 CodexThreadLocations；修复期间索引被另一进程改变时拒绝旧结果 |
| 有 owner，可写且无索引 | legacy.prepare 找到原历史后 record；historyHome 来自 rollout，sqliteHome 为原 legacy.home | 引擎不会走这份定位/登记 | 同一夹具与桌面对照；prepare 无结果则 undefined，不凭空登记 |
| 索引记录了尚未落盘的 rollout | readStorage 保留原目录，即使路径暂不存在；prepareResume 返回 undefined，不改去找旧副本 | 无索引语义 | 未使用线程与被删除历史由引擎既有后续判定区分，不扩大兜底 |
| 索引损坏、路径不是普通文件/读权限错误 | CodexThreadLocations 校验/读盘错误照抛；缺失与其他错误分开 | 未接此处理 | 错误种类和磁盘结果对照；不退回另一个账号的旧历史 |
| prepareResume 有/无索引 | 有索引只准备该位置；无索引才调用 prepareExternalCodexSessionForResume。修复后返回原生路径，不抢写新索引 | prepare 依赖缺席 | 保留原 callback 行为；引擎会传 context，当前桌面 callback 只用 threadId，不能自行用 context 改换历史 home |
| 新线程、恢复、归档或 fork 的位置登记 | index.ts:1971，缺 rollout 或无 owner 时不写，其余 record(id,path,sqliteHome) | recordCodexThreadLocation 缺席 | 接同一规则；owner 的 thread-index 目录不共用其他账号索引 |
| 运行中切换 owner | read-only 与 resolve 准备前后核 activeOwnerScopeKey，变化则拒绝 | Codex runtime 有自己的 owner/current 检查，但没有线程存储回调 | 保留桌面原回调检查并叠加 Host 现有运行时寿命；不自行更改桌面的 record/prepare 并发语义 |
| 本地普通 resume 与更换账号恢复 | maker-core codex/index.ts:5235 取存储三元组参与 host identity；6963 准备 canonical rollout；7153 登记结果 | 同一 maker-core 已加载，但可选依赖未提供，不能因此认为行为已对齐 | 在真实 CodexAgent 路径验证两个账号恢复仍用原 historyHome/sqliteHome，改启动账号不迁历史 |
| 本地归档/取消归档 | codex/index.ts:1761 只读定位；复用仍持有线程的 native writer，否则建原存储的 control-plane host；1806 登记新路径 | 相同引擎代码但没有定位/登记端口 | 用同串请求对照 host 的目录入参、归档路径更新；不运行回合，不用复制导入 |
| route 切换与 fork/rollback | codex/index.ts:15331 以原 storage 算目标 host；15445 定位 fork 来源；15591/15618 登记新线程 | maker-core 相同，端口缺席 | 接端口后覆盖原 sqliteHome、fork 失败/回滚的登记；恢复准备错误不改成成功 |
| 远端与受邀者 | 引擎 remoteHostId 不读本地；hostedGuest 使用受邀者目录且不登记本机 owner 索引 | 产品入口尚未对齐，不在 cp18d 接入 | 只保留共用引擎绕开本机存储的分支，拒绝测试以本机 home 兜底；不新增远程实现 |
| 订阅池按历史 home 反查账号 | desktop index.ts:2081 给 subscription-accounts/agent.ts 的 resolveCodexHistoryHome；agent.ts:155 只读定位历史后反查所属订阅账号 | Host 未装配这条订阅账号包装/反查路径 | 单列依赖：先提供可复用的只读 reader；该历史反查端口归 M2，cp18d 不装配订阅池分配 |

## 当前装配

`codexLocalSessionsCore.ts` 保存原有文件、SQLite、修复与发现算法，`codexLocalSessions.desktop.ts` 在模块加载时构造一个实例。目录端口每次调用读取 `app.getPath('userData')`，不捕获一次性的路径；原 `codex-local-sessions.ts` 保留函数声明、导出名与签名。

不能改用启动时捕获的 `userDataPath`：窗口启动器申请单实例锁时会临时切换 userData，版本与电源工作进程也可能设置它。原生历史测试同样会在用例间改变 Electron mock。平台和区域 fallback 保留在共用主体中。

`codexThreadStorageCore.ts` 共用线程索引、只读组合及 prepare/resolve/record 三个回调。桌面薄绑定用原账号目录和读取函数；Host 的 `codex-thread-storage.ts` 用同源账号服务与绑定的 profile，并在读取前后检查运行时/owner。运行时失效的检查在路径 fallback 之外，不允许它回退去扫描系统 profile。

Host 已把三个回调接入 CodexAgent。订阅池按历史目录认回账号归 M2，不在这一步装配账号分配；这不影响已经存在的账号绑定。也不开放未登录 Host、远程执行或受邀者产品入口。

## 验证入口

- `hostCodexThreadStorageParity.test.ts`：同一份真实文件，桌面函数与 Host 装配逐项对照；只读前后比较全部目录和文件字节，发现路径限制在夹具内；含旧索引、独立 SQLite、未落盘、损坏、权限错误、索引并发变化、owner 变化与失效运行时。
- 既有 `codexLocalSessions.test.ts` 与 `.native.test.ts` 保持原样；拆分前后用例名称、状态和数量逐项对照。
- Host `scripts/codex-runtime.e2e.mjs`：真实 CodexAgent 与原生 Codex，本机模拟上游；两个内部目录能力之间恢复，归档/取消归档、分叉/尾裁、路线更换都检查原历史/SQLite 与登记位置。模拟目录能力与 API key 仅用于夹具，不代表订阅分配或登录已验收。较新的原生版本尾裁使用 turn anchor，旧版 `thread/rollback` 分支由 maker-core 既有用例保护。
- 同一 e2e 验证远端未配置时拒绝、受邀者目录找不到本机原线程时失败，两条都不调用本机历史 resolver/preparer；不为测试增设远端产品实现。
