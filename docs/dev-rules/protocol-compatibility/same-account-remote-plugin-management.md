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

自定义市场插件的安装可以经同账号远程控制端发起，所以控制端需要知道两件事：「装的是哪个来源」（来源身份与
`sourceId`），以及回执过期后「当前装着的是不是我那次操作装的」（操作级证据 `installedOperationId`，见下文）。
来源身份是同一形状的可选对象：`{kind:'git', repository, ref?, sourceId}` 或 `{kind:'local', sourceId}`，只出现在
自定义市场的条目与确认里。`installedOperationId` 服务端市场与自定义市场的条目都可能给出；`originSourceChanged`
出现在自定义市场的换源确认与显式替换为服务端市场版本的确认里。其它来源的确认不带这些字段。

- **三处投影**：
  1. 市场条目（`management:market-detail` 的结果，`{read:'catalog'}` 的 `items[]`；仅 `git-market` / `local-market`）：
     - `sourceIdentity`：由该条目当前来源配置与当前缓存版本的取包记录生成。
     - `installedSourceId`：这台电脑上当前已装实例的来源标识，取自**安装记录**（见下文「账本」）。只在已装实例
       存在、账本记录为已安装且属于本条目 `pluginId`、磁盘上的包仍是记录里那份时给出。它只说明「来自哪里」，
       不能证明是哪一次操作装的；回执过期后的核实用 `installedOperationId`（见「控制端合同」）。
  2. 确认回执（`management:operation` 的 `consent.originSource`）：由 `customInstall` 在打包所在的来源租约内、
     用这次打包实际所用的缓存版本、取包记录和同一份配置生成，与提交前复核的 `sourceKey` 同出一处。提交时落位的
     就是租约内打好的那份包（`packed.tempPath`），不在提交时重新取包。
  3. Agent 发起的任务确认卡（`toolName:'cindy.plugin.install'`，`hostOwnedConfirmation:'plugin_install'`）的
     `input`：`{ghost_id, version, operation, origin, source?, originSourceChanged?}`。`source` 与同一次确认的
     `originSource` 相同，只在 `origin === 'custom-market'` 且能生成时给出；`originSourceChanged: true` 只在
     这次确认带该字段时给出（`origin` 为 `'custom-market'`，或显式替换为服务端市场版本时为 `'market'`；换源确认按首装
     展示，所以 `operation` 为 `'install'`；见下文「实际来源变化时的更新」），其它情况缺省。卡输入不进模型上下文（宿主交互不是 Agent 的工具调用）；
     IM 卡与官方 hook 卡的参数预览去掉 `source.sourceId`，仓库名本来就在说明里。
