# 供应商组：同账号电脑报告经组的用量(2026-10-11)

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`provider-groups.md`](../../product-rules/provider-groups.md) §7。组所在电脑 O 的「用量」块里「自己」要等于全组的总和，
同账号电脑 C 经 O 的组、直接连到组里别的电脑(不是 O 本身)运行的那部分 O 经手不到，由 C 报告。

- **`provider-group:remote` 新增 `action: 'usage'`**(同一 channel、同一同账号 allowlist，受邀者与共享任务访客照旧
  `CHANNEL_NOT_ALLOWED`)：`{ action: 'usage', seq, sinceDay: 'YYYY-MM-DD' | null, rows }` → `{}`。
  - `rows` 每行是数组 `[day, providerId, memberKey, kind, model, turns, inputTokens, outputTokens, cacheReadTokens,
    cacheCreateTokens, sdkCostUsd, lastAt]`，最多 3000 行；供应商与组内电脑都是 O 的坐标(`memberKey` 是 O 组里的稳定键)。
    结构与校验在 `apps/desktop/src/shared/providerGroup.ts`(`parseProviderGroupRemoteRequest`、`providerGroupUsageRowsForWire`)。
  - 语义是整体替换：O 删掉 C 报过的、`sinceDay`(含；null = 全部)起的行，再写入这一份；重复送同一份不多算。`seq` 只增
    (C 以时间生成并以已持久化的上次序号为下限)，同一账号里乱序到达的旧份丢弃；换了账号之后到达的不收。
  - O 丢掉 `memberKey === 'local'` 的行(分到 O 本身的那部分 O 自己记过)；不按此刻有没有组筛，组删了又建时整份报告
    也不会抹掉那几个供应商的历史。
  - C 侧：任务此刻所在电脑与供应商和绑定那台对得上才算经组(绑定没清掉的空档里不报)；每轮记进按账号的账本(`group` 行，
    只用来报告，不算进 C 自己的供应商)，防抖 5s 报从那天起的一份；启动(账号确定)
    后整份报一次补上次没送到的；送不到按 30s 起、最长 10 分钟退避重报，不截断单日或未报告的旧日期。
  - 日期归一：`day` 是报告端本地日期，但接收端按 `lastAt` 在自己的时区重新计算日期；增量请求和替换时各多带两天，
    避免跨时区的午夜边界漏掉或重复历史。
- **超出单次 3000 行或 UTF-8 字节预算时用新动作 `usage-part` 分批传完整报告**：
  - 请求 `{ action: 'usage-part', seq, sinceDay, offset, total, rows }`；每批仍最多 3000 行，整份最多 20000 行，
    同时按实际 JSON 序列化后的 UTF-8 字节数切批（包含转义开销），请求预算取可靠消息/普通帧上限的较小值再预留 64 KiB 给 invoke 头；offset 按实际批次行数推进。
    与按使用方账本的保留上限一致。回包 `{ seq, received, committed }`，`received` 是本批结束的行偏移。
  - O 按账号、报告电脑隔离暂存，每台只留一份；从 offset 0 开始顺序收取，同一份的 seq、sinceDay 和 total 必须一致。
    收齐后才整体替换并登记去重序号。缺批、乱序、暂存过期(10 分钟)或 O 重启都要求 C 从头重报，旧账本不变；
    更新的整份报告可替换未完成的暂存，已提交的旧序号不会重复记账。
  - C 每批发出前重查账号仍有效，回执不足或任一批失败保留重报意图，用新序号从原起始日重新报告；
    故障只作用于这台组所在电脑的这份用量，不重建 link 或 relay，不影响任务及其它控制端。
- **兼容**：
  - 旧 O(认识 `provider-group:remote`、不认识 `usage`)回 `[INVALID_PARAMS] unknown provider group action`，更早的回
    `CHANNEL_NOT_ALLOWED`：C 都按不支持处理，30 分钟后再试，不影响任务；这部分用量在 O 上缺，直到 O 更新。
  - 旧 C 不报：O 上缺这部分，其余照旧。
  - 认识 `usage` 但不认识 `usage-part` 的 O 拒绝新动作；C 按不支持处理并保留完整重报意图，30 分钟后再试，
    不回退成部分 `usage` 报告。行数和字节数都在预算内才继续使用原动作。小报告无需双方同时更新，大报告在 O 更新后补报。
  - `maker:provider:list`、relay、帧限制、服务器与数据库都不变。
  - 降级：已发布的受邀者账本(`provider-share-usage.json`)行键与合计不变，各台组内电脑的分布放在行里的 `byMember`，旧版本
    照常累计合计并原样写回，降级不丢用量(降级期间记的回来后算没区分电脑)。`byMember` 每行保留最多 512 个电脑键；
    满容量后已有电脑继续累计，新电脑只加行合计、查询算没区分电脑；旧文件已超容量时保留前 512 个分布，其余仍计入总量。
    写入、重启和再次落盘都不丢整行分布，回归见 `device-link/__tests__/providerShareUsageStore.test.ts`。按使用方的账本(`provider-usage-by-party.json`)
    还没进正式版：从带这次改动的构建降到它之前的构建时，同一天同模型分在几台电脑的行会合成一行(只剩其中一台的数)，
    `group` / `reported` 行也会被当成「我的其他电脑」，属于已知的降级损失。
- 实现：`apps/desktop/src/main/provider-group/usageReporter.ts`、`usageReportRuntime.ts`、`remoteHandler.ts`(`usage`)、
  `remoteClient.ts`(`usage` / `usage-part`)、`remoteRegistration.ts`，`apps/desktop/src/main/usage/providerPartyUsageStore.ts`
  (`groupReport` / `replaceReported`)，`maker-ipc/sessionProviderPartyUsage.ts`(`groupUsageReportOf`)；回归见
  `provider-group/__tests__/usageReporter.test.ts`、`remoteHandler.test.ts`、`usage/__tests__/providerPartyUsageStore.test.ts`、
  `maker-ipc/__tests__/sessionProviderPartyUsage.test.ts`。
