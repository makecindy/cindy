# 供应商组：同账号任意电脑管理(2026-10-14)

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`provider-groups.md`](../../product-rules/provider-groups.md) §9.8、§10 与
[`provider-sharing.md`](../../product-rules/provider-sharing.md) §4.1 第 4 步、§7.1。同账号电脑 C 管理组所在电脑 O 上的组与分享，
组设置与分享仍保存在 O 上。

- **`provider-group:remote` 新增 `action: 'manage-group'` / `'manage-share'`**(同一 channel、同一同账号 allowlist，
  受邀者与共享任务访客照旧 `CHANNEL_NOT_ALLOWED`)：请求 `{ action, command }`，`command` 与本机命令同构，结构与校验在
  `apps/desktop/src/shared/providerManagement.ts`。`manage-group` 只收 `get` / `candidates` / `save-if-current` / `delete-if-current`；
  `manage-share` 只收 `owned` / `own-usage` / `usage-history` / `create-link` / `approve` / `reject` / `set-member` / `set-member-note` / `reshare-decide` / `get-run-limits` / `set-run-limits` / `reset-run-limits`，其余回
  `[PERMISSION_DENIED]`。回包 `{ result, respondedAt }`，`respondedAt` 只用于把链接有效期换算到 C 的时钟。
  - `usage-history`(2026-10-17，供应商组 §7)：只读，`{ action, providerId }`，回这个供应商用量的按天明细
    `{ providerId, todayKey, coverageStart, self, relays, members }`(结构在 `apps/desktop/src/shared/providerShare.ts`)，
    日期是 O 的本地日期，金额在 O 上估算；`members` 只含 O 上这个供应商的分享里现在的成员。最多 5,000 行，按日期从新到旧
    截取，最新一天允许只保留一部分，再按实际 UTF-8 JSON 字节数裁剪，均用 `coverageStart` 标出保留下来的最早日期，
    整包为单帧 2MB 预留 invoke 信封空间。旧 O 不认识该动作，`parseProviderShareCommand` 回
    `[INVALID_PARAMS] Unknown command`，C 的 Main 把 `manage-share` 的这个回包统一成 `[UNSUPPORTED_CAPABILITY]`(与
    `unknown provider group action` 同一处)，管理页退回 `own-usage` 与 `owned`(range=all)的所有时间合计并提示更新 O，不重试。
    旧 C 不发这个动作，照旧读 `own-usage` / `owned`，O 对两者的回包不变。
  - `set-member-note`（2026-10-19）：`{ action, memberId, note }`，只允许已有成员，空字符串清除备注，最多 80 个 UTF-16 单元、保存前规范为单行。
    O 按账号保存私人备注，`owned` 的成员投影新增可选 `note: string | null`，不改服务端成员合同或受邀者目录。
    旧 C 忽略新增字段；旧 O 不认识命令时沿用 `INVALID_PARAMS → UNSUPPORTED_CAPABILITY` 映射，C 保留草稿、提示更新，不重放或改存本机。
  - O 在执行前后核对账号未切换；`approve` / `reject` / `set-member` 先刷新快照，申请或成员不在 O 的分享里回 `[NOT_FOUND]`；
    `owned` 的回包只含 `{ ready, shares }`，不带 O 自己的弹窗安排。不再转发给第三台电脑。
  - `reshare-decide` 只修改 O 当前账号的本机转分享记录，写锁内和返回前继续核对账号边界；撤回由 O 停止对应中转任务。
    旧 O 不认识该动作时明确拒绝，C 不重试、不改为在本机执行；完整转分享管理需要 O 更新。
    远程修改组后由 O 刷新转分享名单，逐人同意明细仍只附在 O 本机设置页的组视图里。
  - C 不重放写请求；生成的链接在 C 的 Main 登记后才能复制。
  - 添加组所在电脑已可用的供应商仍经 `candidates` 查询；受邀者预览和申请不在管理通道内。远程管理页的分享链接入口
    禁用并引导在 O 的模型供应商设置中输入，获批后回到可用列表添加，避免申请与跨区启用记录误落到 C。
  - 组保存与删除必须携带编辑时的 `expectedConfig`（完整组配置，`null` = 当时尚未建组）。O 在已有跨进程文件写锁内
    重读并比较，不一致回 `[PROVIDER_GROUP_CHANGED]`，不写入、不清理任务绑定。C 重新读取详情、提示本次操作未执行，
    不自动重试写入。建组电脑自己的设置页使用同一条件写入，存储格式不变。
    独立动作名保证旧 O 明确拒绝，不能忽略新增条件后无条件写入；新 O 拒绝旧 C 的 `save` / `delete`，回
    `[UNSUPPORTED_CAPABILITY]`。完整编辑需两端更新；只读查询、分享者操作与组的分配使用不受影响。
