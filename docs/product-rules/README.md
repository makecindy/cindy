# 产品规则

这里存放 Cindy 客户端必须长期保持的产品行为、用户体验和跨端一致性要求。

## 收录标准

- 规则说明“用户应该得到什么结果”以及“哪些产品行为不能被破坏”。
- 每条规则应写清适用场景、产品不变量、原因、验收方法和允许的例外。
- 具体代码写法、命令和测试实现放到 `docs/dev-rules/`，不要与产品目标混写。
- 临时需求、待办事项和已经有正式跟踪的问题不作为永久产品规则。

## 当前规则

- [`core-product-principles.md`](core-product-principles.md)：Cindy 的目的、连接本质、
  Core 边界，以及 Agent、Skill、插件的产品分工。
- [`review-product-direction.md`](review-product-direction.md)：Cindy Review 的北极星、
  通用成果复核定义、运行与证据原则、当前边界、后续路线和待确认事项。
- [`region-and-editions.md`](region-and-editions.md)：Global 与中国大陆版的关系、
  身份命名与默认值方向、区域相关 UI 标注与对外口径。
- [`task-and-conversation-naming.md`](task-and-conversation-naming.md)：`session` 的中文
  叫「任务」，任务 / 对话 / 消息的分层定义与判定规则，以及「任务」与 `task` 的歧义处理。
- [`document-workshop-quality.md`](document-workshop-quality.md)：无插件文档基础能力的
  HTML-first 工序、四格式统一视觉语言、Session 作品卡和插件增强层边界。
- [`session-runtime-control.md`](session-runtime-control.md)：Agent 调整任务模型、来源、
  推理强度与 Fast 的统一控制面，baseline/effective/pending 状态和自动降级边界。
