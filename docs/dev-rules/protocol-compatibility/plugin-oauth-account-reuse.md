# 插件复用已有账号与已保存凭证

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
- 同一可信本机 IPC 增量接受 `kind:'secret'|'connection'` 的来源引用（实例、声明键、来源条目
  ID），仍不进入插件管子或 device-link allowlist。普通 `network.secrets` 的权限声明与安装批准
  不变；来源必须是兼容的已保存网络凭证。原有 OAuth 引用不增加字段，也不改变解释。
  Host 在原加密 vault 中保存 `<key>-reused-credential` 引用，原凭证位只保存非密钥标记；
  标记单独存在不授予读取其它凭证的权利，只有可信原生确认路径可写派生引用。普通密钥保持
  原读取语义；普通 `/secrets` PUT/POST 不能写该保留标记（400），成功替换或 DELETE 在同一
  同步段清掉派生引用，失败返回 500；不会将已有普通值或 GET 状态视为非法数据。普通密钥仍是
  单次原读取，无标记时不加载引用管理器。使用引用需新 Host；旧 Host 不会得到来源密钥，
  不将复制来源值作为降级。Node 绑定仍返回 `HOST_INJECTION_REQUIRED`。选择替换目标原密钥，
  来源仍独立管理；停止使用只删除目标引用，持久化失败返回 `VAULT_WRITE_FAILED`。
  手机端建立这类引用尚不支持，调用既有引用不扩大凭证与账号边界。
  Node Host 用同一 `GhostSavedCredentialManager` 和既有 owner vault/connections 解析并注入，来源撤回即拒绝；不新增引用创建、存储或迁移流程。
