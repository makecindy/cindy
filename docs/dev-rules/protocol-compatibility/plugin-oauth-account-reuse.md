# 插件复用已有 OAuth 账号

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

- OAuth 账号清单增量增加 Host 私有的 `reused` 账号引用，`/oauth` 账号视图可带
  `reused:true`（不含来源凭证），插件原有列表/默认/断开调用保持兼容。普通账号字段、
  刷新路径与 manifest 不变，旧账号无需迁移或重配。引用账号需要新 Host；旧 Host 不识别
  引用时原来源的凭证仍保留，不得将其复制进受用插件作为回退。此项不新增 grant 账本。
  新增本机 `ghosts:reusable-accounts` / `ghosts:reuse-account` IPC，仅接受 Cindy 可信主界面，
  不进入 device-link allowlist 或插件管子；目录只回账号元数据，连接仍经原生确认。
  停止使用只移除消费插件的引用；持久化失败时原 `/oauth` DELETE 回 500，不假回 204。
  Node 管子增量增加 `HOST_INJECTION_REQUIRED` 失败码，表明引用账号仅能由宿主代注入；
  普通账号的既有 Node 明文绑定保持不变，旧调用方按 `ok:false` 处理未知失败码。
