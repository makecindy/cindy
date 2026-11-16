# 客户端端点清单

Desktop 与 Mobile 共用端点清单。源码、随包文件和线上 CDN 是不同层，更新源码不等于线上已经生效。

| 环境 | 源文件 | 默认开发启动 | 线上清单 |
| --- | --- | --- | --- |
| dev | `config/endpoint.dev.json`（本地文件，不入本仓 Git） | `pnpm restart:desktop:remote --region=dev` | 该文件中 `cdnBaseUrl` 下的 `endpoint.json` |
| cn | `config/endpoint.json` | `pnpm restart:desktop:remote --region=cn` | 该文件中 `cdnBaseUrl` 下的 `endpoint.json` |
| global | `config/endpoint.global.json` | `pnpm restart:desktop:remote --region=global` | 该文件中 `cdnBaseUrl` 下的 `endpoint.json` |

普通开发启动读取所选环境的本地文件；正式安装包在启动时优先读取线上清单。开发启动添加 `--endpoints-cdn` 可验证线上链路。线上清单是完整快照，不会逐字段与包内文件合并；漏掉可选字段时对应能力会关闭。

## dev 的两种用途

- 联调已部署的开发服务：从构建／发布仓维护的 `endpoint.dev.json` 同步到本地。本仓不提交该环境的实际清单，构建任务也会从发布仓复制它。
- 启动本机服务：使用 `endpoint.dev.json.example` 的本地端口模板，按实际启动的服务填写。该模板不是远程 dev 的线上配置。

同步时保留当前文件中明确自定义的其它字段，不复制凭据、用户数据或依赖目录。端点清单只包含公开地址；飞书 App Secret 等凭据不放在这里。

## 飞书 / Lark

三个环境都使用 `feishuHookWsUrl` 开放官方渠道入口。地址缺省或为空时，未开启飞书的用户不显示入口；已开启的用户保留卡片并显示地址未配置错误，以便关闭。清空地址后，客户端重启读取新清单会停止该连接。dev 连接开发环境的飞书服务；cn 与 global 共用同一套 SGP 正式服务，两个正式清单中的该字段应相同。

地址非空只开放客户端入口。开关打开后，服务仍按当前账号与组织配置协商可用能力，组织接入和个人关联分别完成。

## 更新与核验

1. 核对目标服务已经部署，更新所属环境的源文件；dev 同时更新发布仓的正本。
2. 用客户端共享 schema 解析清单，并核对区域、协议、服务地址与预期一致。不得把 dev 地址放进正式清单。
3. 发布前重新读取目标环境线上文件，只提交本次涉及的差异，保留并发更新的审核版本等其它字段；保留原文件与 ETag 以便回滚和避免覆盖。
4. 将清单发布到该环境 `cdnBaseUrl` 下的 `endpoint.json`，再通过该公开地址读取核对。CN 与 Global 分别发布；只修改仓库文件不算发布完成。
5. 重启客户端，确认入口与连接状态。客户端已有相应代码时，修改清单无需重新打包。

回滚时只撤回本次涉及的字段；若发布后已有其它变更，不能整份覆盖为旧快照。