- **`sourceId`**（`^[A-Za-z0-9_-]{22}$`）：
  - 算法：`HMAC-SHA256(K, input)` 的前 16 字节，base64url。`input` 是带域名与版本的 JSON 数组：
    - 本地：`["cindy.plugin-market.source-id", 3, "local", marketSourceKey]`；
    - Git：`["cindy.plugin-market.source-id", 3, "git", marketSourceKey, identity]`。`identity` 是**实际取包地址**校验
      通过后的原始字节串，**只**去掉 http / https / git 形式的 userinfo（凭证），其余一字不改；ssh 与 scp 形式整串
      原样，包括登录用户、主机原始大小写（OpenSSH 的 Host 别名区分大小写）、端口、路径。不再按部件重组：任何在算
      标识前做的规整或按 URL 语义的拆分，只要 git / ssh 实际不这样解释，就可能把两个不同端点并成一个。
    - 解析器只负责两件事：拒绝有歧义的地址（整串含 `?` `#` `[` `]`、空白、控制符、`\`、`%` 时在拆分之前就不生成；
      userinfo 非空、不含 `@` `/`，ssh 登录名不含 `:`——git 把 `git:tenant-a` 整串当登录名；host 是严格的 ASCII DNS
      名；端口不带前导零；路径没有空段与 `.`/`..` 段；并与 WHATWG URL 的解析结果逐项交叉核对，用例另与 git 自己解析
      出的主机对照），以及生成展示用的 `repository`（可规整：去 `.git`、去结尾斜杠、小写 host）。`resolveFetchUrl`
      只去掉 git 输出末尾的那一个 LF（不去 CR、不 trim，末尾的 CR 或空白都交给白名单拒绝）。
    - 结果只会偏保守：同一仓库的不同写法（主机或路径大小写、`plugins` 与 `plugins.git`、结尾斜杠、`:443` 与缺省）
      得到不同标识，会多一次换源确认（确认后旧账号与数据隔离）或「未确认」。这是用户显式确认过的，可以接受；只换
      https 凭证不改变标识，不会触发。
  - 用户名的取舍：`ssh://` 与 scp 形式（`user@host:path`）的登录用户算身份。普通 SSH 服务上，同主机同路径（尤其
    scp 相对路径）可随登录用户解析到不同家目录和仓库；`ssh://` 带绝对路径时也一律纳入，结果只会更保守。
    https / http / git 的 userinfo（含 `https://TOKEN@host` 单段令牌）算凭证，一律不读取，轮换凭证不改变标识。
    登录用户只进本机 HMAC 输入，不进取包记录、展示、回执或日志；不合常见账户名字符集时整个标识缺省。
  - 区分能力：不同本地目录、同主机不同端口、不同协议写法、不同稀疏路径、配置相同但被改写到不同实际地址，
    `sourceId` 都不同；同主机、同路径但 SSH 登录用户不同，`sourceId` 也不同。只改变 https 认证信息（例如改写
    注入的令牌不同）时不变。
  - 用 HMAC 而不是裸哈希，是因为本地路径与仓库地址可被穷举反推。
  - 密钥 K 每个数据所有者一把，按「代」存放，见[凭证与本地存储](../credentials-and-local-storage.md)的路径表。
    新的一代在暂存子目录里写好后整体 rename 成 `v<N>`，目标已存在即失败，所以同一代只有一个写入者胜出，并发的
    其它调用方（同进程或另一个 Cindy 进程）重读得到同一把；不依赖硬链接。缺失或损坏时写下一代，不就地覆盖。
  - 密钥标识 `keyId`（由 K 派生的 12 字符短标识）随取包记录与安装绑定一起记下。比较两个 `sourceId` 前先比
    `keyId`：不同即「无法核实」，不是「来源不同」。密钥被重建后，旧取包记录的标识在下次刷新前不用（身份缺省），
    旧安装绑定不参与换源判断，所以不会因此暂停更新或隔离插件数据；下一次取包或安装后按新密钥重新记下。
  - 密钥与取包记录的读写都是异步的（市场列表、详情、远程目录这些 IPC 读路径会读到），同步计算只用已读好的
    密钥，没读好时标识缺省，不回退到同步读盘。
  - 实现：`apps/desktop/src/main/plugin-market/sources/sourceId.ts`。
- **实际取包地址**：`url.*.insteadOf` 可以把配置地址改写到另一个仓库，按仓库路径加载的
  `includeIf "gitdir:…"` / `includeIf "onbranch:…"` 也可以只在缓存仓库或某个分支状态下生效。所以地址在取包实际发生的仓库上下文里用
  `git ls-remote --get-url` 采集（与取包同一执行环境，不联网）：
  - clone：克隆前（无仓库）、`git clone` 刚完成时与检出完成后（都在 staging 仓库里，前者覆盖 `includeIf "onbranch:…"`
    这类随检出状态失效的规则）、克隆后（无仓库）各解析一次，全部一致才算核实。
  - 部分 git 版本（如 2.43；2.56 不会）的 `git clone` 在初始分支（`init.defaultBranch`）上取包，返回前已切到远端默认分支；两者不同时，只在初始分支上
    生效的 `includeIf "onbranch:…"` 事后的任何采样都看不到。所以克隆前（无仓库）与克隆刚完成时（staging 仓库里）
    只要配置里有按分支生效的条件包含（`git config --list --name-only` 里出现 `includeif.onbranch:` 键，只列键名
    不含值），或读不到配置，就不核实这次克隆。
  - 快进刷新：在 fetch 发生的暂存仓库里前后各解析一次。若这次地址对应的 `sourceId` 与上一版本记录的不同，
    不在旧来源的历史上快进，改走全新克隆。
  - 落位前确认检出的 HEAD 就是本次获取的目标提交（无 ref 与 `@{u}` 比，有 ref 与 `FETCH_HEAD` 比），对不上即
    改走全新克隆。
  - 核实后，把白名单去敏的 `host/owner/repo`、`sourceId`、算出它的 `keyId` 与 `revision` 写进这次取到的版本目录
    （`.git/cindy-fetch-identity.json`，记录版本 3；仓库与标识各自可缺省，标识只在 `keyId` 等于当前密钥时使用）。原始解析结果只在内存里用一次，不落盘、不写日志、
    不进错误详情；git 子进程的输出由 `resolveFetchUrl` 读取后只交给白名单函数，失败时丢弃不记录。
  - 快进刷新复制旧版本后必须重写或删除记录；删除失败时放弃这份暂存目录、改走全新克隆。
  - 实现：`sources/fetchIdentity.ts`、`sources/git.ts`。
