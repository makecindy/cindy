# Pi 上下文来源估算（2026-11-05，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:get-context-usage` 沿用原通道，仅增加可选 `textEstimate`：
`{method:"text-heuristic",items:[{source,tokens}]}`。它是文字粗估，独立于原生总量；
Desktop 与 Mobile 明确标注估算和排除项。旧端忽略可选字段，新端收到缺字段或未知 method
时只显示原有总量，不要求双端同时升级。返回值不含模型上下文正文或工具定义正文。
