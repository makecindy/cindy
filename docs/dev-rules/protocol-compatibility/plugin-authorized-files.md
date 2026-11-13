# 插件授权目录与文件操作

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

- 文件管子在原 `fs-request` 上追加 `workdir` 的 read/list/delete/watch/changes/unwatch。
  监听请求使用可选 `watchId` / `cursor`，结果为相对路径元数据与 `resetRequired`；list 条目可选增加
  `type`。旧私有目录、save 票据和 write 回执不变，不修改 manifest schema 或 receipt 版本。
  老宿主会拒绝新增 op，插件须处理 `ok:false`，不能从没有事件推定未发生变化。执行仍在任务电脑，
  控制端不解析绝对路径；此增量不增加 device-link 帧或 channel，官方与自建中转透传原页面请求即可。

`files` 增量复用同一组批准事实。`pick-request.access:'files'` 成功时返回可选 `directoryRef`；
`fs-request.root:'picked'` 只接受该 Host 签发的同实例引用。旧 pick 路径没有新增访问权，未知组也不补批准。
原亲选目录文件仅增量增加可选 roots 记录，grants 原结构及 errand 语义保持；换源归档同时搬移两类事实。
helper `file_request` 沿用公共工具通道，不改变 `cindy.host.call`、管子请求或调用方身份签名；
旧 Host 不支持新 root/op 时明确失败。没有新远控 channel 或 relay payload，手机不把控制端目录当成执行端目录。