- **实际来源变化时的更新**（同一路由、两边都可核实且 `sourceId` 不同，例如同一配置被改写到另一个仓库）：
  - 市场投影：该条目若为 `update-available`，同时带既有字段 `updateRequiresConsent: true`（与权限变多时同一字段、
    同一暂停机制），后台自动更新不尝试。
  - 实际取包（来源租约内）与提交前：后台路径一律拒绝换源并按「等待用户确认」暂停；显式更新强制弹出确认（即使
    权限没有变多），确认请求带 `originSourceChanged: true`，确认框与任务卡给出换源与数据隔离提示（用哪一句见下面
    的三句规则），任务卡 `input` 同时带 `originSourceChanged: true`。
  - 「是否换源」只判定一次，同时驱动确认内容、授予范围与运行时归档；覆盖同一路由下的实际来源变化，以及详情页
    显式「替换」的跨路由替换（服务端 ↔ 自定义、自定义 A ↔ B，`allowSourceReplacement: true`）。替换为服务端市场
    版本时确认的 `origin` 是 `'market'`，同样带 `originSourceChanged: true`，提示文案不提仓库（「这次更新会改为插件
    市场里的版本……」）。提交锁内的判定与确认时不一致即拒绝（`PRECONDITION_FAILED`），不沿用任何一边。手机端与
    Agent 发起的安装不允许跨路由替换（`allowSourceReplacement: false`）。
  - 换源提示的文案按确认里展示了什么来定（本机确认、电脑作远程端／分享替换、任务卡与 IM 卡共用
    `ghostInstallSourceChangedNoticeKey`）：`origin === 'market'` → `marketSourceChanged`（「改为插件市场里的版本」）；
    `origin === 'custom-market'` 且 `originSource` 是合形的 git 身份（确认里展示了仓库）→ `originSourceChanged`（提醒
    核对上面显示的仓库）；其余自定义市场（本地文件夹、身份缺省或形状不对）→ `sourceChangedIsolated`（只说换源与
    数据隔离，不提仓库）。三句都说明旧账号和数据隔离保存、需要重新连接账号。
  - 换源确认按首装展示：旧实例的批准（任务、页面、控制节点、执行引擎、免确认工具、文件打开方式、Cindy 模型）随
    旧来源归档、不继承，所以 `facts` 是 `kind: 'install'`，`permissions` 是新来源的完整权限（不是相对旧来源的差异），
    锁内复核与新 receipt 的各项授予都用同一份事实；确认键仍绑定实际的受体实例。提交锁内的换源判定与确认时不一致
    （确认时是换源、提交时不是，或反过来）即拒绝（`PRECONDITION_FAILED`）。
  - 用户确认后，提交锁内再核实一次；仍是实际换源时按既有换源事务落位：运行时先做换源空闲检查，旧实例的账号、
    密钥、OAuth、KV 与私有数据按 `sourceStateArchiveId` 隔离归档，新来源读不到，归档可按既有流程恢复。安装记录
    改绑新来源，之后不再反复询问。同一来源的更新、只换凭证、本地来源、服务端市场都不走这个事务，数据照常保留。旧记录没有绑定或候选身份缺省时不拦，保持既有行为（第一次
    后台更新会写入绑定，之后才开始比较），升级后不会让所有自定义市场插件集体暂停更新。服务端市场与本地来源
    （配置不变即同一来源）不受影响。
  - 只有同一 `keyId` 下两边都可核实且不相等才算实际换源。旧记录没有绑定、候选身份缺省、绑定是旧密钥算的，
    一律按同一来源的更新处理：不暂停、不强制确认、不隔离数据（有用例锁住）。
  - 控制端：确认回执的 `consent.originSourceChanged?: true` 为可选新字段，表示「来源变了，确认后旧账号和数据
    隔离保存」，控制端按上面的三句规则只展示其中一句；市场路径的确认不带 `target`，所以这种情况下
    `target.sourceChanged` 不会出现，不会与之重复。条目的 `updateRequiresConsent` 是既有字段，现在也可能因来源变化
    置位。
