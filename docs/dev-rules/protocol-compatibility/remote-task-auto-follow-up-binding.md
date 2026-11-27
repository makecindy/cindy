# 远程任务自动跟进绑定

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Desktop 的任务行、置顶卡片与任务顶部通过既有 `maker:schedule:list` 读取当前绑定。
请求第二个参数可带 `{ sessionBindings: true }`；新主机在隧道序列化前只保留未过期且有
`targetSessionId` 的条目，以及 `id/name/status/targetSessionId/cronExpr/manual/recurring/intervalMs`
显示字段，避免完整 prompt、脚本和执行配置占用消息预算。第一参数仍是原有列表过滤器。
不截断绑定列表，投影后仍受原有隧道消息大小限制。

旧主机忽略第二参数，控制端兼容完整数组并在本地投影；旧主机的超大完整列表仍可能超过
传输限制，此时保留已有镜像，后续既有 push／重连重新读取。旧控制端、Mobile 与本机未声明
该选项时仍获取原有完整列表，不增加 channel、权限、relay 类型或服务端发布依赖。
手动、单次与相对间隔优先于兼容 Cron 占位值。远程绑定只显示提示，不跳到本机管理页。
