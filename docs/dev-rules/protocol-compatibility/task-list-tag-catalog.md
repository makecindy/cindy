# 任务列表标签目录

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`sessions:list` 第三个参数可追加 `tagCatalog: 1`。支持的主机仅对该请求返回
`{ format: 'session-tag-catalog-v1', sessions, tags }`；任务行的 `tagIds` 是响应内
目录索引，保留全部任务、标签与顺序。共享 DeviceLinkClient 解包后，上层仍读取原数组。
新控制端兼容旧主机的数组回复；旧控制端不声明此字段，新主机仍返回数组。
缓存／outbox 重发先解包并重新检查任务可见性，再从可见行生成目录，不能残留隐藏任务的标签。
此扩展不改变 relay、帧限制或服务器权限，也不靠截断数据降低体积。

标签的可选 `nameCustomized` 标记区分显式改名与预设本地化。新版更新请求仅在明确改名时
提交 `nameCustomized: true`；旧端换色时携带相同原名不会误置标记。缺省字段沿用旧显示规则。