- **账本**（存量兼容）：
  - 安装记录只增两个可选字段：自定义市场记录（`custom-ledger.v1.json`）的 `sourceIdBinding:
    {sourceId, sourceKey, rawManifestSha256, keyId}`，以及远程管理安装写下的 `remoteOperationBinding`（服务端与
    自定义市场记录都可能带，见下文「操作级安装证据」）。下面几条说的是 `sourceIdBinding`。显式安装、后台自动更新、换源都经 `customInstall` 整条重写，
    值取自打包所用的版本。
  - 投影 `installedSourceId` 时，绑定的 `sourceKey` 与 raw 摘要必须仍等于记录当前的值、`keyId` 必须等于当前
    密钥，否则缺省（本地来源改为按记录的 `sourceKey` 现算）。这样，
    任何保留了旧值、但来源或包已变的写入都不会让它误配。
  - 读取校验不检查这个字段，形状不对时投影当缺省，不会因此丢记录。旧记录不迁移：本地来源按记录的
    `sourceKey` 现算，Git 来源缺省（控制端未确认）。
  - 降级时，旧版本的读取校验同样只认已知键，读到的记录原样写回，字段被保留。旧版本重新安装或更新时写出不含
    此字段的记录，结果是缺省；旧版本的卸载标记、摘要补写保留字段，但不改来源与包摘要，绑定仍然成立。
- **操作级安装证据 `installedOperationId`**（市场条目可选字段，服务端与自定义市场都给）：
  - 远程 `management:begin` 且 `kind === 'install'`（首装与更新；控制端从已装详情发起的更新也走这个 kind）提交
    成功时，Host 在安装记录里写可选字段 `remoteOperationBinding: {operationId, controller, keyId, rawManifestSha256}`。
    `controller` 是发起方设备身份（device-link 的 controllerDeviceId）用本机来源标识密钥、独立域名 HMAC 得到的不可逆
    标识，不存原始设备号；`keyId` 同来源标识。其它路径（电脑本机、后台自动更新、Agent、`install-file`、
    `install-share`）不写，并且会整条重写记录，旧证据不残留。
  - 只在远程管理的 snapshot（含 catalog、recommendations）与 market-detail 响应里、只对发起那次操作的控制端给出，
    且要求记录为已安装、包摘要等于记录与磁盘上的包、keyId 等于当前密钥；证据按完整实例身份（`pluginId` + `ghostId` +
    `namespace`，缺省即根）关联，同一 `pluginId` 在另一个 namespace 的实例拿不到它。电脑本机界面与同账号的其它控制端看不到，
    所以复用同一操作号的另一台控制端冒认不了。
  - 形状 `^[A-Za-z0-9_-]{8,128}$`；不合形状的操作号照常执行，只是不留证据。操作号不是机密，但不记日志。
  - 持久化在账本里，Host 重启、原操作回执丢失后仍然可用。控制端设备身份在重连、App 重启、Host 重启后不变；
    App 重装或重新配对后身份变了，或密钥重建后，旧证据不再投影，控制端按未确认处理。
  - 控制端回执过期后的核实：已装、`releaseId` 相同、`installedOperationId` 等于本次操作号，三者都满足才算已确认。
  - 账本兼容同 `sourceIdBinding`：只增可选字段，读取校验不检查它，旧记录缺省，降级时保留或重写丢弃，结果都是缺省。
  - 实现：`plugin-market/service.ts` 的 `withInstalledOperationIds`、`remotePluginManagement.ts` 的 `withOperations`。
