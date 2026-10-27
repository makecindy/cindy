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

企业组织成员需要发布时，调用 `ghost_forge_pack({ dir: '<绝对路径>', intent: 'publish' })`。
该意图不会弹装入确认，也不会返回可供自行拼接的 Host 路径；它只返回绑定本次包 id 与
完整字节的一次性 `publishToken`。随后把该票据传给
`ghost_forge_publish({ token: '<publishToken>' })`，工具会立即返回 `transferId`，发布在
后台继续；用 `ghost_forge_publish_status` 查询传输与审核状态。发布确认屏仍由用户明确
确认。成员发布仅企业组织成员可用，个人账号不可用；票据过期、换账号或重复使用后须重新
以 publish intent 打包，不能改传文件路径绕过。
