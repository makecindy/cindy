# 任务运行时控制与自动降级

## 目标

Cindy 允许 Agent 通过统一会话控制面查询和临时调整当前任务或指定任务的模型、来源、
推理强度与 Fast。该能力服务于 Skill 的任务类型路由和故障恢复，不替代用户在界面中保存的
模型偏好。

## 状态模型

每个任务同时维护四类状态：

- `baseline`：用户保存到任务记录的模型、来源、推理强度与 Fast。
- `effective`：当前实际生效的运行时组合；Agent 临时切换和自动降级只改这一层。
- `pending`：已接受但尚未生效的组合；临时调整等当前 turn 结束，显式 Harness 选择等下一条消息发送。
- `generation`：运行时控制面的单调版本。跨任务修改应先读后写并携带 generation，避免旧请求覆盖新选择。

用户在模型选择器中的完整选择会清除临时运行时组合；用户单独修改推理强度或 Fast 时，
该轴立即成为新基线，同时保留仍在使用的临时模型路由。应用重启后只恢复 baseline。

## Agent 控制面

- `get_session_runtime`：`session_id` 可省略；省略时查询当前任务。返回活动状态、baseline、
  effective、pending、generation 和自动降级开关。
- `set_session_runtime`：`session_id` 可省略；原子提交来源、模型、推理强度与 Fast 的任意子集。
- 当前或目标任务忙碌时不修改进行中的 turn，返回 `deferred`，在下一个 turn 边界生效。
- 省略 `harness` 时，Agent 的修改不写回任务 baseline。语义失败是否提高推理强度或换更强模型，由 Agent 或 Skill 明确请求。
- 显式提供 `harness`（`claude-code` / `codex` / `pi`）时必须同时指定 `model`，表示完整的任务执行选择；
  即使选回当前 Harness，也复用模型选择器的完整选择语义。目标模型、来源、推理强度和 Fast 在登记前一起校验，
  省略来源时按目标 Harness 的模型解析默认来源，不沿用旧 Harness 的来源。
- 完整选择返回 `deferred` / `effective_boundary: next_send`，清除此前临时调整；`get_session_runtime.pending`
  显示目标 Harness，`effective` 仍表示当前运行组合。空闲和忙碌任务均在下一条消息发送时消费意图，
  复用现有历史交接与原生绑定切换事务，更新该任务 baseline，但不修改全局默认设置。
  切换失败时保留待切换选择并阻止该次发送，不继续使用旧引擎。
- SSH 远程、Orca、Review 和归档任务不支持此完整选择。存在待切换 Harness 时如需修改目标，
  重新读取 generation 并再次提交完整 `harness` + `model`；普通临时调整不会覆盖待切换选择。

## 自动降级

设置中的“任务模型自动降级”默认关闭。开启后只复用宿主现有的安全自动续跑入口，
即已被白名单识别为连接、超时、过载或容量问题的失败；认证失败、权限拒绝、用户取消、
协议或参数错误不触发。

顺序固定为：

1. 让 Harness 现有的有限重试先处理瞬时故障。
2. 切换到同一模型的其他已连接、未停用来源。
3. 若仍失败，只尝试目录通过 `newSessionDefault` 为当前 Harness 明确声明的模型。

自动降级不采用“可用列表第一个”之类的隐式兜底，不跨 Harness；每个任务最多换路两次，
记录已访问的 `(来源, 模型)`，禁止 `A → B → A` 回环。用户修改运行时选择后立即清空本轮降级轨迹。

## 跨端边界

运行时控制由 Desktop host 独占，MCP、Renderer 与 Device Link 都复用同一原子切换路径。
手机和 SSH 控制端无需新增独立状态机；它们读取任务状态时看到同一 baseline/effective/pending
投影。远程控制的授权边界保持不变。
