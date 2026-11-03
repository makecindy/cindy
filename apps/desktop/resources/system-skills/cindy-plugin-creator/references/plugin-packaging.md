## 7. 打包与测试

### 7.1 打包前轻量确认图标

准备调用 `ghost_forge_pack` 前检查一次图标。如果清单没有 `icon`，或者本次用了
`ghost_forge_scaffold` 且没有明确替换它生成的占位图，就视为图标尚未配置。此时只
**轻提醒一次**，不要把图标变成验收门槛，也不要擅自开始耗时的图片生成。提示与选项
使用用户当前对话语言：

- **使用 AI 生成（推荐）**：仅在用户选择后，调用当前可用的图片生成能力；它与当前
  聊天模型解耦，不要因为用户正在使用 GLM、Claude 等文本模型而切换聊天模型。把插件
  展示名与一句话用途填入下面模板后原样注入，不要临场追加文字、品牌或复杂场景：

  ```text
  Create a polished square app icon for a Cindy plugin named "{{name}}". Purpose: {{one-sentence purpose}}. Show one clear, original visual metaphor for that purpose. Use a clean geometric composition, a restrained natural color palette, high contrast, and a centered subject with generous safe padding so it remains readable at 32–48 px. Use one symbol only on a simple solid or transparent background. No text, letters, numbers, UI mockups, scenes, baked-in rounded corners, trademarks, copied brand shapes, watermarks, heavy gradients, inner shadows, or photorealism. Output a 1024×1024 PNG.
  ```

  只尝试一次。图片能力不可用、超时或失败时不要重试，保留占位图/宿主默认图标继续。
  缺省调用 `ghost_forge_pack({ dir })`；只有用户已明确要求当前 Agent 直接安装时，才改调
  `ghost_forge_install({ dir })`，不要让图标阻塞用户。
  生成成功后，从图片工具结果的 `xdt_image_url` 取单张地址；如果结果只有
  `xdt_image_urls`，取数组第一项(例如 `const selectedImageUrl = result.xdt_image_url ?? result.xdt_image_urls?.[0]`)。
  仅当它是 `cindy-media://` 地址时，才把它原样交给本次要调用的终点工具：缺省为
  `ghost_forge_pack({ dir, icon_source: selectedImageUrl })`；用户已明确要求直接安装时为
  `ghost_forge_install({ dir, icon_source: selectedImageUrl })`。主机会转成 1024×1024 PNG
  并嵌入安装包；处理失败时两种工具都会回退默认图标，不要再发起第二次生成。
  如果源码根目录已有 `cindy-signatures.json`，pack 会保留原图标和原签名，不做 AI
  图标覆盖；任何文件变更都必须交给发布流水线重新签名，不能静默降级信任等级。
- **上传图片**：让用户提供图片，保存到 `assets/icon.png`，并同步把
  `ghost.json` 的 `icon` 字段设为 `assets/icon.png` 后继续；不要要求用户先把图片
  处理成圆角，宿主负责最终显示形态。
- **使用默认图标（跳过）**：立即继续打包；scaffold 项目保留占位图，未使用 scaffold
  的项目可以省略 `icon`，由宿主显示默认图标。跳过与使用默认是同一个选择。

如果插件明确对应现有品牌或服务（如 X/Twitter、Notion），不要用 AI 仿制商标。将推荐
项改为“使用官方品牌图标”，只从品牌官网、官方开发者文档或官方媒体资源中查询并设置；
来源不可靠或获取失败时同样回退上传/默认，不延长创建流程。

### 7.2 打包、安装与验证

