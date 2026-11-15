# 群聊邀请公开链接

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

新生成邀请为 `<shareBaseUrl>/chat-invite/<32 位 base64url 编号>`；CN `share.cindy.com.cn` 与
Global `share.cindy.app` 读取同一记录，链接不带口令。Share Server 用 AES-256-GCM 加密保存口令，
以口令哈希去重，并记录生成时群名、人数和最多五个成员头像。桌面建链提交生成邀请所用的 actorId；
分享服务使用同一调用者凭证和 `X-Chat-Actor` 预览，要求 groupId 一致、joined=true。一律署名账号本人；
伙伴身份创建时，App 预览仍显示伙伴邀请人。群聊服务、账号服务及原预览/接受协议保持不变。

客户端共享解析分别提供 `parseChatInvitationShareId` 和 `parseChatInvitationToken`。前者只提取编号，
主机只校验 URL 形状，从不作为请求目标或切换区域的依据；取口令始终向自身配置的 `shareBaseUrl`
发送 `POST /api/chat-invites/:id/token`。后者继续接受裸口令和 `cindy(cn|dev)://chat-invite/<token>`。
删除 device-link 旧 `/chat-invite/join#<token>` 网页与解析，不保留双入口。

分享网页加载后立即取口令，所有设备只显示一个原生拉起按钮；按钮准备好后自动尝试拉起一次，保留按钮供手动重试。
电脑沿用统一 `cindy://`；手机按可信访问入口选择国内 `cindycn://` 或海外 `cindy://`，失败不切换到其他版本。
浏览器阻止拉起不影响已准备好的按钮，也不报为口令读取失败；
小字提示也可在 Cindy 中直接粘贴邀请链接，不附加区域或版本条件。电脑具体实例由系统协议注册决定，不新增桌面区域协议。
深链不展示、不复制；网页复制只给 HTTPS 链接。桌面需已注册 `cindy://`，旧版粘贴 HTTPS 链接需升级；
此前发出的原生深链继续可用。
手机群邀请此前未发布，沿 #7930 同一常驻面板、首页加入入口、剪贴板识别和明确确认加入的合同，
先在原 15 秒/AbortSignal 窗口内取口令，再把内存目标归一为原生深链，接受及未知结果重试的 operationId 不变。
不增加原生 Universal Link 配置或安装归因。

桌面分享服务不可用时明确报错，以同一创建 operationId 重试，不回退生成深链。
撤销先完成群聊服务操作，再通知分享服务，仅创建账号可记录 disabledAt；通知失败重试一次，不回滚撤销。
分享服务不判断其他实时失效，原预览仍由群聊服务最终判定。口令不写 URL、reference、署名回调、日志、HTML
或客户端持久存储；路径编号脱敏。此变更涉及新增分享服务表、加密密钥与匿名取口令，须人工安全 review。
必须先完成分享服务配置、sh-dev 验证并发布生产，再合并并发布客户端；本地测试不表示实际部署已完成。

Chat Server 既有预览接口兼容追加 `avatar` / `memberCount`，V9（2026-10-28）再可选追加
`memberAvatars?: Array<{avatar:string|null,initial:string}>`，不改请求或接受操作幂等合同。
在原邀请校验通过后统计 `state='joined'` 的人和伙伴；邀请中、离开、移除、封禁不计入。
摘要最多五条，Actor ID 升序，和 joined 总数取自同一 SQL 快照；头像取群内覆盖或 Actor 头像，
沿既有公开值支持 HTTPS、`cindy://avatar/preset/(cindy|dash|lizi)`、emoji、null。首字取群内昵称
或 Actor 名称 trim 后的第一个 Unicode 字素，空白为 `''`；无图片仍保留槽。不提供完整姓名、
Actor ID、owner、role 或 grants，不授予成员详情/历史权限，也不由客户端调用成员接口补齐。
旧字段 `avatar:null` 仍表示无群自身照片。旧端忽略摘要，新端接受旧服务端缺省；缺省/空摘要
显示群缺省标识，坏图原槽显示首字，未知人数不能当 0、不能用摘要长度推算。既有邀请拒绝条件
继续适用，不通过本次展示放宽。两端可独立升级，真实摘要/人数展示需服务端与客户端均支持；
生产部署另核验，不新增 schema、原生配置或安装归因。
