# 任务搜索显式查询语法

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

既有 `local-db:conversations:search` 继续使用字符串 `query`。成对英文双引号或
中文双引号限定连续文本；空格分隔的独立 `+` 要求全部关键词命中同一条可见消息。
标题独立匹配，不能跨标题与正文、跨多条消息拼接。普通输入保留既有搜索行为。
显式查询只匹配标题或消息正文，不用项目别名充当内容命中。

响应新增可选 `querySyntaxVersion: 1`，表示 Host 已按显式语法验证结果。
旧控制端忽略此字段；新控制端收到缺字段的显式查询响应时，对每个标题、每条消息
预览或摘要分别验证，只保留可证明的命中，并通过既有 `poolCapped` 提示结果可能不完整。
摘要无法证明全文没有命中，因此旧 Host 的完整搜索需要升级；普通查询不经过该回退。
Desktop 和 Mobile 使用同一校验函数。缓存结果同样不跨标题与消息预览拼接。

内容召回仍使用既有 FTS 分词索引，再验证可见正文的连续文本；不支持任意词内子串
召回（例如 `Error` 不保证召回 `TypeError`，日文连续假名同理）。每次最多读取
5 页、每页 200 个候选，达到上限时展示不完整提示。无索引迁移或用户数据写入。

不新增 channel、IPC allowlist、授权边界、relay kind 或原生依赖；自建中转继续
透明传输原业务 payload，无需服务端同步适配。共享类型允许 Desktop 既有本机
`companion.role: 'channel'`，远程 Host 的渠道专线排除条件保持不变。

回归入口：`packages/maker-shared/src/__tests__/conversationSearch.test.ts` 验证
旧响应、新回显与普通查询兼容；Desktop `localDb/__tests__/conversationSearch.test.ts`
通过真实 SQLite 搜索入口验证同消息限定、排序、隐藏字段与候选上限。
