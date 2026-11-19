# 项目显示名的跨设备镜像

## 项目目录与创建（settingsVersion 6 / 7）

v6 的快照增加 `directories`，组合保存支持 `profile.directories`（省略保留，空数组撤销）与 `create: true` 注册已有目录。
v7 在同一保存通道增加可选 `repositoryUrl`，`create: true` 且 `projectKey: local:` 表示由目标主机分配目录；指定已有 `local:<path>` 时克隆要求目录为空。
读取快照的 `creationRoot` 只供位置预览；创建成功返回 `createdProjectKey`，控制端必须使用实际主目录打开项目，不能假定预览路径未发生重名编号。
新控制端面对 v6 继续要求手选已有目录，隐藏仓库字段；v7 主机继续接受旧的已有目录注册请求。Agent 跨电脑遵守相同能力检查。
克隆五分钟预算，Desktop / Mobile 共享 invoke policy 给该类写入六分钟，不自动重试或合并写入。失败不切换执行电脑。没有新增 channel、relay kind 或数据库 migration；自建中转继续透明转发已有加密 invoke，无需部署服务端变更。
本机 Renderer 在目录选择与保存时附带可选 `projectGrantScope`，只用于 Main 匹配已保存的窗口／表单／账号选择凭据，不是跨设备授权字段。宿主从真实传输上下文或任务调用边界传入授权，忽略请求伪造的来源。远程 v6／v7 请求形状不变，不增加中转能力或版本号。Node Host 的既有 `project_aliases_changed` 通知在创建／移除时附带 `catalogChanged: true`，此时额外转成现有目录失效 push；仅编辑资料不扫描目录列表。旧客户端忽略可选标记。

回归见 `projectCreation.test.ts`、`projectInfoCore.test.ts`、`projectAliasSync.test.ts`、`invokePolicy.test.ts` 和项目设置真实组件检查。

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`sidebar-settings:get-project-aliases` 是只读的主机别名快照；返回主机平台、账号代次和
`local:` / `remote:` 项目身份对应的别名，不传播主机作为控制端保存的 `device:` 覆盖名。
`local-db:project-aliases:changed` 使用 `{}` 失效通知和账号标记，沿既有 `sessions` topic
转发。控制端首次订阅、重连及既有列表刷新时补拉；在途读取期间收到变更时丢弃旧结果并补拉。
完整空快照表示别名已清除，临时读取失败保留最后有效名称。退出账号、移除或撤销设备时清理镜像，
迟到响应不得恢复已清理的数据。

新主机与旧控制端保持原行为；新控制端连接不支持该读取通道的旧主机时使用目录名。
只新增读取与通知准入，不开放远程别名写入，不改数据库或 relay 格式。
名字按物理来源设备和完整主机项目身份匹配；Windows 本地路径按主机平台比较，SSH 身份和
POSIX 大小写保留。既有分组若包含不同主机项目身份，仍显示原目录名，不能任取一条别名覆盖整组。
桌面控制端已有的本地 `device:` 覆盖名继续优先。分组键、任务标题、工作目录和路由均不随别名改变。

实现与回归见 `packages/maker-shared/src/projectAliasSync.ts`、`projectAliasSync.test.ts` 和
`projectAliasPresentation.test.ts`；移动端首页、设备详情、抽屉与搜索筛选共用同一份镜像。

## 项目资料编辑（2026-11-13）

快照增加可选 `settingsSupported: true`、`settingsVersion: 2` 和 `icons: Record<projectKey, icon>`。
icon 为 Emoji、`symbol:<Lucide 名称>`、`text:<1–2 字>` 或 cindy-media PNG 内容地址。
旧控制端忽略新增字段，新控制端遇到缺少能力的主机禁用资料编辑。
`sidebar-settings:set-project-info` 接收 `projectKey`、`field: name | icon | profile`、`value` 和
主机快照的 `dataOwnerId` / `ownerGeneration`；profile 的 value 是可选 name/icon 对象。
名称空字符串、图标 null 分别删除覆盖。图片上传为限制长度的 data URI，主机重新解码并入总仓；
`sidebar-settings:get-project-icon-image` 按 projectKey 读取已登记图片并复验账号，不开放任意媒体地址读取。
仅接受主机 `local:` / `remote:` 身份，拒绝控制端 `device:` 身份及过期账号代次。
旧的 `local-db:project-aliases:set/delete` 仍不开放远程访问。

保存成功沿已有 `local-db:project-aliases:changed` / `sessions` topic 通知；镜像比较包含图标，
图标单独变更或恢复默认也会刷新。Node Host 通过同一 shared host contract 提供快照和编辑，
并将事件送至桌面代理和设备互联。现有通用加密转发可承载本次新增 invoke，无需改变中转帧格式
或自建中转程序；新旧端按资料能力版本降级，完整编辑需 version >= 2。

### 线性图标颜色

`settingsVersion: 3` 增量支持 `symbol:<Lucide 名称>:<color>`；color 白名单为
`TASK_TAG_COLORS` 的 red/orange/yellow/green/blue/purple/gray/pink/coral/teal/indigo/white，默认仍写无后缀的旧表示。颜色与图形同一次保存，
不新增存储文件、数据库迁移或 relay 字段。旧的无色 symbol 继续原样读取。
新控制端连接 v2 主机不展示选色，Agent 远端写入也先检查 v3；旧控制端将不认识的彩色图标
回退为默认文件夹，不影响别名或项目内容。原有通用加密 invoke/push 已透传字符串，
自建中转无需改动；客户端共享校验与主机持久化共同验证扩展表示。

## 自动项目图标（settingsVersion 4）

新增只读 `sidebar-settings:get-project-auto-icon({projectKey})` → `{image,source,kind,candidate}`；image 是有界 PNG data URI 或 null，kind 为 local/website/github/none。只对当前账号已有项目做发现，缓存／图片归属被控主机；控制端不访问项目文件或自行下载网站。跨账号换代丢弃结果。Desktop preload、Host HTTP `/api/project-info/auto-icon`、device-link allowlist、Mobile 使用同一业务入口。

原 icons 字段始终只表示手动覆盖，null 删除覆盖的 wire 含义不变。新客户端在没有覆盖时查询自动图标；无图片或旧主机缺少通道时，由控制端使用项目显示名生成跟随主题的字母方块（不写入覆盖），设置页按版本隐藏自动图标入口。旧客户端仍显示手动图标或文件夹，不会把自动结果固化成覆盖。没有新增 relay kind；自建 relay 继续透明转发既有 RPC，无服务端协议变化。

## 字母颜色（settingsVersion 5）

`text:<1–2 字母或数字>:<color>` 复用线性图标的颜色白名单，默认色继续保存 `text:<文字>`。
字母与颜色同一次提交和广播，两端预览、项目列表与重新编辑共同解析；旧无色数据无需迁移。
新控制端连接 v2–v4 主机时隐藏字母色板并保存无色表示，Agent 远端写入彩色字母前检查 v5。
旧控制端无法解析的新表示回退文件夹，不影响名称及其它资料；用户原有覆盖不会因读取被改写。
字段仍是原有 icon 字符串，保存通道、账号边界和 relay 帧不变，自建中转无需更新。
