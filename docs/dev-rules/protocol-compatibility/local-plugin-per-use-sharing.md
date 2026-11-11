# 本地插件按次分享

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

公共 `kind=plugin`、`cindy://plugin/<pluginId>` 及其链接复用、版本选择和安装规则保留。
本地分享另用 `kind=local-plugin`、随机 `snapshotId` 和
`cindy://plugin-share/<snapshotId>`；只导航，拒绝 query、fragment、包 URL 和自动安装参数，
沿原冷启动与登录续接进入独立分享详情，优先于本机／远程目录分支。安装沿用当前所选电脑；仅在有其他候选电脑或已选远程电脑时显示原设备选择器，不额外要求选择。离线或不支持的目标不可安装，不自动切回本机。不新增 Mobile 入口。

两仓 `packages/plugin-protocol/src/localSharing.ts` 同步维护上传、固定快照与交付校验，
不修改已有 manifest、Release 或来源枚举。每次打开本地分享面板生成新操作；用户明确开始后，
Main 先用原一致性读取入口核对已批准的本地实例，绑定版本、批准回执、内容摘要与原登录身份；
需要上传且取得确认后才压缩固定包。
普通 Access Token 用于创建、查看、图片和下载；关闭署名只隐藏姓名，不转匿名。
同一面板重试和署名切换复用原包，新的分享操作始终独立；ready 包不跟随本地文件或后来版本。

逻辑分享与包存储分开：内容摘要按确定顺序编码，打包沿用原 ZIP 条目与时间戳行为，保留实际文件、权限、
空目录与签名字节，不改变普通导出和投稿的包元数据。新的操作仍创建新的 snapshotId；相同包可指向同一 OSS 对象，服务端命中本人
已验证的相同内容摘要时，check 直接返回 ready，客户端核对本次内容与身份后省略压缩、PUT/commit，
继续创建本轮分享素材。同版本内容改变不能复用；不凭其他用户包的摘要跳过上传验证。
本地分享先核对当前包与服务端复用结果：ready 时直接生成新链接，不再确认上传；需要传包时
返回 `confirmationRequired`，原分享弹窗取得明确确认后才传 `uploadConfirmed: true` 执行 PUT。

检查阶段仅稳定读取文件计算分享内容摘要，调用新增 `POST /api/local-plugin-shares/check`，
不压缩 ZIP、不写上传包。命中本人已验证内容时直接返回本次新快照，免确认和上传；
未命中才确认后打包，打包内容必须仍与确认前摘要一致。服务端从实际归档重新计算
`contentSha256`，精确 ZIP `sha256` 继续负责传输和安装校验，版本号不能替代内容判据。
并发上传的相同内容也可复用不同编码的 ZIP；客户端先绑定服务端已验证的内容，再固定所选
快照的实际 ZIP SHA 和大小，后续分享素材或署名重试不得换包。
原投稿恢复保存的 `contentSha256` 编码不变，分享使用独立版本化摘要，不改其持久状态。
两仓增量协议同步，旧 ZIP 上传请求可省略新增摘要字段；服务端先部署检查能力，
新客户端访问不支持检查的服务端时报告失败，不自动上传或回退成先压缩的检查。
确认前只发送内容摘要，不发送包字节；不新增客户端长期上传记录。

可信 renderer 的新增 IPC 为 `plugin-market:prepare-local-share`、`release-local-share`、
`local-share-detail` 和 `install-local-share`；不加入 device-link allowlist，不接收文件路径、
服务地址或用户身份。下载只取固定服务签发的该快照票据，核对大小、SHA、ghostId 和版本后，
复用本地包的真实权限确认、root/manual 安装／更新锁及 durable receipt。换源必须沿原确认，
不写市场更新订阅，不改写 namespace、签名或 `minCindyVersion` 策略；取消不报告安装完成。
分享包覆盖已安装的同 ID 插件时，即使权限未增加也必须明确点击“替换”；本机与远程目标
共用原确认回执（`purpose=share-replace`）。普通本地来源更新的说明明确告知会继续使用旧账号和数据，
相同 ID 不证明作者相同；已触发原换源判据时仍展示原隔离说明，不改变状态继承规则。
临时包使用独立目录，失败、释放面板、窗口关闭及退出清理；切换账号使在途结果失效。

需先部署支持独立快照与增量表的 Plugin Server，再部署本地模块的 Share Server，最后发布客户端。
旧客户端不认识新深链，不得降为公共安装；新客户端连旧服务只报告能力不可用。
旧服务与新增表可滚动共存，回退入口不改已有本地包或公共记录；已生成的新链接需要支持本地模块的服务。
远程插件 `management:snapshot` 增量返回可选 `localShares: true`，新控制端只在明确声明后提供固定包安装。`management:begin` 新增 `kind=install-share` 与 `expectedSnapshot`，不接受包 URL、token 或目标路径；目标宿主使用自己的登录态换取下载凭据，复核快照／摘要／大小，再进入原手动安装事务。权限确认、取消和结果查询复用原 operationId 回执；断连只查原操作，切账号后丢弃旧结果。旧端缺能力时提示更新；旧控制端忽略新能力字段。无新增远程 channel 或权限扩展。

相关回归：`localSharing.test.ts`、`deepLink.test.ts`、`ghostLocalInstallIdentity.test.ts`、
`LocalPluginShareView.test.tsx` 和 `scripts/fixtures/local-plugin-sharing/`。
