# 伙伴学习保存回执

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

消息 `agent_meta` 追加可选 `botLearning` 数组，仅承载已保存的记忆/技能标题、类型、稳定键与新建/更新动作。
执行宿主沿用 `local-db:messages:created` 广播完整原消息更新；桌面和手机只在该消息正文底部呈现两行。
旧端忽略字段，新端对无字段历史不推测保存结果。不新增远程 channel、数据库 schema、服务端能力或原生指纹。
桌面能力页新增仅限可信本地 renderer 的 `local-db:bots:skills:list` 读取伙伴自有技能；
远程端继续使用已有 `settings:<botId>/skills` 资源，不扩 IPC allowlist。
SSH 继续沿用现有伙伴远端技能限制，不读取控制端本机资料；设备互联由执行宿主保存与复盘。
