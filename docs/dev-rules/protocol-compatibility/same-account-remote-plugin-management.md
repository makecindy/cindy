# 同账号远程插件管理

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

现有 `plugins` 远程资源以可选 action `management:snapshot` 声明 version 1 管理能力。
新增 `management:market-detail/begin/operation/answer/cancel`，沿既有 resource invoke、
同账号设备授权和 owner 边界执行，不新增通用 IPC allowlist 或服务端协议。
新版插件页复用 `management:snapshot` 的可选只读参数：`{read:'capabilities'}` 只返回
`catalogPaging: true`；`{read:'installed'}` 只返回已装管理及维护投影；
`{read:'catalog',query}` 返回目标 Host 的一页市场项、游标、首批完整数量及本地来源统计；
`{read:'recommendations'}` 返回本次最多 12 个公开官方候选。查询、版本、来源和已装判定均在
目标 Host 执行，本地自定义来源不上传市场服务器。新控制端先探测能力，只有旧 Host 明确
拒绝非空输入（`INVALID_PARAMS`）才进入既有 v1 快照路径；普通读取失败不得回退全量。
旧控制端的空输入仍返回原有 v1 全量快照，旧 Host 的历史网络限制保留。推荐池由页面持有，
切换列表、搜索及详情返回不重新请求；没有新增远程 channel、授权或 relay 配置。
Host 访问 plugin-server 的按需读取接口（`catalog`、`defaults`、`resolve`、`recommendations`）可能先于
服务端上线：只有旧服务端的「接口不存在」才回退到改版前的整份目录读取（`resolve` 404/405；`defaults`
首页 404/405 或被旧路由当成插件 ID 返回 400；`catalog` / `recommendations` 的 400 先用 `defaults` 首页
确认），按市场地址在进程内记住 10 分钟；网络、鉴权、5xx 与组织变更等错误照旧失败，不回退。
`management:snapshot` 的可选 `projects` 字段投影目标 Host 的最近项目 ID、显示名及可选只读
`path`，用于复用本机 Project Scope 的目录展示（含暂时不存在的最近目录，不按任务归档过滤）；
控制端以 Host 生成的项目 ID 请求 `management:project-state`，返回该项目的禁用实例和
由目标 Host 计算的 revision。项目启停沿原 `ghost-workdir-prefs` 例外语义，写入同时绑定
控制设备、物理插件实例、安装批准 token、项目 ID 与 revision。旧 Host 缺少 `projects`
时只保留全局插件管理；空数组表示该 Host 支持项目管理但暂无项目。切电脑先重读项目目录，
不能把控制端本机路径或上一台电脑的项目交给目标 Host。
快照可选追加 `projectBrowse: true`，声明支持 `management:project-select`。控制端复用现有
远程目录选择器并固定目标电脑，Host 重新校验选中的绝对目录，生成项目 ID。浏览选择仅作为
该控制设备、owner 与连接代次内的临时 scope，不创建任务或写入最近项目。读取与启停仍只接收
Host 项目 ID，浏览目录在使用前再次校验；不能以展示路径直接执行项目写入。旧控制端忽略
新增字段，旧 Host 缺少浏览能力时保留原项目列表与启停，不回落本机目录选择器。
旧控制端继续使用原 list/get/enable/disable；新控制端遇到旧 Host 仅展示旧 list/get
和升级提示，不能回退本机写入。

写操作绑定控制设备、物理插件实例、安装批准 token，以及市场 release/manifest。
目标 Host 原安装器处理实际包摘要与权限确认；等待确认不占安装锁。异步操作用
控制端生成的 operationId 查询回执，未知结果只查原操作、不自动重装；回执仅存内存
15 分钟，Host 重启后不能保证恢复。断链使后续写入失效，但同 owner 重连仍可查询已提交
结果；撤权和账号切换作废旧回执。取消请求不能撤销已经提交的安装。

