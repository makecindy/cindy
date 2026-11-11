# 协同创建 Worker 的记忆以被控端为准（2026-11-10，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

协同里创建 Worker 的记忆，真相都在**任务所在的电脑**当前账号下（renderer `workerCreationPrefs`）：

- 角色清单（内置的审查、开发、测试，加上用户添加的）与每个角色记住的任务文字、权限和模型路线
  （`rolesByOwner`）；
- 不分角色的「上次选择」：上次用的 Agent、各 Agent 的模型、权限、手动选定的完整路线
  （`lastAgent`、逐 Agent 项、`workerPermissionMode`、`modelSelectionByHost` 的本机一项）。

手机与远程控制的电脑只读写这一份，不在自己这边另存（用户裁决：「上次选择」也记在远程电脑上）。

两个同账号 invoke channel（`packages/device-link/src/orcaWorkerRoles.ts`，已进
`REMOTE_INVOKE_ALLOWLIST` 与 `MOBILE_REMOTE_INVOKE_CHANNELS`，不进共享任务访客白名单）：

- `maker:worker-roles:get`：返回 `{ roles: [{ role, task?, permission?, model? }], defaults? }`。
  `roles` 的顺序即显示顺序（最近使用在前）。`model` 为
  `{ agent, agentDeviceId, model, effort, fast, providerId }`，`agentDeviceId: null` 表示 Agent 就在
  任务所在的电脑上；只给本机任务的那一条路线。`defaults` 为
  `{ agent, permission, agents: { codex, claude-code, pi }, model? }`，逐 Agent 项是
  `{ model, effort, fast, providerId }`。被控端 main 读的是 renderer 镜像过来的快照
  （`maker:sync-worker-creation-prefs` 的可选字段 `roles`，按账号与代次隔离）；还没镜像到或账号正在
  切换时回 `PRECONDITION_FAILED`。
- `maker:worker-roles:apply`：只接受 `{ kind: 'remember', role, task?, permission?, model?, choice? }`
  与 `{ kind: 'forget', role }`。`choice` 为 `{ agent, agentModel?, route? }`：带上时同时更新「上次
  选择」——`agent` 记为上次用的 Agent，`permission` 记为默认权限，`agentModel` 只在模型属于被控端
  自己的目录时带（Agent 就在那台电脑上、没选其他运行设备），`route` 为对象 = 记下手动选定的路线、
  `null` = 清掉之前记的、缺省 = 不动。main 校验后经本机 push `maker:worker-roles:apply-request`
  （不进 device-link 转发）交给自身 renderer 写回真源，renderer 再把新内容镜像回 main；main 不
  另存一份。回执 `{ ok: true }` 只表示已转交，不等写入完成：控制端不依赖紧接着的读取结果。

被控端的默认权限本来就跟随最近一次带明确权限的创建（`workerPermissionModeForCreate`，远程创建
同样生效），`choice` 写入的权限与它同值，不新增权限面。

控制端的三种情况（手机 `useOrcaWorkerForm` 与 Desktop `CreateWorkerPopover` 同口径）：

| 被控端 | 控制端的做法 |
| --- | --- |
| 读到了 | 只用它的清单与「上次选择」；创建后写回它；自己这边不读不写 |
| 回 `CHANNEL_NOT_ALLOWED`（版本太旧，没有这组通道） | 只列内置角色、不提供增删；「上次选择」沿用控制端原来的本地记忆（手机 `orcaWorkerPrefs`、Desktop `workerCreationPrefs`），这是给旧被控端留的兼容 |
| 其他失败（还没准备好、连不上、读不懂） | 按首次默认值打开，不改用控制端的本地记忆；创建时仍尝试写回被控端，那时才发现它版本太旧的，这一次按旧办法记在控制端 |

解析侧丢弃不认识的字段；任务为空或超过 `ORCA_WORKER_ROLE_TASK_MAX_LENGTH`、权限不认识时按没记
处理；`defaults` 读不懂时只丢它自己，角色清单照用；角色名超长、重名或超过 `ORCA_WORKER_ROLES_MAX`
时拒绝整份清单。写入从严：`choice` 带了但读不懂就整条拒绝（`INVALID_PARAMS`）。

不新增帧、协议版本、能力位、服务端接口或 Mobile 原生配置；allowlist 指纹随 channel 列表变化，
沿用既有的「对方版本不一致」提示。官方与自建中转都只透传 invoke，无需升级已部署的自建中转。
创建 Worker 本身仍走 `maker:session:enable-orca` / `maker:worker:create` 并在被控端校验，
记忆里的模型路线不是可执行的授权。读写频率：每次打开表单读一次，每次创建或移除写一次；写入不
自动重试，移除失败时控制端重新读一次清单。

回归见 `packages/device-link/src/__tests__/orcaWorkerRoles.test.ts`、
`apps/desktop/src/main/maker-ipc/__tests__/workerCreationPrefsSyncHandler.test.ts`、
`CreateWorkerPopover.test.tsx` 的 `remote task roles` 与被控端一侧的 `applies a change from a phone
or another computer`，以及手机的 `useOrcaWorkerForm.test.tsx`（`worker roles kept on the task
computer`）与 `mobileMakerTransport.test.ts`。
