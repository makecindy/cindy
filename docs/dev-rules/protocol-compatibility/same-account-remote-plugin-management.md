# 同账号远程插件管理

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

现有 `plugins` 远程资源以可选 action `management:snapshot` 声明 version 1 管理能力。
新增 `management:market-detail/begin/operation/answer/cancel`，沿既有 resource invoke、
同账号设备授权和 owner 边界执行，不新增通用 IPC allowlist 或服务端协议。
新版插件页复用 `management:snapshot` 的可选只读参数：`{read:'capabilities'}` 只返回
`catalogPaging: true`；`{read:'installed'}` 只返回已装管理及维护投影；
`{read:'catalog',query}` 返回目标 Host 的一页市场项、游标、首批完整数量及本地来源统计。
其中可选的 `counts.official`、`counts.community` 是同一查询下公开插件的两个子集，沿用目标 Host 的已装排除规则。
旧 Host 可省略分项，控制端在公开总数为零或已有完整目录时仍可显示准确数字。
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

## 自定义市场的来源身份

自定义市场条目（`management:market-detail` 与 `{read:'catalog'}` 中 `sourceType` 为 `git-market` /
`local-market` 的项）可选追加 `sourceIdentity`；`management:begin` 之后确认回执里的 `consent` 可选追加
`originSource`。两者形状相同：`{kind:'git', repository, ref?}` 或 `{kind:'local'}`。服务端市场条目与其它
来源的确认不带这两个字段。

- **生成**：目标 Host 用 `pluginMarketSourceIdentity`（`apps/desktop/src/shared/pluginMarket.ts`）从来源配置
  白名单生成，生成不出时整个字段缺省，不给空值或部分值。
  - `repository` 只含小写 host 加 2–4 段路径（`host/owner/repo`，允许 GitLab 子组），总长不超过 256，整体匹配
    `PLUGIN_MARKET_SOURCE_REPOSITORY_PATTERN`，结尾 `.git` 去掉。
  - 只从 URL 读取 hostname 与路径；用户名、密码、令牌、端口、查询串与片段一律不读取。含空白、控制符、
    零宽或双向控制符、反斜杠、百分号编码、原始 `.` / `..` 路径段或多个 `@` 的地址不生成。
  - 未配置 ref（存储里缺省该键；null、空串同样视为未配置）时不给 `ref`。配置了 ref 但不是与添加来源时
    同口径的合法引用时，整个身份不生成：git 实际仍会用它取包，不能给出缺了 ref 的身份。
  - 本地文件夹市场只给 `{kind:'local'}`，不给路径。
  - 存储的 `sources.v1.json` 按不可信输入处理，手工改过的配置也不能把凭证或非字符串值带进投影。结果不写日志。
- **与安装来源同源**：`originSource` 由 `customInstall` 在打包所在的来源租约内、用打包所用的那份来源配置
  生成，与 `sourceKey` 同出一处；确认前不按市场名重读配置。提交前 Host 复核 `sourceKey`，确认等待期间同名
  市场被换成其它来源时安装以 `PRECONDITION_FAILED` 拒绝，所以确认时展示的仓库就是随后安装的来源。
  条目的 `sourceIdentity` 按该条目自己的来源配置生成。同一仓库只改稀疏路径时 `sourceKey` 变、身份不变，
  控制端视为同一来源。
- **控制端合同**：按同一形状校验，Git 形式只允许 `kind`、`repository`、`ref`，本地形式只允许 `kind`。
  - 确认回执里 `originSource` 形状不对，整份回执按无效处理；条目里 `sourceIdentity` 形状不对，只丢弃该字段。
  - 回执过期后核实自定义市场安装时，要求当前 `sourceIdentity` 与发起安装时记下的 `kind`、`repository`、`ref`
    全部相同；缺失或不一致都按未确认收口，不能据市场名或 `pluginId` 推断已安装。
  - Host 缺少这两个字段（旧 Host 或生成不出）时，控制端不能把只显示市场名当作已核对仓库。
  - 现状：电脑作为控制端时只展示 `originSource`，形状不对时不展示仓库、只显示市场名。手机端由手机插件市场
    PR #12684 接通，合入前手机不消费这两个字段。
- **展示**：电脑端确认框、电脑作远程端时的确认、任务卡与 IM 卡在来源文案后追加「 · 仓库 …」或「 · 本地文件夹」。
- **兼容**：只增可选字段，无需能力协商或版本门槛。旧控制端（旧手机、作为远程端的旧电脑）不展示新字段，
  确认仍只显示市场名，行为不变。批准状态、回执、安装账本、安装布局与 manifest 校验都不变。
- **已知边界**：
  - 身份不含协议与端口：同一 host、同一路径的 https / ssh / 不同端口视为同一仓库。确认期间的换源仍由
    `sourceKey` 复核拦住；受影响的只有控制端「回执过期后按身份核实」这一步，区分不了同一主机不同端口上的
    两个服务。需要更细时可再加不可逆的来源指纹，目前不做。
  - 同一仓库只改稀疏路径时身份不变（见上）。
  - 路径大小写按配置原样保留（host 转小写）：同一仓库的不同大小写写法会被控制端当成不同来源，结果是保守的
    「未确认」，不会误认。
  - 以 `.` 开头的路径段（如名为 `.github` 的仓库）、超过 4 段的路径、IPv6 主机生成不出身份：电脑端确认退回
    只显示市场名，控制端按缺少身份处理。
- **自建中转**：字段位于既有 resource invoke 的结果载荷中。中转按原样转发 `payload`、不解析内容
  （`packages/device-link-relay/src/hub.ts` 的 `route`），握手、帧路由、顶层字段与能力协商都不变，因此无需同步
  修改中转。新增内容每项最多约 300 字节，单页目录最多 100 项，远低于 2 MiB 的帧上限。

## Desktop 公开市场提审

`management:snapshot` 可选返回 `communityPublication: true` 并为来源可确认的本地安装投影
`publishingSource`。Desktop 目录与详情使用同一发布交互。选中目标电脑时，控制端只向该电脑发送
`management:publish-prepare`，绑定物理安装实例、已批准记录和预期版本。目标 Host 重新定位安装并
复用本机社区提审的打包、包校验和市场预检，返回发布摘要和不透明的准备 ID。控制端不传安装路径，
也不接收包字节、凭据或上传票据。

`management:publish-submit/status/discard` 只接受原准备 ID，并校验同一控制设备及登录账号。
提交前和实际写入前复核原控制授权、连接代次和安装事实；目标 Host 使用自身的账号凭据向既有市场
接口执行提交。状态读取可在同一账号重连后继续，只有收到市场回执才确认成功。超时或断线只查询
原提交，切换账号或撤销设备控制后拒绝访问旧回执。关闭未提交的预览释放准备包；已发起的提交由
现有 Host 提交流程完成清理。

旧 Host 缺少能力字段时保留所选电脑并提示在目标机发布或更新。新增动作复用现有
`plugins` Remote Resource invoke；relay 仍透明传输既有业务帧，不增加通道或修改市场协议。

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