1. 新插件先调 `ghost_forge_scaffold` 生成骨架，或指向已有源码目录(如 `my-ghost/`)；
   脚手架目标必须是新目录，绝不覆盖已有文件，其父目录必须已存在且是普通目录；
   也不能落在已安装插件目录或 Host 状态目录内(会被拒，理由同下一条)；
   **Forge 源码必须是独立作者目录，不能是已安装插件或 Host 状态目录**。
   会话工作目录内直接建/打包；工作目录外(例如相邻 worktree)走当前会话权限:
   本地 Full Access 自动放行,Auto 交审阅,Ask 向用户确认,远程或无法核验的会话仍拒绝。
   已安装插件目录以及 Host 管理的状态目录都不是源码区，禁止直接修改、打包或用路径别名绕过；
   若要继续开发已有插件，先把源码复制/迁出到独立作者目录，再从该副本制作;
2. 调 `ghost_forge_pack({ dir: '<绝对路径>' })`——只做校验和打包，不安装或更新插件；
   产物落在源码目录里(`<id>-<version>.cindy`,同版本覆盖,下次打包自动跳过);
   macOS / Linux 源文件的普通 Unix 权限会原样进入包(特殊位会剥除)，所以随包本机
   可执行程序必须在打包前就设好执行位(例如 `chmod 755 path/to/program`)，不要靠
   文件扩展名或 `bin/` 目录让宿主猜测;
   若返回 `SOURCE_IS_INSTALLED_PLUGIN`,不要重试或换大小写、软链接、junction 绕过,
   按上一步迁出源码后再打包;未获会话权限时也可能返回 `SOURCE_OUTSIDE_WORKDIR`;
3. 用户明确要求当前 Agent 安装或更新这份源码时，调用
   `ghost_forge_install({ dir: '<绝对路径>' })`。它会重新校验并打包当前源码，再安装这次
   产生的确切包：首次安装、以及权限比已装版本变多的更新，会先在任务里弹确认卡列出权限，
   用户允许后才落位；用户拒绝返回 `MUTATION_CANCELLED`，不要重试，除非用户再次要求。
   首次安装会启用，同 id 已安装时原位更新并保留启用状态、配置、
   数据与面板位置，同版本也可覆盖。同来源更新延续旧数据；从市场等不同来源切换到 Forge
   时旧账号、密钥及数据隔离保留，新来源需要重新连接。不要因为 scaffold 或 pack 成功就自动调用本工具。
   新装默认个人范围（root / `namespace:null`），不能因为用户登录了组织就另装为组织插件。
   已有个人实例优先原位更新；只有唯一旧组织实例时仍原位更新，不迁移其账号与数据。
   只有用户明确要求组织安装时才传 `namespace:'<当前组织>'`，不能仅按裸 id 或登录组织推断归属。
   无法唯一确定已有实例时返回 `INSTALL_TARGET_REQUIRED`，不会自动另装并启用。
   展示 `targets` 中的身份、版本与更新来源影响，让用户选择；更新已有实例时传
   `target_instance_id`，明确另装一份时传 `install_copy:true`，两者互斥。
   `namespace` 与 `target_instance_id` 互斥。新副本也默认个人范围，组织副本需明确传
   `namespace`；需要单独连接账号，不覆盖、停用或迁移其它实例。
   换源或已有其它副本时，任务确认卡会说明安装位置及账号影响。成功结果包含真实
   `instanceId` 与 `namespace`，后续查询与调用沿用该身份，不按裸 id 猜测。
   企业身份下若清单声明 `source:"oidc-token"`，提交安装前会展示插件名、id 与精确请求
   域名，并要求用户手输相同 id；取消不会安装。个人与企业身份下的明确 Forge 安装都会标记为
   作者本地自测并受组织默认插件自动接管保护；但 Connection JWT 资格仍只来自当前企业身份、
   组织前缀与 OIDC 窄确认，个人身份下的 Forge 安装绝不会仅凭自测标记取得 Broker 或 Connection 权限，
   普通手动导入也不取得这项资格。
   本地安装另有一条临时例外，只对 root 实例生效，见 §4.7：仅 `ghostId` 精确等于 `mivo-canvas`、namespace 为 null 或尚未确认，且精确 oidc-token host 仅为 `mivo-canvas.dsworks.cn` 的组织成员本地安装可解析 audience；
