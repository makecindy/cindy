# Device Link 确认重试测试的 Windows 稳定性设计

## 背景

`packages/device-link/src/__tests__/client.test.ts` 的「确认 ACK 丢失后自动有界重发」用例在
Windows CI 上重复超时。该用例使用 20ms 真实定时器驱动确认重试，同时用
`MemoryRelay.settleUntil` 的 3 秒墙钟等待 host 进入 ready。Linux 及本地通过，而 Windows
runner 在高负载下可能推迟真实定时器，使测试等待耗尽。失败没有证据指向生产状态机错误。

## 方案选择

采用 Vitest fake timers，仅确定化这条测试的重试时序。测试主动推进到下一次 20ms 重试，
relay 仍负责投递协议帧。保持以下协议不变量：

1. controller 发出的首个、带当前 `linkRequestId` 的确认 ACK 被丢弃；
2. controller 无需等待后续业务流量，便按既有间隔重发确认 ACK；
3. host 收到后续确认后进入 ready，`openLink` 正常完成；
4. 发送业务流量前，定时确认的送达次数不超过首包丢失后的剩余重试预算，且全部属于同一个
   request 代际；
5. ready 后的可靠业务调用仍可往返完成；业务 ACK 可以正常刷新同代际确认，但不计入上述
   定时重试预算。

不采用两个替代方案：单纯增加 `settleUntil` 超时只会放宽墙钟并掩盖调度抖动；修改生产重试
状态机则会扩大风险面，目前没有确定性复现证明它存在缺陷。

## 测试结构与清理

用例在创建 client 前启用 fake timers，并在 `finally` 中停止两个 client、注销 frame
listener、恢复真实定时器。`MemoryRelay.settle()` 增加一个仅供测试选择的 yield 参数，默认仍
使用原来的零延迟 `setTimeout`；该用例传入 `Promise.resolve()` 作为微任务 yield，使 relay
排空不依赖 fake clock。连接启动时只用 `vi.advanceTimersByTimeAsync(0)` 触发 websocket 的
零延迟 open；需要触发确认重试时才单独推进 20ms，随后使用微任务模式排空 relay。这样不调用
依赖墙钟轮询的 `settleUntil`，也不使用会把周期性 ping 等长生命周期任务一起跑完的
`runAllTimersAsync()`。

如果推进一个重试间隔后 host 仍未 ready，测试直接失败并保留协议帧断言；不再依赖 3 秒墙钟
超时提供失败信号。

## 兼容性与故障半径

- 触发条件：测试环境的单个确认重试定时器被 Windows 调度推迟，不是线上 peer、relay 连接
  或聚合背压故障。
- 恢复动作：仅替换测试时钟的驱动方式，不改变生产恢复动作、协议帧、重试预算或超时默认值。
- 多 peer：生产逻辑零改动，因此不会改变 1:N 拓扑中其他 peer 的行为；现有多 peer 隔离用例
  继续由 package 全量测试覆盖，本修复无需新增生产恢复路径用例。

## 验证

1. 定向重复运行该测试，确认无墙钟竞态；
2. 运行 `packages/device-link` 全量单测；
3. 运行根目录 `pnpm test:unit:related`；
4. 运行 `pnpm --filter @cindy/device-link run --if-present typecheck`（以实际 package name
   为准）；
5. review 最终 diff，确认没有生产代码与通用超时变化。
