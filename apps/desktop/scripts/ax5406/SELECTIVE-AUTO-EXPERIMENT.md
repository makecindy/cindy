# #5406：保留历史消息 auto 的方案 2 实验

2026-10-03。用户要求保持消息数量，并先尝试“历史消息 auto、更新中消息 visible”。
本轮只修改隔离实验，不替换此前的生产 CSS 止崩补丁，不提交或发布。

## 方法和边界

- 同一真实 MessageStream 编译产物 `cindy-ax5406-riCfWK`，Electron 41.10.3，80 条合成消息，
  40 条 user / 40 条 assistant，每帧更新 8 次助手文本，每 12 帧随机滚动。
- `--policy=auto` 给所有行恢复 auto / auto 240px，用作阳性对照。
- `--policy=active` 在 fixture 中生成 CSS，给 `isStreaming` 消息的既有
  `data-message-client-id` 外层行设置 visible / none，历史行保持 auto / auto 240px。
  样式与消息状态在同一次 React commit 更新；不是在消息更新后异步切换样式。
- 每次 fixture commit 检查所有行的计算样式，记录 `activeAuto` 和 `maxActiveAuto`。
  这会增加诊断读操作，所以阳性对照也执行相同检查。
- steady 工作负载中所有助手消息始终 streaming；cycle 每 120 帧的后 30 帧将其设为
  settled 并停止文本更新，恢复 auto，随后再次开始 streaming。滚动始终继续。
- cycle 同时触发真实 AssistantMessage 的完成态切换；它不是只改 CSS、不改组件状态。
- 这是压力原型，尚未覆盖生产中的工具卡、思考块、嵌套伙伴消息、图片/图表异步展开等全部变动来源。
  用 `isStreaming` 标记更新范围的充分性仍需专项验证。

## 结果

| 策略 / 工作负载 | 查询方式 / seed | 结果 | 文本更新数 | 产物目录后缀 |
|---|---|---|---:|---|
| active / steady | 无主动查询 / 5407 | 120,512ms 无崩溃 | 9,960 | riCfWK |
| active / cycle | 无主动查询 / 5407 | 120,182ms 无崩溃 | 8,696 | IhxbLt |
| auto / cycle | 无主动查询 / 5407 | 4,626ms 命中原签名 | 256 | YDNdbe |
| active / cycle | 原生 UIA + CDP / 5406 | 120,241ms 无崩溃 | 7,480 | yyq0k9 |

三轮 active 测试累计 26,136 次文本更新，在更新阶段均为 40 行 auto、40 行 visible，`maxActiveAuto=0`；
cycle 记录到 360 次 settled commit，覆盖约 12 个完整结束/恢复周期。
所有正常完成的测试均无 JS 错误、保留 80 行。
第三轮记录 160 次 CDP 完整树查询、542 次原生 UIA 文本范围查询，查询错误为 0，
并记录 300 次 settled commit。全部实验进程已退出，临时 profile 已清理。

阳性对照签名为 `0x80000003`、`0xA332D17`、
PDB `D4DDA3CA101D876E4C4C44205044422E1`。同构建、同诊断读操作依然能复现，
因此不能把 active 测试不崩仅归因于新实验的测量开销。

此结果支持方案 2 值得继续验证，**不等于完整生产实现已安全**。特别是历史消息内部也会有
异步布局变化，只按 isStreaming 分类不能预先认定已覆盖这些变化。
本轮未做性能基准，不能用这些压力实验的 FCP 声称已收回之前的 236ms。

## 官方和社区调查

- [GitHub Copilot 社区报告 #4492](https://github.com/github/copilot-cli/issues/4492)
  报告同一个 Blink 函数和普通文本缺失 LayoutObject 的断言。报告者的绕过方式是关闭
  renderer accessibility，代价是损失辅助功能；关闭 AccessibilityBlockFlowIterator
  则转成另一条路径的空指针崩溃。这是第三方报告，不是 Cindy 的实验结果，不能将两者所有触发条件等同。
- 本轮检索未确认到覆盖当前复现的 Chromium / Electron 官方修复版本。
  [Chromium 主干源码](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/accessibility/ax_block_flow_iterator.cc)
  仍有该 CHECK；断言仍在不等于新版一定可崩，仍需用同一用例验证上游候选版本。
- 方案 2 是本地候选绕过策略，不是已确认的官方建议。

## 复跑

```powershell
node apps/desktop/scripts/ax5406/run.mjs --scenario=component --seconds=120 --ax=on --query=none --rows=80 --batch=8 --target=assistant --scroll=on --seed=5407 --policy=active --workload=cycle
```

阳性对照将 `--policy=active` 改为 `--policy=auto`。
复用已构建产物可追加 `--component-build=C:/Users/User/AppData/Local/Temp/cindy-ax5406-riCfWK`。
两个新参数默认值为 `production` 和 `steady`，不改变此前实验的默认策略。
全部报告、dump、截图及官方符号都保存在系统临时目录，未上传。