手动 `.cindy` 导入先由控制端 Main 的受信原生选择器授权单个文件，再沿既有 filePeer
传输，目标在自有临时目录检查、确认并安装。控制端路径不作为目标路径。
配置源由 Host 绑定打开页面的控制设备，不传回已存凭证，不以任务卡代替插件设置页。
管理快照可选声明 settingsPage: true：Desktop 通过 settings:open 获取目标插件原
settingsHtml 的包资源声明与页面租约，不要求存量插件补发 mobile 声明。A Main 的
专属非持久 partition 展示原页面，复用同样的 CSP/沙箱/主题/布局；主窗 CSP 不变。
KV、secret、OAuth、connection 与原 BroadcastChannel 请求通过已有 v3 签名握手与
密封 exchange 中的可选 op: settings 传输，只接受绑定该页面的签名会话；普通 OAuth
卡片会话与通用 Remote Resource fetch 不能访问它。controller、owner、物理实例、批准
版本和连接代次在真实执行前复核。新增命令有严格白名单及大小限制；密封 callback 上限
追加到 144KB，以容纳原设置页 64KiB 请求及 JSON 转义，原 OAuth 各内层契约的限制不变。
旧端未声明能力时不发送新 op，不回退到未加密请求。
设置页续签只替换同一控制设备、同一页面与同一插件的旧握手，不等待在途请求，
使轮询和确认回复可经新连接完成。旧连接不再接受新请求；已受理请求仍用原密钥返回，
返回前复核原有效期、owner、控制设备代次和页面租约，不关闭页面或重放写请求。
v3 消息格式和每 Host 16／每 peer 4 个连接、每连接 1024 条消息
的上限不变；旧控制端兼容新版 Host，完整续签交接需要控制端与目标 Host 均更新。

原 /oauth/<key>/connect 先生成绑定页面的一次性 ticket，沿现有 v3 浏览器授权桥执行
目标原端点；原 HTTP 结果送回 settings.js。已有账户只读脱敏原端点投影，令牌保存在 B。
关闭页面取消其待授权 ticket；超时或失败不重放保存/授权。切目标、账号、安装批准或
撤权使旧页面失效；单页故障不重启共享 relay。包资源使用原目录与文件身份检查分块读取，
A 不直接读取目标安装目录。原目录选择请求通过 Main 的固定 IPC 进入既有远程
目录选择器，固定目标 B；选择经密封 answer-directory 返回 B，并由 B 原路径校验
和授权逻辑执行。目录请求不进入作者页面；原普通 Remote Resource fetch 仍拒绝凭证
接口。Mobile 原页面契约保持原行为。

管理快照可选追加 hostPreferences: true，声明 management:preferences/preferences-set。
它只投影本机本就由 Host 管理的模型、任务与侧栏偏好；不包含已有凭证、目标工作目录或
供应商执行路由。写入要求物理实例、安装批准 token 与配置 revision，复用本机校验与
存储，任务 patch 保留目标工作目录。旧控制端忽略新增字段，旧 Host 的缺失能力如实展示。
无需服务端、通用 IPC allowlist、数据库或 Mobile 原生改动。

## 同账号远程技能管理（2026-10-14）

插件与技能页共用电脑选择。目标 Host 通过追加 `skills` Remote Resource collection 和
`management:snapshot` capability 提供技能投影与 opaque 操作；不开放既有本机 SkillHub IPC。
旧 Host 缺少该能力时保留页签和目标电脑，显示升级提示，不回退本机数据。资源 id/revision
由 Host 扫描中的实体、物理目录、授权入口、启停代次与注册记录派生，不接收控制端路径。
响应仅携带名称、描述、范围、引擎、版本、状态、正文及市场身份，不暴露目录、凭证或内部 registry。
Claude 原生 `user` 范围投影为 `global`；控制端读取早期 Host 的 `user` 返回值时也按全局展示，避免丢弃整份快照。

控制端新增受信任原生 IPC `device-link:confirm-skill-mutation`，从目标查询具体操作回执，
原生确认后仅回答这一个 Host requestId。普通 Renderer 的 Remote Resource invoke 禁止直接
发送技能 `management:answer`。确认不占用目标安装锁；批准后重读实体版本，安装器在原锁和
跨进程租约内、下载解包后复核目标及授权目录，继续复用备份和回滚。卸载在租约内再次复核后
复用系统回收站。启停、已提交结果与取消分别表达；离线只查原回执，不重放写操作。
运行中取消通过原 mutation guard 进入安装器的提交前检查；操作结束后记录取消结果，
已经提交的成功结果仍保留，不将取消回执误当作事务回滚。

现有本机接口、路径授权及原生卸载确认保持原行为。仅新增可选 Main 内部 mutation guard；
不改变协议版本、manifest、运行期 fingerprint 或持久数据格式。手机可通过标准 list/get 读取
技能资源，但未新增安装/升级/卸载 UI 或原生确认桥；手动技能目录导入、编辑和发布仍属于本机。