4. 安装后再让用户 `$<command> <内容>` 试一单，看聊天图卡/面板是否符合预期。

发布前先确定目标：沿用用户在当前请求与上下文中已明确的发布目标；仍无法确定是公开市场还是当前组织时，
先询问“发布到公开市场，还是当前组织？”，确认后再选择对应提审工具。不得仅根据登录身份推断发布目标；
目标已明确时不重复确认。

用户明确要求发布到当前组织时，调用 `ghost_forge_pack({ dir: '<绝对路径>', intent: 'publish' })`。
该意图不会弹装入确认，也不会返回可供自行拼接的 Host 路径；它只返回绑定本次包 id 与
完整字节的一次性 `publishToken`。随后把该票据传给
`ghost_forge_publish({ token: '<publishToken>' })`，工具会立即返回 `transferId`，发布在
后台继续；用 `ghost_forge_publish_status` 查询传输与审核状态。发布确认屏仍由用户明确
确认。成员发布仅企业组织成员可用，个人账号不可用；票据过期、换账号或重复使用后须重新
以 publish intent 打包，不能改传文件路径绕过。

## 7.3 向公开市场发布插件

个人账号和组织成员向公开市场投稿使用独立入口：先在作者源码目录开发、安装并实际使用插件，再调用
`ghost_contribution_prepare({ ghost_id, namespace: null })`。Host 固定当前精确安装的包并返回
只读发布摘要：实际版本、包内更新说明以及提审阻塞原因；此时没有创建上传或占用版本。
首次上架不要求更新说明，插件用途写在 `description`。插件曾上架后再提审时，须在 `ghost.json` 顶层写入 `releaseNotes` 纯文本字符串（v2、v3 均支持），完整描述相对上一已上架版本的全部变化。
例如文本工具的更新说明可写“相较已上架的 1.0.0：新增 UTF-8 字节数统计，修复末尾空行计数”。
示例须核对源码与实际变化，不自动套用。该字段随包携带，不在发布时另填资料。
缺字段的包仍能打包和安装；只有曾上架插件的更新缺少非空说明时，预检才返回 `RELEASE_NOTES_REQUIRED`。从未上架的退回或取消不视为更新，下架不免除更新说明要求。

安装与运行批准不证明作者身份，也不授予公开发布权。首次发布只接受 Host 可核实的本地包或 Forge 开发安装，属于等待人工审核的发布申请，不是作者认证。
官方 public 插件必须通过 GitHub 仓库提交修改，不允许经客户端（含 Agent 工具）提审，以保证仓库源码完整、便于后续维护。普通第三方公共插件仍沿既有授权流程。
从公共市场下载的第三方插件，只有当前账号已有精确提交授权且 Host 核实原安装来源时才能提交更新；Git/本地自定义市场、私域或来源无法确认的安装不能转作首发。
可读取发布历史不等于可提交更新。旧发布回执、同名、包内 author 或相同包摘要均不能替代当前授权；提交时仍核对账号、安装、批准与来源。
已有明确公开发布委托时，先读取摘要并确认包内说明适用，再调用
`ghost_contribution_submit({ prepared_id })`。Full Access 直接执行，Auto 走现有审阅，Ask 走既有权限卡，
不要求额外的最后人工点击。Host 在提交前再次检查已安装内容，变更后必须刷新摘要，不能悄悄替换包。
用户已明确委托发布时，不再另问一次是否发布。预检有 blockers 时先说明具体原因；需要改包则回到
现有作者源码，用原 Forge 工具修改、安装更新后重新预检，不直接改 Host 管理的安装目录。

预检或提交返回 `PLUGIN_GHOST_ID_CONFLICT` 时，冲突指 `ghost.json.id`，不是显示名称；按错误码判断，不依赖服务端文案。先停止继续提交：