- **审批弹窗跟着生成链接的电脑**：服务端 `POST /links` 与 owner 列表的每条申请追加 `linkId`（一次性随机邀请口令的
  SHA-256 小写十六进制摘要，不是邀请口令）。O 执行 `manage-share` 的 `create-link` 后，7 分钟窗口内这条链接的新申请在 O 上只推
  `REQUESTED { quiet: true }`(进管理页与提示点，不弹窗、不发系统通知)。O 本机生成链接只清除旧版按供应商静默的窗口，
  保留其它链接的精确归属；C 的关注也按 O + 供应商 + linkId 匹配，不能接管本机或第三台电脑生成的链接。C 在同一窗口内经
  `manage-share owned` 向 O 读取分享申请，不能从 C 的 REST 分享列表找 O 的申请（服务端按当前设备隔离列表）。
  新申请经 `REQUESTED { hostDeviceId }` 在 C 上弹窗，同意 / 拒绝经 `manage-share` 转交 O。
  本机与每台关注电脑各自只保留一个在途读取；一台离线或迟迟不回包时，其他电脑与本机照常继续拉取，不重建 link 或 relay。
  失败或 `ready=false` 不当作空名单清理待审批申请，成功快照只清理对应电脑的申请；账号切换或运行时重建后的旧回包作废。
  同账号重连保留窗口期内的关注与去重状态，即使 C 本机没有分享也继续拉取。
  归属按账号保存，完整进程重启时在第一轮快照之前恢复；旧版无 linkId 的关注只接无标识的旧申请。
  这两个字段只在本机 Main → Renderer 之间，不跨设备；本机 `owned` 结果另带 `quietRequestIds` / `watchedRequests` 供审批宿主重载时使用。
- **兼容**：旧 O 回 `CHANNEL_NOT_ALLOWED` 或 `[INVALID_PARAMS] unknown provider group action`，C 显示「建组电脑需要更新」，
  不影响组的分配与使用。旧 C 不发这两个动作，仍只能只读查看。O 只在执行过 `manage-share` 的 `create-link` 后才静默，
  旧 C 管不到 O，弹窗行为与之前相同。linkId 是 additive 字段，旧客户端忽略；新客户端本机生成及读取仍接受缺字段的旧服务端。
  跨电脑生成必须收到合法 linkId，O 在返回/登记链接前检查，C 在保存关注/登记复制前再次检查；缺字段回
  `[UNSUPPORTED_CAPABILITY]` 提示更新，非法字段拒绝，不回退到按供应商关注，不重放写请求。服务端先部署到供应商所属区域
  的全部副本，再发布客户端；完整精确归属要求 O、C 都更新。服务端仅返回已有摘要，无数据库 migration、鉴权或 relay 帧变化。
  本机绑定的可选解除记录见 [P2a](provider-group-same-account-direct.md)「本地数据」。
- 实现：`apps/desktop/src/main/provider-group/management.ts`(O)、`managementClient.ts`(C)、`remoteRegistration.ts`，
  `apps/desktop/src/main/device-link/providerShareHost.ts`(静默与关注)、`providerShareRuntime.ts`；回归见
  `provider-group/__tests__/{managementClient,ipc,stores}.test.ts`、`device-link/__tests__/providerShareRuntime.test.ts`、
  `renderer/features/provider-share/__tests__/ProviderShareGlobalHost.test.tsx`、`providerShareFormat.test.ts`。
