# 供应商组：转分享需原主人逐人同意(2026-10-15)

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`provider-sharing.md`](../../product-rules/provider-sharing.md) §4.3 与 [`provider-groups.md`](../../product-rules/provider-groups.md)
§4。组所在电脑 O 的组里有分享来的组内电脑 M(O 的账号是 M 的受邀者)，O 又把组所在的供应商分享给了 G：G 的任务要经 O 中转到
M 上运行，必须先由 M 的主人逐人同意(按 G 的账号，不按设备)。O 与 M 之间沿用 `maker:remote-agent:v1`，新增三项可选内容；
G 与 O 之间不变。受邀者能调用的 channel 不变(仍是 `maker:remote-agent:v1` 的新 op，不改 `PROVIDER_SHARE_CHANNELS`、
`REMOTE_INVOKE_ALLOWLIST` 与 allowlist 哈希)。

- **caps 新增可选 `reshareConsent: true`**(`RemoteAgentCaps`，`parseRemoteAgentCaps` 白名单只认 `true`)：M 能记下并核对转分享的
  同意。只回给受邀者对端(同账号控制端经组使用不需要同意)。O 只给声明了它的 M 报人；未声明的旧 M 给不出同意，O 不把受邀者的
  任务分给它，设置页提示那台需要更新。O 在每次 open 前现查(含绕过分配的已有绑定续接)，不能沿用降级前的能力或同意缓存。
- **新 op `reshare { entries: [{ key, name, avatar? }] }`**(`parseRemoteAgentRequest`)：O 把它此刻分享的人整体报给 M(整体替换
  调用方上一份；调用方按本地 peer key 的(分享、成员、设备)区分)。`key` 是 O 按(O 的分享 id, G 的成员 id)派生的不透明键(格式同
  `REMOTE_AGENT_RELAY_KEY_PATTERN`，同一个人从哪台设备来都相同)；`name`(≤128 字符，无控制字符)与 `avatar`(只收 https)由 O 转述，
  只用来让 M 的主人认出是谁。最多 256 项、键不能重复。回包 `{ entries: [{ key, state: 'pending' | 'approved' | 'rejected' }] }`
  (`parseRemoteAgentReshareResult`，不认识的状态与请求外的键丢弃)。M 只接受受邀者对端，其他调用方回 `REMOTE_AGENT_INVALID`；旧 M
  不认识这个 op 同样回 `REMOTE_AGENT_INVALID`。替换语义使重复发送安全；O 只在本机分享快照已拉到时才报，避免空名单清掉已有同意。
  单次请求上限是 wire 防护，不是分享人数上限：超过 256 人时，O 先从 M 的 caps 读取 `reshareBatch: true`，再用不透明的
  `batch: { id, index, count }` 按 256 人分片顺序发送；每片响应只带当前片的状态、同一批次信息与 `complete`，最后一片才表示接收端已整体替换。
  M 可以乱序接收并在内存暂存，缺片或未收齐时保留上一份已落盘审批名单；未完成批次 10 分钟后过期，新批次替换同一来源的旧批次。
  批次数不设按人数的固定上限，接收端按序列化字节总预算限制未完成批次，超预算返回可重试的忙碌错误；已完成批次在过期前对重复片段回同一完成状态，避免重试重新创建待处理批次。
  没有 `reshareBatch` 的旧 M 不能安全接收大名单，O 标记需要更新且不发送任何部分名单。
- **open 载荷新增可选 `reshareKey`**(`remote-agent/wire.ts`，同 relay 键格式)：O 把受邀者任务转给分享来的 M 时带上这个人的键
  (同账号组内电脑不带；G 自己填的不转发)。M 收到受邀者对端带 `relay` 的 open(即被转来的任务，含续接)时，只有主人同意过
  (调用方, `reshareKey`)才运行：带了 `reshareKey` 而没同意回新错误码 `REMOTE_AGENT_RESHARE_NOT_ALLOWED`(带这个字段即表示 O 认识它)；
  没带(旧 O)回已有的 `REMOTE_AGENT_PROVIDER_NOT_ALLOWED`，旧 O 照常换组里下一台、转给 G 时统一成「暂时不可用」。
  主人撤回同意时 M 立即结束这个人经组转来的任务；M 在所有异步查询结束后、登记任务前再次核对同意，核对与登记之间不等待。
  O 收到 `REMOTE_AGENT_RESHARE_NOT_ALLOWED` 时重新核对同意情况，之后不再选它。
- O 移出最后一个组引用时，在本机组设置里原子记下待清空代次；`reshare` 空名单得到有效回包后才删除该代次，失败与普通同步一起按
  1、1、5、10、20、30 分钟退避(上限 30 分钟)，重复快照和组详情读取不能穿透；成功重置，观察到对端恢复在线只唤醒那台。
  暂停分享或完整可信名单确认分享已删除时不发同步，未确认的清理代次仍保留；`ACCESS_REVOKED` 本身不是永久删除证据。
  重启后继续。重新加入时先清空再报人；迟到的确认不能吞掉再次移出的新代次。不新增 wire 字段，沿用整体替换的幂等语义。
- O 给 G 的匿名组状态(`groupStatus`)里，没同意过 G 的分享来的电脑显示 `unavailable`(那台给不出同意时 `needs-update`)，与实际
  分配一致；`groupSize` 不变。
- 已知局限：M 只能按 O 自报的 `relay` 认出被转来的任务；改过的 O 不带 `relay` 时 M 分不出(防误分享，不防恶意，与供应商分享
  「默认信任分享对象」一致)。更早的 O(P2b 之前)不带 `relay`，M 同样分不出。
- 不改 relay、服务器与数据库(M 的同意记录在本机 `provider-share-reshare.json`)。实现：`packages/device-link/src/remoteAgent.ts`、
  `remote-agent/host/runHost.ts`、`host/groupRelay.ts`(`reshareKeyFor`)、`device-link/providerShareReshare.ts`(M 侧记录)、
  `provider-group/reshare.ts` 与 `reshareRuntime.ts`(O 侧报人与缓存)、`provider-group/guestRelay.ts`(选电脑)；回归见
  `packages/device-link/src/__tests__/remoteAgent.test.ts`、`remote-agent/__tests__/groupRelay.test.ts`、
  `provider-group/__tests__/reshare.test.ts`、`guestRelay.test.ts`、`device-link/__tests__/providerShareReshare.test.ts`。