- **白名单与缺省**：
  - `repository` 只含小写 host 加 2–4 段路径，整体匹配 `PLUGIN_MARKET_SOURCE_REPOSITORY_PATTERN`；用户名、密码、
    令牌、端口一律不读取。地址含 `?` `#` `[` `]`、空白、控制符、零宽或双向控制符、反斜杠、百分号编码、原始 `.` / `..`
    路径段、多个 `@`，或与 WHATWG URL 的解析有分歧时，整个身份不生成（见上文 `sourceId` 一节）。
  - 未配置 ref（缺省键、null、空串）时不给 `ref`；配置了但不合法时整个身份不生成。
  - 以下情况整个身份缺省，不给部分值：密钥不可用；版本目录没有可核实的取包记录（升级前取的旧缓存，下次刷新
    后补上；解析不一致；去敏生成不出）。
- **控制端合同**：
  - 形状校验：`originSource` 形状不对时整份回执按无效处理；条目里 `sourceIdentity` 形状不对只丢弃该字段；
    `installedSourceId` 不合正则时按缺省处理。sourceId 不展示。
  - `origin === 'custom-market'` 的确认回执或任务卡缺来源身份时，控制端不允许批准（不分首装和升级），提示回电脑
    确认；不能把只显示市场名当作已核对仓库。
  - 发起安装前，最后一次详情读取的 `sourceIdentity` 必须与用户选择时记下的完全相等，否则停止。
  - 回执过期后核实（「是不是这次操作」）：同时满足 `installState === 'installed'`、`releaseId` 与本次尝试相同、
    `installedOperationId` 等于本次操作号，才算已确认；缺任何一项都按未确认收口，不打开实例，也不重发安装或批准。
    `installedSourceId` 与 `originSource.sourceId` 一致只说明「来自哪里」，不能代替这一判定；它仍用于确认前的来源
    比对与换源判断。
  - 换源提示：`originSourceChanged === true` 时按上文三句规则选一句展示，只有确认里展示了仓库时才提「上面显示的
    仓库」。
  - 现状：电脑作为控制端时只展示 `originSource`，形状不对时只显示市场名。手机端由手机插件市场 PR #12684 接通，
    合入前手机不消费这些字段。
- **展示**：电脑端确认框、电脑作远程端时的确认、任务卡与 IM 卡在来源文案后追加「 · 仓库 …」或「 · 本地文件夹」；
  身份缺省时只显示市场名。
  实际地址与配置不同时只展示实际仓库，没有额外提示。
- **兼容**：只增可选字段，无需能力协商或版本门槛。旧控制端忽略新字段，确认仍只显示市场名。批准状态、回执、
  安装布局与 manifest 校验不变；账本只增上面的可选字段。密钥文件与取包记录可重建，缺失时只让身份缺省，不要求
  重装或重新确认。
- **已知边界**：
  - 取包前后的解析之间，本机 git 配置若在极短时间内被改，仍有无法完全消除的时间窗；多次比对排除了绝大多数情况。
  - 路径大小写按原样参与 `sourceId`：同一仓库的不同大小写写法得到不同标识，结果是保守的「未确认」。
  - 以 `.` 开头的路径段（如名为 `.github` 的仓库）、超过 4 段的路径、IPv6 主机生成不出 `repository`，Git 身份
    整体缺省，控制端按无法核实处理。
  - 升级后、到下次刷新前，Git 来源的旧缓存版本没有取包记录，身份缺省，控制端按无法核实处理；第一次刷新会改走
    全新克隆以建立可核实的记录。**窗口没有上限**：Git 市场只在添加时克隆、在电脑上手动刷新该来源时取包，没有
    定时刷新，手机或电脑作远程端也不会触发目标电脑刷新。这段时间控制端不能批准该市场的首装或升级；在目标电脑的
    插件市场来源列表里刷新一次即可消除。密钥重建后的窗口同理。后台定期刷新自定义 Git 市场由独立的 #4498 跟进，
    不在本改动范围内。
- **自建中转**：字段位于既有 resource invoke 的结果载荷与交互请求中，中转按原样转发 `payload`、不解析内容
  （`packages/device-link-relay/src/hub.ts` 的 `route`），握手、帧路由、顶层字段与能力协商都不变，因此无需同步
  修改中转。新增内容每项最多约 330 字节，单页目录最多 100 项，远低于 2 MiB 的帧上限。

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