- 发布另一款新插件：说明标识已被使用，获得用户同意后才修改作者源码中的 `ghost.json.id`，沿原 Forge 流程重新打包、安装后预检，不直接改 Host 管理的安装目录。
- 更新已有插件：保留 ID，核对当前登录账号及 `ghost_my_plugins` 返回的当前提交权限；没有权限则说明并停止，不自动切换账号，不改 ID 或换发布入口绕过。
- 无法判断是新插件还是已有插件更新：先询问用户，不能自行选择改 ID，也不重复提交相同请求。

权限拒绝按原任务权限处理，返回原因并停止，不切换权限或借其它入口重试。
当前个人账号与组织成员的普通任务均可向公开市场投稿，插件归提交者本人管理，不赋予组织管理员其他成员投稿的管理权。组织内部发布仍使用原 Forge 流程。共享访客及插件托管任务不能借用房主账号。

一次成功提审永久占用该插件的版本号，退回、取消或下架都不能复用；修改后需要换版本号、重新安装再提交。
每个插件同时只能有一个待审版本。`ghost_my_plugins` 读取本人插件及精确版本结果；停止上传用
`ghost_contribution_stop`，不等于取消审核。取消待审用 `ghost_cancel_plugin_review`，传本人详情返回的
plugin_id、release_id、sha256 和 revision；取消保留版本与记录，当前上架版不变。审核已结束时返回实际终局。
不设计多作者代取消。

提交返回本次进度标识，用 `ghost_contribution_status({ local_id })` 查询到本次动作结束。
202 / processing 仅表示提交仍在处理，不等于待审核；结束后用 `ghost_my_plugins` 查看审核结果。
没有上传记录列表或 resume 参数。提交失败后先用 `ghost_my_plugins` 核对该版本是否已有提审记录；已受理则查看真实审核结果，不绕过版本或待审限制再次提交。仅预检仍允许提审时，Host 才沿既有防重复处理核对尚未确认的同包请求。
只有服务端回执、实际审核及市场可用事实才能说明已提审、已通过或已上架。

`ghost_my_plugins` 的 plugin_id 读详情，submission_id 读精确留存包内容，cursor 为分页。
时间取真实提审/通过/取消事件，未知为未知；当前市场和所选版本分开读取。旧版上架而新版被退回时
完整保留旧市场版本与退回原因。作者在“发布插件”的独立管理页查看使用中、已上架和待审核版本；普通插件详情仍用于使用和配置，
只有本地来源插件提供“提交审核”快速入口，管理页的后续提交入口为“提交新版本审核”，不支持提交时不展示管理页提交按钮。
插件列表沿用主线原有来源展示，不用来源标签表示作者身份或审核、上架状态；发布情况在“发布插件”中查看。
选择发布历史只改变所查看的快照，不切换使用版本。审核结果在应用内提示未读，不新增外部通知、
不让审核人修包、不依赖先上线分享页。
已有 public 插件权限由服务端精确 ACL 决定，包内署名、本地安装与同名均不证明权利；私域不经此入口转公域。

## 7.4 平台署名

个人投稿暂不返回平台展示署名；服务端仍完整保存作者绑定、提审昵称快照和审计记录。
客户端保留原有署名展示逻辑，以服务端返回值为准，不从包内信息或当前账号昵称补齐。
客户端界面与 Agent 工具均不提供匿名设置，不要通过写文件或调用未声明接口修改匿名状态。
不要在 `ghost.json` 中添加 `anonymous` 字段；包内 `author` 也不能指定平台的可信发布署名。

昵称按相应版本提审时的账号信息保存，改名不改写旧快照。当前个人发布按单作者流程使用，不提供多人协作入口。
隐藏平台展示署名不会清除作者写进源码、README 或包内的个人信息。
历史内容和更新说明按对应版本的提审快照展示，不用当前本地包补写历史。
可信官方来源固定署名 Cindy；组织插件沿用原有发布与署名规则。
不把本地安装或提交资格当作作者身份。
