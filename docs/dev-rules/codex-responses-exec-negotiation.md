# Codex Responses exec 格式协商

## 最小方案与责任边界

2026-11-13：基于 main `6d4c58d6e0` 核对已合并 #10370。`user-provider.ts`
的 `toRouting` 与 `provider-route.ts` 的 `providerRoutingForModel` 把未知 custom-tool
能力补成 false，导致首次请求无法保留原生 exec。删除这两处推定值，保留目录/路由明确
声明的 true/false 与 oauth-passthrough 原生路径。

协商属于执行端 `maker-host/codex-proxy-host.ts` 的 Responses 请求：未知能力、非原生订阅、
有效 Responses 路径且带 custom exec 时，先 raw，完整 HTTP 400 拒绝后切 function 一次。
复用 model-compat 的 Codex 双向适配器，声明、tool_choice、历史调用/结果与 JSON/SSE 一起
转换。每次从同一份未转换的出站快照生成，响应先还原再判断成功。

namespace 能力与 exec 独立：原有已知端点继续做 namespace 转换，未知 exec 保持原生。
两层适配分别持有请求状态，响应按逆序还原；供应商 dialect sanitizer 不提前丢弃未知 exec，
包装仍转发原 errorMode 与 settlement 回调。权限/工具策略原有边界保持在包装之外。

代理只增加路由专属 recovery rules 的接线及 HTTP 状态过滤；沿用现有 `canRetry=false`
预算与 dispatch generation 检查。协商请求替换其它 body recovery rules，避免重试相乘。
401/403/422/429、超时、断线及任何 2xx 流式输出均不切换。第二次失败返回真实错误。
不改 Codex Chat、Pi、Claude Code、服务端、账号配置、模型选择或调度。

成功方式只存在本 proxy 生命周期的有界内存缓存（最多 256 项、15 分钟 TTL）。Cindy owner
与登录代次、连接 ID、
配置/凭证代次、规范化有效端点与路径、协议、最终 wire model 和实际鉴权身份共同隔离；
凭证参与带随机进程密钥的 HMAC，不落盘、不输出缓存键。配置变化不复用旧项；迟到响应
仍须通过 dispatch generation 检查。缓存命中的方式遇完整 400 时失效，再尝试另一格式一次；
两者均失败保持未知。超时/断线不触发重新协商。

HTTP 200 本身不构成成功。仅在还原后的有效 Responses JSON 完成，或 SSE 完整结束且含
有效 response.completed 后记录方式；无效、截断、出错或无法还原不记。该缓存证明格式被
接受，不声称真实工具执行成功；完整工具往返另由续接回归证明。
协商请求声明 `accept-encoding: identity` 以复用既有明文 JSON/SSE 双向适配器；上游仍返回
压缩体时不把无法验证的响应记成成功。

## 文件范围与定向验证

- 路由：上述两处缺省与已有 user-provider/providerRoute 测试。
- 执行：Codex 请求专属协商模块及 codex-proxy-host 接线；共享 Codex wrapper 增加独立的
  custom-tool 转换开关，复用原有双向转换算法。
- 代理：RoutingDecision 的请求专属规则与 RecoveryRule 状态过滤，不增加重试层。
- 回归：复用 codexProxyHost、codexExecFunctionAdapter.e2e 与共享适配测试；最小失败输入为
  未知 Responses 路由携带 exec，raw 返回 400、function 返回有效回答。修前应失败。
- 覆盖 raw 成功、切换与缓存、两次失败、身份/端点隔离、失效、非 400 与中断不重发、
  SSE/JSON 还原和历史结果续接、明确能力与原生对照。
- 运行受影响包类型检查、Desktop 定向回归及 Host 测试/类型检查；真实供应商验证与本地
  fixture 分开记录。不启动或重启任何日常实例。

本改动只在执行端到模型 HTTP 接口内工作；设备互联与自建 relay 继续透传原有任务调用，
不新增 wire 字段、channel 或 relay 行为，无需同步修改 relay。

## 回归证据（2026-11-13）

修前：`user-provider` 的未知能力断言收到 false；真实 HTTP 的首次出站记录只有
function，缺少要求的 raw。修后分别通过。

| 入口 | 结果与耗时 |
| --- | --- |
| Desktop `codexProxyHost` / `providerRoute` / `codexExecFunctionAdapter.e2e` | 481 通过，12.94 秒；其中前两文件分别 373/107 项 |
| 原生 Codex E2E 最终增量 | 1 通过，2.81 秒：保留原生默认重试设置；raw 400 后执行命令、结果回传、缓存续接；下一回合 function/raw 均 400 后停止且命令不重跑 |
| `@cindy/model-compat test` | 253 通过，0.985 秒，含 namespace 与未知 exec 两层还原 |
| `@cindy/anthropic-compat-proxy test` | 574 通过，7.33 秒 |
| `@cindy/model-providers test` | 1877 通过，9.00 秒 |
| `@cindy/host test` | 最终复跑 282 通过，18.65 秒 |

Desktop、Host 及共享包类型检查（model-compat / anthropic-compat-proxy 的 `typecheck`、
model-providers 的 `build`，均为 `tsc --noEmit`）通过。Host 默认堆上限首轮报
`JavaScript heap out of memory` / `SIGABRT`；仅为检查进程指定
`NODE_OPTIONS=--max-old-space-size=12288` 后通过，不修改运行配置或仓库脚本。
文档检查 11 项通过，`check:test-hygiene` 与整体 `git diff --check` 通过。

测试价值：`user-provider` / `providerRoute` 保护真实路由的未知/明确能力区别；
`codexProxyHost` 通过生产代理验证完整 400、非 400、中断、已有输出、缓存键隔离、TTL、
容量、代次与迟到响应；其已有大量回归与 loopback fixture 整文件耗时 9.52 秒（373 项），
本次不另开小测试文件。共享 compatibility 测试用两个真实适配器验证原生 exec 与 namespace
独立；E2E 使用随仓 Codex 和隔离临时 HOME/workdir，验证协议还原后确实只执行一次命令。
上述测试分别属于已有 unit/loopback 与 E2E 入口，不读取私人 profile 或访问真实模型账号。

代理的 400 recovery 共用一次 `canRetry` 预算；Codex 既有 WS body recovery 还要求同 thread
存在可定位/已证明的 WS 连接，普通自定义 Responses 不提供此 WS 路由。本改动不添加 turn
重投机制，不修改原生 harness 的重试设置。

未执行真实 Kimi 账号、Windows 实机与独立 reviewer 验收；旧 #10370 测试包不包含本补丁。
提交与测试包状态以对应 PR 的实际回执为准；真实账号验收完成前保持 Draft。
