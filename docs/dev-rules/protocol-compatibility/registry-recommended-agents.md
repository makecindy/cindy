# 推荐引擎下发（`registryRecommendedAgents`，2026-10-30）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

- Registry V6 新增可选 `recommendedAgents`：`{ providerId, modelIdPrefix?, agent }` 规则表，正本在 Server
  `source/registry/recommended-agents.json`。已发布的 V6 解析器拒绝未知字段，所以它走独立能力位：
  新客户端请求带 `registryRecommendedAgents=1`；Server 对未带该参数的请求（含旧 V6 客户端）去掉字段，
  ETag 按实际响应隔离。V1–V5 投影一律不含此字段。
- 客户端只把它当建议：解析后投影成 `CatalogModel.recommendedAgent`，用于默认选中引擎；不改变模型成员、
  可见性与用户已换过的引擎。推荐的引擎在该来源只能走本地兼容转换时不采用，回退到协议推断。
- 离线回退：升级后首次请求失败时，仍可读取升级前按旧 URL（不带新能力位，或 V5）缓存的 last-known-good
  快照；此时没有推荐表，按协议推断兜底，不报错。
- 字段位于目录 HTTP 响应内，不涉及 device-link、relay 或远控 wire；手机端经现有活动目录投影拿到结果。
