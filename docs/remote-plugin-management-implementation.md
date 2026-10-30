# 远程插件管理：设备切换与安装配置

基线：2026-10-14，canonical `makecindy/cindy/main`，`a3aa86a6babed0068cbd2171e6ca4d65d66ed128`。
自有 worktree：`jolly-stallman`；分支：`cindy/jolly-stallman`。实施阶段仅本地开发、验证及 DCO 提交；2026-10-15 用户追加授权推送与创建 PR，未授权合并或发布。

## 页面与行为契约

- 插件与技能是同一管理页面的两个一级页签，共用单选电脑入口；默认本机，候选仅为同账号获准控制的电脑。切页签保留电脑，不把远端技能替换成本机数据。
- 2026-10-14 用户复核选择“插件和技能统一按电脑管理”，最新裁决要求页面标题右侧只有一个电脑下拉，项目放在其中的“更多”子菜单。切电脑后项目目录、项目开关和目标 Host 一起变化，项目选择不筛推荐。手动包安装放“添加插件”菜单。
- 远程技能复用目标 SkillHub 扫描、市场、启停与安装器；身份由 Host 扫描产生，不接受控制端路径。旧 Host 无技能能力时显示升级提示；卸载只移入系统回收站，目标实例变更后旧确认失效。
- 本机数据仍使用既有全窗口 store；远程页面分别读取目标 Host 的 plugins/skills 资源，不覆盖本机清单。
- 目标离线保留选择和可识别状态，禁止写入；撤权/切号作废旧请求。旧 Host 无管理能力时给出升级提示，绝不回退本机执行。
- 操作绑定账号、目标电脑、物理实例及批准版本。权限确认来自目标实际包，控制端确认，目标原安装器落位前再次校验。
- 安装操作返回可查询回执；等待确认不占用 relay 请求或安装锁。超时只查询原回执，不自动重装。
- 配置直接展示目标插件的原 settingsHtml；读取、保存和授权由目标 Host 的既有接口执行，结果回到原页面。凭证只在目标保存，不创建假任务。
- 市场与企业可见性来自目标账号和来源；手动包经既有安全文件传输后在目标检查。控制端路径不作为目标路径。
- 所有新增 UI 使用现有语义 token，覆盖 Light/Dark。配置失败/取消保留已存凭证。

## 用户可见计划

1. 在插件与技能的页面标题右侧共用一个电脑下拉，在“更多”子菜单选择这台电脑的项目，展示对应清单与启停状态。
2. 接通目标电脑的安装、升级、卸载，当前设备确认、目标电脑执行并回读结果。
3. 接通详情配置，复用已有 OAuth / API Key / connection 加密桥；已有统计跟随设备。
4. 验证断线、切设备、同名插件、旧端兼容，交付当前提交的真实页面截图和测试结果。

### UI Implementation Contract：远程原设置页（2026-10-15）

#### Objective / Inputs

以用户最新裁决为准：A 展示 B 上插件原有设置页，读取、保存和授权由 B Host 执行；结果在原页面回显，凭证保存在 B。此前用配置摘要生成逐凭证 Configure 的方案撤回。

#### Scope / Current Implementation Map

复用本机 GhostSettingsWebview 的布局、主题与自适应高度。B 复用 MobilePluginPages 页面租约、安装包资源读取、原 BroadcastChannel 逻辑沙箱，以及 electronSandboxAdapter 的 KV、secret、OAuth、connection 原执行器。A Main 承载临时独立分区；配置值只经过签名并加密的 v3 通道。

#### ASCII To Layout Contract

- 插件详情「配置」下直接出现原设置页，不按凭证类型拼新表单，不附加状态摘要或远程桌面替代入口。
- 模型、任务和侧栏偏好仍使用本机原有的 Host 控件，读写改为目标 Host。没有 settingsHtml 的插件不生成空 Configure。
- 停用态只显示先启用的提示。离线、切目标、切号、撤权或安装实例变化后关闭旧页面；重连重新读取，不重放写操作。
- 原设置页保持自己的保存按钮、账号行、加载和错误状态。成功、取消、短时操作失败用既有悬浮 Toast，不改变文档流；未知结果的恢复动作只读回执。

#### Platform Mapping / File-Level Plan

| 平台/模块 | 处理 |
| --- | --- |
| Desktop Renderer | adapt：GhostSettingsWebview 增加远端来源；RemotePluginConfiguration 只组合原页面和既有 Host 偏好 |
| Desktop A Main | new：受信任 open/close IPC、临时分区、资源/接口代理、原 OAuth 浏览器桥；零 Node、零 preload、拒绝跨源网络与任意导航 |
| Desktop B Host | adapt：desktop settings lease 与密封请求分派；不要求插件补发 mobile 声明 |
| Mobile | reuse：既有适配页面与原生配置桥保持原有行为；本轮不新增原生入口或 fingerprint 输入 |

#### Validation Matrix

真实同机双沙盒 A/B：原搜索页偏好保存/重开、已有飞书账号回读、TapTap 原页面和 BroadcastChannel、fixture 新 Key 仅存 B；Light/Dark、窄窗口、离线与切电脑。白盒覆盖密封通道、实例/账号/批准/控制设备绑定、旧 Host、迟到响应、取消与原端点持久化检查。两台物理电脑与 Windows 没有证据时明确未验证。

#### Open Questions / Approval Gate

产品方案已由用户明确授权。沿当前 Draft PR 开发、验证和更新，不另建任务/Issue/PR，不请求合并。下面的历史配置摘要与远程桌面边界记录仅代表对应旧提交，已被本合同替代。

## 范围

不复制已有凭证、不持续同步配置、不导出保险库、不合并跨设备统计，不新增依赖、服务端能力或原生 fingerprint 输入。
统计功能以本次 canonical main 中已存在的能力为准，其他未合分支不接管。
2026-10-16 合并 main 后保留本机个人调用统计及清除功能；远程卡片与详情的作者、下载和共享使用数据取自目标市场快照。个人调用记录尚无远程读取／清除接口，远程详情不展示控制电脑的同名插件记录。
插件基座的指定维护者 Approve 保留为合并门；远程 Issue 创建、合并和发布仍不在授权内。

## 首轮验证记录（本地提交 `a2ba9c822`）

### 已实现

- 本机/同账号电脑单选，独立远程清单、目标市场、插件详情、启停；离线保留目标和清单，禁写。
- 目标市场安装和逐项升级、卸载、手动 `.cindy` 导入/更新；原安装器和锁外权限确认。
- 每个控制设备独立的内存操作回执，切目标/切号丢弃晚响应，断线后只查询原操作。
- 详情原生配置沿现有 OAuth/API Key/connection 加密桥写目标；无假任务或凭证复制。
- Main 跨模块依赖由既有 bootstrap 静态注入，保持插件模块的加载边界。
- 同名 root/org 插件按物理实例和批准版本定位；远程卡片不展示本机未读内容。

### 仍需验收或明确边界

- 已从隔离 Desktop 选择真实同账号在线旧 Host，成功只读其插件列表并显示升级提示。
  新版 Host 的双电脑写操作、OS 密钥存储、真实第三方 OAuth 及实际安装/卸载仍未实机联调。
  所有变更性验收只使用隔离 sandbox、虚构凭证与 fixture。
- 自定义 HTML 设置页不能嵌入 Desktop 主窗（既有 CSP 禁止 iframe）。详情明确指向目标
  电脑设置页，提供现有远程桌面补充入口。原生加密配置可直接使用，不依赖远程桌面。
- Mobile 原有列表/详情/启停与页面保持原行为；未新增手机安装、升级、卸载的原生入口。
- 首轮基线尚未合入统计任务；2026-10-16 的当前统计边界见上方「范围」。
- 市场自定义图标的目标本地 key 不在控制端解析，显示通用图标；自定义市场可见目录来自目标。
- 来源冲突通过明确卸载后安装处理，不提供静默替换；远程升级逐项进行，不重用本机批次单例。
- 回执保留 15 分钟，Host 重启或回执过期后只能重新查看目标事实；无法保证持久恢复。

### 自动与运行证据

- 最终定向回归：12 个文件、275 项通过，覆盖本机卡片/详情/导航、远程页面、Host 管理、
  coordinator、原页面 provider、签名/加密桥及 taskless Secret/connection 提交。
- 实例/owner 租约和用户数据队列：3 个文件、22 项通过。
- Main 导入、帮助和模型切换：4 个文件、107 项通过；修正了开发中新增依赖造成的循环加载。
- Desktop / Mobile 类型检查通过；共享 Device Link build、手机原页面 6 项回归通过。
- 五语种新增文案、术语检查、生成 bootstrap 一致性及 diff 空白检查通过。
- `pnpm test:all` 根 runner：582 项，576 通过、4 失败、2 跳过。四项 restart-desktop
  用例在原始基线 archive 原样复现，相关脚本未改，完整门禁未通过。
- 额外 workspace unit/guard：除初次 Desktop 外其他要求的 workspace 均通过（含 Mobile、
  maker-core、Device Link）。初次 Desktop 循环加载和参数契约失败已修正，最终定向复验通过。
- 额外不排除 integration 的完整 Desktop：3654 文件通过、10 文件失败、5 跳过；
  55617 项通过、56 失败、87 跳过。残余在 Cindy Make Git integration、真实 Claude e2e、
  Pi Gateway integration、浏览器 profile、剪贴板、导入和 DB 性能等路径；本次未修改这些
  文件，不把完整检查报成绿色。并发超时与外部运行条件仍需其拥有方核查。
- 最终隔离 Desktop 启动：`DESKTOP_DEV_VERDICT=ready`，Global、worktree sandbox，
  未执行真实凭证配置、安装或卸载。远程新功能截图来自本工作区生产组件的 headful Chrome fixture，
  清楚标注“生产组件 · 隔离测试数据”，不冒充新版 Host 的双机写操作验收；另附实际旧 Host 的只读截图。

### 页面截图与复现

fixture：`apps/desktop/scripts/fixtures/remote-plugins/index.html`，在本 worktree Desktop Vite
端口以 `/@fs/<绝对路径>/apps/desktop/scripts/fixtures/remote-plugins/index.html?theme=light`
打开；`theme=dark` 切换主题。测试传输只在此入口注入，不进入产品构建。

截图保存在本次交付的本地 evidence 目录 `/tmp/cindy-remote-plugin-evidence`，包含
Light/Dark × 1160/560 宽的列表、电脑 B、详情、离线，以及安装确认、成功回读、
实际本机插件页和真实旧 Host 的只读列表。
无横向溢出，A/B 插件版本不同，root/org 同名实例区分，离线不回退本机。
最终提交 SHA 与图片哈希见 evidence 的 `manifest.json`。`local-sandbox-current.png` 和
`real-old-host-readonly.png` 是实际 Desktop 运行截图；其余为最终 UI 源码对应的 headful
Chrome 实拍，其中设备、市场与安装结果是 fixture。新版 Host 的双机写操作验收仍未完成。

## 插件与技能共同电脑范围：2026-10-14 复核修正

用户指出插件和技能在体验上属于同一管理入口，并明确选择“插件和技能统一按电脑管理”。
本轮在既有本地提交上修正该层级，不接管其他分支，也不创建额外开发任务。

- 电脑选择在两个页签间共享，切电脑、切号和离线分别校验；旧 Host 的只读/升级提示仍保留
  插件和技能入口。远程技能不触发本机扫描，隐藏的插件页不自动刷新目标市场。
- 目标技能列表与详情展示真实版本、全局/项目范围、公开/团队来源及启停状态。同名副本按
  目标物理实例区分。启停、市场安装、原位升级和卸载复用原 SkillHub 扫描、安装锁、备份及
  回收站逻辑。插件托管技能保留原管理边界，不绕过所属插件。
- 安装/升级/卸载由当前电脑的原生确认框展示目标事实；Renderer 无法直接提交批准。
  Host 在原安装器提交前再核对实例、项目许可、账号与连接代次。等待确认不占用安装锁；
  两个相同并发请求只分配一个回执，断线未知结果仅查询原操作，不重放安装。
- 本轮新增协议是远程资源的可选 `skills` 集合；旧 Host 无能力时提示升级，不回落本机。
  本机 IPC 原权限与旧安装器参数均保持兼容，无新依赖、持久格式或原生 fingerprint 改动。

### 本轮验证与证据

- 最终定向回归：11 个文件、268 项通过。覆盖共同电脑选择、旧端页签、隐藏页签、晚响应、
  离线、原生批准边界、并发幂等、实例变更、安装前租约失效及本机 SkillHub 既有行为。
- Desktop 类型检查通过；五语种文案、术语和文档检查通过。i18n key 一致性通过，检查器
  另有 1300 处警告；术语检查保留 18 处已有 proposed 警告。`pnpm test:all` 本轮仍为
  582 项、576 通过、4 失败、2 跳过；失败是先前已在基线复现的 restart-desktop 环境用例，
  本轮未修改相关脚本，完整门禁仍未通过。
- 隔离 Desktop 启动成功。真实旧 Host 只读核对插件→技能→插件，目标电脑保持不变；
  技能页正确显示缺少能力提示，没有显示本机技能。未对真实用户技能执行变更。
- headful Chrome 运行当前生产组件的隔离 fixture：22 张截图，覆盖 Light/Dark、
  1160/560 宽、共同页签、A/B 不同版本、同名全局/项目副本、详情、离线及取消确认。
  无横向溢出或页面异常，离线写入禁用。fixture 的确认框标注为测试替身，不冒充 OS 原生框。
- 当前截图目录为 `/tmp/cindy-shared-catalog-evidence`。`actual-old-host-plugins.png` 与
  `actual-old-host-skills.png` 来自真实隔离 Desktop；其余 22 张来自生产组件的 headful
  Chrome fixture。最终提交、源码和图片哈希记录在该目录的 `manifest.json`。

### 未验证与本轮边界

新版 Host 的真实双机写操作和 OS 原生确认交互仍未实机联调；自动验证使用 sandbox 与
fixture。技能文件手动导入、编辑和发布仍是既有本机流程；本轮远程安装来自目标 SkillHub。
Mobile 可通过通用资源读取技能列表/详情，但未新增手机技能安装/升级/卸载的原生入口。
统计分支、凭证复制、配置同步和保险库导出仍不在本轮范围。回执仅内存保留 15 分钟，
Host 重启或回执过期后需重新读取目标事实，不能宣称持久操作恢复。

## 已安装与发现层级重设计（2026-10-14）

用户指出页级电脑/项目选择会让人误以为它们也筛选推荐，并明确授权重新设计。
本轮行为合同见下方；只修改 Desktop Renderer、五语种文案、回归和 fixture。

### 最终行为

- 顶部保留插件/技能页签与搜索；两页共用所选电脑，电脑控件归入已安装标题。
- 插件项目控件明确显示“启用范围”，位于已安装标题旁；只改项目启停，不筛推荐、
  不改变包的安装位置。原安装器、配置桥、卸载和批准记录不变。
- 技能先显示已安装的全局与项目副本，下方再显示推荐；公开/团队只筛发现区。
  旧 local 路由与历史状态继续接受，详情返回、搜索和浏览器历史保留。
- 推荐显式标明“安装到：目标电脑”；沿用目标 Host 的可见来源与安装状态，
  不把自定义源或“目标未安装”假装成各电脑完全相同的推荐。
- 在线检测与控件位置解耦：进入详情后移除列表控件，断线仍禁写；旧端/离线
  仍保留电脑选择。无新依赖、Main/协议、持久格式、Mobile 或原生指纹改动。

### 本轮验证

- 8 个 Desktop 定向文件、122 项通过：共同电脑、项目不改推荐、公开/团队不改
  已装清单、详情断线、旧端可切电脑、本机卡片和详情/浏览器/设置导航。
- Desktop 类型检查、五语种 key 一致性、术语及文档检查通过。i18n 检查仍有
  1300 处警告；术语保留 18 处已有 proposed 警告，未扩大基线。
- 本轮是 Renderer 布局与行为调整，未重复全量门禁；前轮根 runner 的 4 项已复现
  环境失败仍未解决，不把本轮定向通过冒充完整 CI 通过。
- headful Chrome 生产组件 fixture：34 张 Light/Dark、1160/560 宽截图；
  电脑归入已安装、切页签保留目标、来源筛选保留已装、安装目的地同步、详情断线
  禁写均通过；无横向溢出或页面异常。确认框仍是标注清楚的 fixture 替身。
- 真实隔离 Electron：本机插件/技能和旧 Host 各 2 张只读截图，已安装区域的
  电脑控件与旧端提示/页签保留已验证。当前 sandbox 无近期项目候选，真实项目
  选择未验；项目不改推荐通过隔离 IPC 回归验证。未操作真实安装、卸载或凭证。
- 当前证据目录：/tmp/cindy-installed-catalog-evidence。34 张 fixture 与 4 张
  actual-* 截图，最终提交/源码/图片哈希见 manifest.json。新版 Host 真实双机
  写操作、OS 原生确认和 OAuth 的既有未验证项保留。

## 电脑与项目联动修正（2026-10-14）

用户最新复核指出，项目筛选仍然是有效的独立开关管理；新增电脑后，应先选电脑，项目
列表和项目开关跟随目标 Host。此前把控件放在“已安装”标题的布局已撤回。

### 页面与行为合同

- 插件与技能页顶部保留现有页签和搜索；标题右侧按“电脑 → 全局/项目”的顺序提供管理范围入口。两页共享电脑选择，切换页签保留目标电脑。
- 电脑选择决定已安装清单、项目列表、项目启用状态、详情动作和安装目标；目标电脑离线时保留选择并禁用写操作，不回退到本机。
- 插件项目选择只控制当前目标电脑上该项目的启用范围。它不筛选推荐、不改变安装位置，也不影响全局启用；切换电脑后项目选项和状态从新 Host 重新读取。
- 推荐目录继续使用来源筛选；推荐内容不会因为项目选择而变化。安装、升级、卸载和导入都明确作用于标题右侧选中的电脑。
- 旧 Host 没有项目能力时保留电脑选择，并将项目入口降级为不可写的升级提示；已有全局插件管理继续可读。
- 详情页沿用原有目标信息和返回路径；详情中的启停按钮使用当前电脑与项目状态，并在状态读取失败、离线或操作进行中时禁用。
- 本机仍使用现有项目偏好和插件 store；远端只读取目标 Host 的项目投影，不传递控制端路径，不覆盖本机单例。

### UI Implementation Contract


#### Objective
把电脑选择与启用范围归入已安装管理，明确发现目录和安装目的地。

#### Inputs
2026-10-14 用户的两张标注截图、层级反馈与“重新设计吧”指令。

#### Scope
Desktop 插件/技能首页、本机和远端展示、Host 项目投影、旧 Host 与 fixture。复用既有
远程资源、安装、批准和权限行为；不改服务端、存储、依赖、Mobile 原生指纹或凭证同步。

#### Current Implementation Map
`CatalogDeviceScope` 负责在插件/技能页签间共享目标电脑；插件项目选择读取所选 Host
的项目投影并独立提交启停 revision。推荐来源筛选与已安装范围保持独立，本机 store
和远端资源保持分离。

#### ASCII To Layout Contract
```text
插件 / 技能                         搜索、现有添加动作
页面标题与简介                    [电脑] [全局/项目（插件）]
已安装 [数量]
已安装清单、对应的加载/离线/错误/空态
推荐                 [来源筛选]
安装到：选中电脑
目录卡片
```
- 电脑在两个页签共享，固定出现在页面标题右侧；详情显示原有目标信息，返回可切电脑。
- 插件项目选择标注“启用范围”；不影响目录、安装位置或已装集合。
- 技能已装区域常驻，电脑切换后列表和安装目的地同步；公开/团队只切换下方目录，保留旧 local 路由/历史返回。
- 公开目录不因项目选择变化；目标 Host 自定义来源、权限和已装状态仍为真相。
- 目录显式显示安装目的电脑。离线保留目标并禁写，旧 Host 的电脑控件仍可用。
- 920px 现有内容 frame、双列/窄窗口单列；标题控件可换行，不新增卡片嵌套。
- Light/Dark 使用原语义 token 和原下拉/按钮。

#### Platform Mapping
| 项目 | Desktop | Mobile |
| --- | --- | --- |
| 页签/内容 frame/卡片/动作 | reuse | defer |
| 已安装标题、电脑和范围位置 | adapt | defer |
| 目标服务和权限确认 | reuse | defer |

#### File-Level Plan
调整 `useCatalogDevice`、`PluginDevicePicker`、`PluginManagementLayout` 和四个首页；
更新五语种文案、已有导航/远端回归、fixture 与实施记录。

#### Validation Matrix
定向 Desktop 回归与类型检查；i18n/术语与文档检查；headful Chrome 生产组件
Light/Dark、宽/窄、切页签、切电脑、来源筛选、离线和旧端，真实隔离 Electron
只读本机/旧 Host。所有变更验收用 fixture，不操作真实用户数据。

#### 本次交付复核（2026-10-14）
- `pnpm test:unit:related` 通过：Desktop 相关 60 个文件、17,269 项通过，3 项跳过；
  定向插件/技能与 Host 回归另有 6 个文件、81 项通过。
- Desktop `typecheck`、`check:i18n`、`check:i18n-glossary`、`check:dev-docs` 和
  `git diff --check` 通过；i18n 保留 1,300 条既有警告，术语保留 18 条已有
  `proposed` 告警，均未新增。
- `pnpm restart:desktop:remote -- --isolated=@worktree` 返回
  `DESKTOP_DEV_VERDICT=ready`，当前 worktree 使用隔离 sandbox。
- headful Chrome 生产组件 fixture 截图位于
  `/tmp/cindy-linked-project-evidence`：Light/Dark、1160/560 宽度、项目下拉、
  项目开关和切换到“工作电脑”均来自当前源码；无横向溢出。fixture 确认框是测试替身，
  不作为 OS 原生确认验收证据。新版 Host 双机写操作、真实 OAuth、安装/卸载仍未实机验证。

#### Open Questions
无阻断问题。假设沿用已有推荐排除目标已装项与目标自定义市场，不修改来源语义。

#### Approval Gate
用户已明确授权重新设计，执行本地实现、验证和 DCO 提交；不推送/建 PR。
Do not implement outside the authorized scope; no further approval is needed for this contract.

## 单一下拉与父子层级修正（2026-10-14）

本节覆盖此前两个并排按钮的布局。用户最新裁决是一个电脑下拉，项目位于其“更多”
子菜单中；电脑与项目为父子关系。“导入 .cindy”是手动插件包安装，不属于范围选择。

### UI Implementation Contract

#### Objective
保留页面标题右侧的位置，用一个下拉表达电脑与其项目的关系，并将文件安装归入添加插件。

#### Inputs
2026-10-14 用户要求“一个下拉，选择电脑，更多里选择项目”，并质疑已安装区的导入入口。

#### Scope
Desktop 插件/技能首页、共用电脑控件、项目菜单、添加菜单、回归与 fixture。
保留已有 Host 项目动作、权限确认和文件传输；本轮不改 Main、协议、Mobile 或依赖。

#### Current Implementation Map
`CatalogDeviceScope` 共享电脑；`PluginDevicePicker` 提供电脑选项；`PluginScopePicker`
拥有本机目录/Host 项目候选；`GhostPluginActions` 拥有添加动作。现有两个独立菜单
只需组合成一个电脑菜单及项目子菜单，不另建项目或设备状态。

#### ASCII To Layout Contract
```text
插件 / 技能                            搜索、[添加插件 ▾]
页面标题                               [选中电脑 / 项目 ▾]
                                        当前电脑
                                        其他获准电脑
                                        更多              → 全局（默认）
                                                            该电脑的项目
已安装 [数量]                                              本机可选其他目录
已安装清单与项目开关
推荐                                    [来源筛选]
安装到：选中电脑
```
- 标题右侧只渲染一个下拉触发器；未选项目时只显示电脑名，选项目后在同一触发器显示其名称。
- “更多”子菜单提供现有全局/项目范围；候选、状态和动作只属于所选 Host。切电脑重置项目，切页签保留电脑。
- 离线/旧 Host 不禁用电脑选择，项目入口按真实能力禁用；长名称可截断且保留完整 title，窄窗口可换行。
- 本机目录选择仅在本机子菜单内；技能保持现有全局/项目副本语义，不新增技能项目筛选。
- 文件安装放在顶部“添加插件”下拉，文案为“从文件安装…”；远端复用原安全传输和安装确认。已安装标题旁不再出现导入。
- 推荐来源与安装目的地继续沿现有逻辑；主题、菜单、按钮均复用语义 token 和原生键盘交互。

#### Platform Mapping
| 合同项 | Desktop | Mobile |
| --- | --- | --- |
| 电脑入口与项目子菜单 | adapt，共享菜单组件 | defer，保持既有原生入口 |
| 添加插件与文件安装 | reuse，调整动作归属 | defer |
| Host 动作/身份/确认 | reuse，不改 wire contract | reuse，保持已有行为 |

#### File-Level Plan
调整 `PluginManagementLayout`、`PluginDevicePicker`、`PluginScopePicker`、
`useCatalogDevice`、插件/技能首页及 fixture 的控件数据；复用 `GhostPluginActions`，
同步五语种文件安装文案与定向回归；`GhostPluginActions` 提取为本机/远端共用的直接组件。

#### Validation Matrix
定向组件交互、页签/设备/项目、文件安装回归及 Desktop 类型检查；文案/术语/文档检查；
本地 headful Chrome 生产组件 Light/Dark、宽/窄、电脑菜单/更多子菜单、切电脑/页签、
离线/旧 Host 与文件安装入口实拍。所有写操作仅在 fixture 内执行。

#### Open Questions
无阻断问题。项目入口放在选中电脑菜单底部的“更多”子菜单，避免增加第二个页级触发器。

#### Approval Gate
用户已授权本地调整、验证与 DCO 提交，无需重复确认。不推送、建 PR、发布或创建额外任务。

### 本次验证与交付

- 保留自有分支 `cindy/jolly-stallman` 和任务基线 `a3aa86a6b`；跟进前执行共享 preflight
  与 branch alignment，分支仍为 local-only。2026-10-14 查询到 canonical main 为
  `3312cc699`，没有混入其他 worktree 的改动。
- 7 个 Desktop 定向文件、135 项通过：单一电脑菜单、项目子菜单键盘选择、本机目录选择、
  项目 revision/实例绑定、切电脑重置、旧 Host、断线、文件安装目标、共同页签及卡片/详情。
  Desktop 类型检查、修改的产品 UI ESLint、五语种 key 一致性、术语、文档和 diff 空白检查通过。
  i18n 仍有 1,300 条既有警告，术语保留 18 条已有 proposed 告警。
- 本地 headful Chrome 对当前生产组件 fixture 实拍 23 张：Light/Dark × 1160/560，
  单一下拉、更多子菜单、不同 Host 项目、项目开关不改变全局、技能保留电脑、文件安装菜单、
  离线禁写且可切电脑、旧 Host、无项目和读取失败。没有横向溢出、菜单裁剪或页面异常。
  证据目录 `/tmp/cindy-single-menu-evidence-G6JfBN`，结果见 `acceptance.json`，
  最终 SHA 与源码/图片哈希见 `manifest.json`。文件选择/传输/确认均为明确标注的测试替身。
- 本次仅调整 Renderer 布局与交互，未重跑无关全量测试；此前根 runner 的 4 项已复现
  环境失败仍未解决，完整门禁不标为通过。新版 Host 的真实双机写操作、OS 原生文件选择/
  权限确认、真实 OAuth 及安装/卸载仍未实机联调；Mobile 本轮未新增入口。

## 已确认 Demo 落地（2026-10-15）

### UI Implementation Contract

#### Objective
让单一下拉明确表达“电脑 → 该电脑的全局/项目范围”，并在已安装区解释操作影响范围。

#### Inputs
用户已确认基于原界面截图生成的 GPT Image 2 Demo（媒体指纹
`cf9ee38535932600d3a9e9d6bdbca7a9b7c8578e4ff6b8cb3a5d27b0aa651a29`）。
该图是设计输入，运行证据须另行从本轮生产组件采集。

#### Scope
Desktop 插件/技能共享电脑菜单、插件项目子菜单、本机项目和远端管理提示。复用现有
状态与动作；不改 Main、IPC/协议、安装器、配置桥、数据格式、依赖或 Mobile。

#### Current Implementation Map
`PluginDevicePicker` 已有单一电脑入口，`PluginProjectMenu` 已有 Host 联动子菜单；
本机 `GhostPluginPage` 和远端 `RemotePluginPage` 的范围提示表现尚不一致。

#### ASCII To Layout Contract
```text
页面标题                           [电脑 / 全局或项目 ▾]
                                    电脑
                                    当前电脑 ✓ / 其他电脑
                                    项目范围：当前值 → 该电脑上的项目
                                                       全局（默认）/ 项目
已安装 [数量]
[当前项目：名称；开关与整机操作范围说明              返回全局]
已安装卡片
推荐（来源筛选独立）
```
- 电脑菜单补分组名；“更多”改为“项目范围”，子菜单标题明确其所属电脑。
- 插件触发器全局态也显示“电脑 / 全局”；技能沿用共用电脑，不新增技能项目筛选。
- 项目 Banner 展示项目名、整机安装/更新/卸载/配置边界及返回全局动作。
  本机全局无需常驻提示；远端全局用中性提示明确目标电脑和保存位置。
- 远端离线、旧端、读取失败/重试、项目加载等替换同一提示区域，不堆叠多个范围 Banner。
  保留所选目标；恢复/重试仍沿现有回读，不重放写操作。
- 复用现有菜单、Button 与主题 token，容器 12px、触发器胶囊、菜单行 32px；
  Light/Dark 同时实现；窄窗口文本折行、动作可换行，菜单自动避让边缘。
- 切电脑重置项目、项目不影响推荐、离线禁写、文件安装归“添加插件”等既有行为保持。

#### Platform Mapping
| 合同项 | Desktop | Mobile |
| --- | --- | --- |
| 单一电脑菜单及 Host 项目子菜单 | adapt | defer |
| 范围与状态提示 | adapt，共用领域组件 | defer |
| Host 数据/动作与权限 | reuse | reuse，保持既有行为 |

#### File-Level Plan
调整 `PluginDevicePicker`、`PluginScopePicker`、`PluginManagementLayout`、
本机/远端插件页和远端技能页，更新五语种文案；按影响面复用回归和隔离 fixture。

#### Validation Matrix
定向 Desktop 交互/导航、Host/项目/异常回归与类型检查；ESLint、i18n、术语、文档检查；
headful Chrome 实拍 Light/Dark × 宽/窄，检查菜单层级、电脑/项目联动、返回全局、
页签保留目标、状态提示替换、离线/旧端、文件安装入口。仅在隔离 fixture 执行测试写操作。

#### Open Questions
无；本轮仅落实用户确认的截图方案。

#### Approval Gate
2026-10-15 用户明确“可以，用这个方案”，继续已授权本地实现、验证和 DCO 提交。
不推送、建 PR、发布或创建额外任务。

### 本轮验证与证据

- 在 `cindy/jolly-stallman` 从干净的 `ba9d94d20` 继续本地 UI 跟进；preflight 与
  branch alignment 通过。2026-10-15 核对 canonical `origin/main` 为 `d1fc07e23`；
  没有合入其他分支或复制其他 worktree 的修改。
- 5 个 Desktop 定向文件、58 项通过：`GhostPluginPage.navigation`（19）、
  `RemotePluginPage`（13）、`PluginManagementLayout`（16）、`RemoteSkillsPage`（8）、
  `useCatalogDevice`（2）。覆盖本机全局无提示、项目不影响推荐、返回全局不发写操作、
  Host 项目联动与单一状态区域，以及既有导航/动作回归。保留已有 React `act(...)` 警告。
- `pnpm --filter desktop run --if-present typecheck`、6 个修改的产品 UI 文件 ESLint、
  `pnpm check:i18n`、`pnpm check:i18n-glossary`、`pnpm check:dev-docs` 通过。
  五语种 12,101 个 key 一致；保留原有 1,300 处 i18n 警告与 18 处 proposed 术语告警。
- `pnpm check:design-colors --base-ref ba9d94d20 --worktree` 通过，新增硬编码颜色为 0。
  1 处圆角 report 经人工分类：`CatalogManagementNotice` 的可见外框承载说明与动作，
  属于 `DESIGN.md §5` Step 2 Container，使用既有 `rounded-xl`（12px）；图标无独立框，
  动作沿用标准 Button 的可见层与命中区，不新增形状或 token。
- 真实桌面 Chrome 对当前生产组件隔离 fixture 实拍 35 张，覆盖 Light/Dark × 1160/560、
  两级菜单、项目切换、项目开关不改变全局、返回全局、插件/技能共用电脑、文件安装入口、
  离线保留目标且禁写、旧 Host、空项目及项目读取失败。自动交互无页面异常、横向溢出或
  菜单裁剪；Light/Dark 的宽窗口工作电脑菜单/范围与窄窗口范围已人工目检。
  截图在菜单/页面过渡结束后采集。证据目录为
  `/var/folders/1p/p8l7r58s2hx3rrwmcyjrsml80000gn/T/cindy-confirmed-demo-evidence-ae9068nf`；
  `acceptance.json` 保存 35 张图片清单与断言结果，`manifest.json` 绑定最终本地提交、
  本轮源码及图片 SHA-256。设计生成图不作为运行证据。
- 本轮仅修改 Renderer、文案、定向回归与实施记录，未重跑无关全量测试；此前根 runner
  4 项已复现的环境失败仍未解决，完整门禁不标为通过。真实双机安装/更新/卸载、
  OS 原生文件选择/权限确认、真实 OAuth/API Key 配置仍未实机联调；本轮截图中的所有
  设备、插件及写操作均为明确标注的隔离数据，Mobile 本轮无新增入口。

## 真实隔离双端与白盒验收（2026-10-15）

本节更新前文当时尚未完成的沙盒验收，不抹去历史失败或将 fixture 截图改称真实双机证据。
仍在自有分支 `cindy/jolly-stallman`、worktree `jolly-stallman` 继续，代码起点为
`235b7660d8509f42fa178265977a0062ecb36859`。本轮不推送、不建 PR、不新增开发任务。

### 验收环境与证据归属

- 控制端 A 是本 worktree 启动的 Global 隔离 Desktop，目标端 B 是同一提交的临时源码
  archive 启动的另一独立 Desktop/profile；两端经真实企业登录成为同账号的不同设备。
  两个 Host 在同一台 macOS 电脑上，经真实 relay、preload、Main、filePeer 和原安装器通信。
  不把它等同于两台物理电脑，不拦截 RPC、不伪造批准，也未用假任务承载配置。
- B archive 不是另建的开发任务或 worktree。升级回归修复后，只同步本轮
  `remotePluginManagement.ts` 到该自有临时副本，并经安全包装命令重启 B；A Renderer
  由本 worktree 的 Vite 更新。运行时 A Renderer 与 B Main 的产品源码哈希、最终本地
  提交、QA 包和截图哈希记录在证据目录的 `manifest.json`；不声称 B checkout 本身是最终 SHA。
- 写操作仅使用两个自制、无外部请求的 QA 插件及虚构密钥/连接地址。两端原有的三项
  企业默认插件不配置、不卸载；全程用前后清单比较版本、namespace 与 enabled。
- 证据目录：`/tmp/cindy-remote-management-acceptance.ZVaG21`。可复现脚本、分层 JSON
  报告和原始检查输出留在该目录；真实任务列表所在的 `actual-initial.png` 不作为交付图。
  企业登录的浏览器环境阻塞已在用户授权关闭无窗口测试 Chrome 后恢复，不计为产品缺陷。

### 真实运行结果

| 路径 | 结果与可复核证据 |
| --- | --- |
| 电脑与项目层级 | A 的本机项目可选，项目不筛推荐；B 的项目为空，仅显示 B 的全局与空态，没有泄漏 A 的目录。见 `actual-readonly.json`、`dual-final-ui.json`。 |
| 插件/技能共用电脑 | 切至技能仍保留 B，技能没有新增项目菜单；切回本机不显示 B 的 QA，再切 B 可恢复。见 `dual-final-ui.json`。 |
| 原生文件选择、远程首装 | A 经真实系统文件选择框选包，filePeer 传至 B，在 A 确认 B 的实际权限；取消不安装，批准后只在 B 落位并启用。见 `dual-install-cancel.json`、`dual-install.json`。 |
| 全局启停 | A 操作，B 的真实清单回读 disabled → enabled，A 本机清单不变。见 `dual-enable.json`。 |
| 同权限升级 | 1.0.0 → 1.0.1 无额外确认，观察 UI 终态成功后再延迟 2.2 秒回读，版本稳定且配置保留。见 `dual-upgrade-1.0.1-confirm.json`。 |
| 扩权升级 | 1.0.1 → 1.1.0 显示实际新增权限；取消保留 1.0.1，确认后稳定为 1.1.0，配置仍就绪。见 `dual-upgrade-1.1.0-cancel.json`、`dual-upgrade-1.1.0-confirm.json`。 |
| API Key | A 输入虚构 key，经 v3 加密桥在 B 保存，B 重启后仍就绪；重新配置不回填已存 key，取消不破坏原配置。见 `dual-config.json`、`dual-after-restart.json`。 |
| Connection | A 输入虚构 HTTPS 地址和 token，仅 B 出现对应加密文件；再次填写后取消，B 密文文件哈希不变，未解密/读回凭证。见 `dual-connection.json`。 |
| 远控不可用与恢复 | 真实关闭 B 的 remoteControlEnabled，A 保留 B、禁用添加/安装/启停及已打开表单的保存；恢复后可继续读取/取消。此项是远控不可用测试，未模拟物理断网。见 `dual-disconnected-config.json`、`dual-final-ui.json`。 |
| 错误包与卸载 | 非法包经 A 文件选择后被目标拒绝，清单不变；卸载先取消一次验证保留，再确认移除两个 QA，B 的 QA 加密文件随原卸载流程清理，A 与 B 的三项默认插件均不变。见 `dual-uninstall.json`。 |
| 主题与页面异常 | 真实 Electron 的本机插件/技能、项目菜单及最终远端列表/配置/禁用表单均采集 Light/Dark，并目检；本轮页面交互无 Renderer exception。见 `actual-dark.json`、`dual-final-ui.json`。 |

### 端测发现的缺陷与最小修复

1. 文件升级提交阶段错误回滚：远程操作的 `assertCurrent` 会重读旧批准；原安装器已经换入
   新目录而尚未提交新 receipt 时，旧批准自然不再描述新包，导致自己的升级被拒绝。
   仅将传给原文件安装器的回调改为 owner/peer/cancellation 的 `assertScope`，原安装器
   锁内的物理实例、旧批准、包摘要和扩权确认复核保持。新增五项回归，修复前 1 失败/
   22 通过，修复后通过；真实升级另验证终态与稳定版本，避免把瞬时新版当成成功。
   `update-regression-before.log` 保留最初失败，旧误判升级报告保留为 `*.initial.json`，
   不纳入最终通过项。
2. 远控不可用时配置表单的 Save 仍可点：底层写入已有授权检查，但页面未禁用原生表单。
   用标准 disabled fieldset 随目标 online 状态禁用表单，保留内容与现有执行链；新增
   断线表单回归，修复前 1 失败/13 通过，修复后 14 项通过，并在真实 A/B 复验。
   `offline-form-before.log` 和 `dual-disconnected-config.initial.json` 保留失败证据。
   同一测试文件清理原先未使用的 push 回调变量，通过 ESLint；不改变产品行为。

### 最终白盒与提交前检查

- 50 个不同测试文件、1,048 项通过，失败与跳过均为 0：最终核心 31 文件/488 项，
  文件传输/provider/OAuth 扩展 12/169，市场原安装器 6/383，共享远程资源协议 1/8。
  覆盖同名不同 namespace、实例/批准变化、两控制端回执隔离、owner/撤权/取消、旧 Host、
  晚响应、项目 revision、配置桥加密/失败/取消以及本机列表不被覆盖。
  最终核心报告是 `whitebox-current.json`，其余三层沿用未改动代码的报告；汇总与唯一
  文件核对见 `whitebox-summary-final.json`。白盒模拟不冒充相应真实双机验收。
- Desktop 类型检查、四个修改代码/测试文件的 ESLint、文档合同、设计颜色与 diff
  空白检查通过。Device Link build 沿用本轮已通过结果，该 package 随后未修改。
  未新增依赖、存储 schema、协议字段或权限豁免。
- 前文根 runner 的四项基线环境失败和完整 Desktop integration 的外部运行条件失败仍
  保留。本轮不重复无关全量套件，不声称整仓全量、完整集成或远端 CI 通过。
- 结束时两个 QA 已通过远程 UI 卸载，B 远控恢复原 false，测试别名恢复原 null，A
  返回本机，主题恢复原设置，只最小化两个自有沙盒窗口。见 `dual-restored.json`。

### 剩余真实验收范围

两台物理电脑、Windows、Mobile 真机、真实第三方 OAuth、两控制端同时写入、物理断网
中途提交与恢复尚未实测。B 没有近期项目，未为测试创建假任务或修改数据库；远端项目
写入仅完成白盒与生产组件 fixture。技能本轮真实验收覆盖电脑联动和只读页面，技能安装/
卸载仍为白盒覆盖。市场下载写入与自定义来源/企业可见性以原服务的白盒结果为准，真实
远程安装/升级使用的是安全传输的 QA 文件包。该历史轮次尚未集成统计分支；2026-10-16
合并 main 后的当前统计边界见上方「范围」。

用户计划第 1 项的层级与列表、第 2 项的文件包安装/升级/卸载、第 3 项的 API Key 与
connection、第 4 项的隔离双 Host 与白盒已有上述证据；统计与真实外部/多平台场景保持
明确未验证边界。插件基座指定维护者的 Approve 仍是后续合并门，不阻止本地测试提交。

## Code review 与清理（2026-10-15）

本轮审查基于 `76bc4f502`，清理范围限于远程插件/技能管理改动：

- 删除未用的管理版本常量、旧 Host 视图 DTO 的启停/revision 字段、外部未用的 export、
  两条闲置翻译、冗余渲染条件和 fragment；去除图标键时不再引入无用解构变量。
- 远程协议版本与双端包大小上限复用已有协议常量；原生文件过滤器复用已有五语文件类型
  文案。固定的 action ID、格式版本、扩展名与校验预算保留为协议/实现约束。
  新增生产代码未发现写死的测试设备名、个人绝对路径、端点或测试凭证。
- 精简组件输入/输出叙述和否定式任务注释，纠正投影说明与错位的播种广播注释；保留安装锁、
  批准变化、owner/peer 及迟回校验的维护说明。技能导入仍消费标题栏 controls，未误删。
- 修复远程技能页误用“读取插件”的加载/失败提示，五语改为技能对应文案。新增读取失败后
  重试回归：修复前 8 通过/1 失败，修复后该文件 9 项通过。

最终定向测试 22 文件/357 项通过，失败与跳过均为 0；Desktop 类型检查、i18n 结构与
术语、文档合同、设计颜色和 diff 空白检查通过。ESLint 仍有 14 条既有问题：brain/index
13 条、device-link/ipc 1 条；与 `76bc4f502` 的规则、消息和源行逐项一致，其余改动代码无
lint 错误。不重复无关全量检查，不将历史失败或未运行的 CI 写为通过。

复用已有隔离 Electron 做只读复查并截取 Light 下两页与电脑菜单，技能加载提示已实际呈现；
结束回到插件页并重新最小化自有窗口。Dark 本轮未重新目检，无新增颜色或布局样式。未重做
双端写操作，其余真实验收边界沿用上一节。证据位于
`/tmp/cindy-remote-management-review.zu3IY8`，最终测试为 `tests-final.json`，lint 基线
对照为 `eslint-comparison.json`，页面证据为 `preview.json` 与 `review-*.png`。

## PR 准备与主干对齐（2026-10-15）

- 合并 canonical `main` 的 `a7aaaee10`，解决 `device-link/ipc.ts` 同位置冲突，保留主干代输入授权入口与本次插件文件传输、技能原生确认入口。未改写已有提交。
- 合并后定向 Desktop 57 个测试文件、1,243 项通过，失败与跳过均为 0；包含新增主干代输入提交与远程授权边界回归。Desktop 类型检查、Device Link build、i18n、术语、文档合同和设计颜色检查通过。
- brain/index 的 13 条、device-link/ipc 的 1 条 ESLint 问题与最新 canonical `main` 按规则、消息及源行逐项一致，没有新增。此前整仓与完整 integration 的失败记录仍保留，未重跑这些无关检查。
- 更新后的隔离 Desktop 经安全启动入口返回 `DESKTOP_DEV_VERDICT=ready`；实际复查两页、电脑菜单和插件专属项目入口，无 Renderer exception。仅查看页面，未重复配置或安装操作，结束时回到本机插件页并最小化自有窗口。
- [公开页面证据](assets/remote-plugin-management/README.md) 区分本次 Light 页面与 `76bc4f502` 的真实双 Host Light/Dark 列表。未将历史 Dark 截图或双 Host 写入记录标为本次合并后的重新验收。
- 当前未找到对应的管理需求 Issue；不把插件面板远程交互的 #4274 当作本需求，也未擅自创建 Issue。先交付 Draft PR，保留正式送审所需的需求关联、当前 head CI/review 及插件基座 Approve。
- PR #6102 首轮 CI 的设计台账自检失败：新增管理组件未完整登记，生成区块也未更新。补齐插件/技能 surface 的远程页面、电脑入口和操作菜单，沿原生成器同步台账，人工决策区未变；连续两次生成字节一致，`check:design-inventory` 和该脚本完整测试文件 52 项通过。修复只涉及台账及记录，产品源码与本节截图、57 文件 / 1,243 项验证保持一致，完整 CI 等待新 head。

## 旧 Host 插件列表与详情修复（2026-10-15）

用户实测指出旧 Host 的升级提示难以理解，列表和详情没有正常插件信息。根因是管理能力
缺失时，Renderer 只消费 list 的名称/描述和 get 的 fallback 文本，丢弃旧资源已经返回的
图标、状态及结构化详情。真实只读核对用户所选电脑，确有 16 个已装插件；其 Baguette
详情返回版本、图标、16 个工具、5 项权限及 7 组信息，无新增管理 capability。

- 旧 Host 使用正常已装卡片和共享详情标题、工具、权限对话框、信息网格，显示真实启停
  状态；保留 namespace 物理实例键。未知版本或状态不造值，不显示“最新”或本机操作。
- 提示明确当前电脑名称、可查看的内容和更新该电脑后才可使用的管理操作。读取错误优先
  于能力提示；列表和详情分别重读原目标资源。切电脑、返回列表、切号和离线的迟回结果
  不覆盖当前页面，恢复连接重新读取，目标补齐 capability 后可刷新回完整管理页面。
- 本机与新版远端保留原安装、配置和权限边界；共享展示组件继续使用 Light/Dark 语义
  token，不新增协议、依赖、存储或权限豁免。缺字段只展示已知信息并说明缺失。

### 本轮验证与证据

- Desktop 定向 8 文件 / 145 项通过，覆盖旧端解析、详情、错误恢复、owner/电脑迟回、
  离线重连、目标能力升级及本机卡片、详情、导航和共同电脑选择。
- Desktop 类型检查、五语种 key/术语、文档合同、当前工作树设计颜色及设计台账检查通过；
  台账完整脚本 52 项通过，连续生成字节一致。i18n 保留 1,300 条既有警告，术语保留
  18 条 proposed 警告。ESLint 有两条测试文件的既有 explicit-any，按规则、消息和
  源行与原 HEAD 核对一致；其余八个修改源码/测试文件没有 lint 错误。
- headful Chrome 的生产组件 fixture：19 张截图，覆盖 Light/Dark、1160/560 宽的
  列表/详情/离线、权限与工具交互、另一电脑的不同版本、空态、缺字段和两类失败重试；
  无页面异常及横向溢出。公开示例见 [截图说明](assets/remote-plugin-management/README.md)。
- 复用自有隔离 Electron，经真实 relay 只读复查目标列表/详情 Light/Dark，并复查
  本机列表/详情 Dark；保留本机插件状态，结束恢复原主题、选回本机并最小化自有窗口。
  目标真实截图仅保留本地，公开截图全部使用明确标注的隔离数据。
- 本轮未重复双 Host 安装、配置和卸载；先前双 Host 写入结果及两物理电脑、Windows、
  Mobile、第三方 OAuth 等未验证边界保留，不把只读截图当作写入验收。
- 本地全量门禁本轮未执行，等待 PR 新 head CI；前文已记录的历史检查失败继续保留。

本轮本地证据位于 PR evidence 目录的 `legacy-host/`；`fixture-preview.json`、
`actual-target-readonly.json` 和 `actual-final.json` 区分模拟数据和真实读取。

## 沙盒与正式实例的真实验收准备（2026-10-15）

用户要求改为沙盒 A 与真机 B 登录同账号，实际执行 A 管理 B，不能仅验 UI。
本轮 A 已通过安全包装重启，`desktop:whoami` 确认为 `5bc671080`、隔离模式且 ready。
经真实 relay 连接同账号正式 B：`0.1.109`，构建提交为 `b10c64291`。
B 的实际清单有 16 项，列表及完整详情已回读；A 原有 3 项插件未变。
B 尚未声明 `management:snapshot`，因此未对其执行安装、启停、配置、升级或卸载。
当前两实例仍在同一台物理 Mac 上，不计作两台物理电脑验收。

已构建当前 PR 的中国大陆版 Apple Silicon 本地测试包（版本无关、ad-hoc 签名、未发布），
构建元数据为 `5bc671080b53362f2c4c83d8e591caa9125f60f9`；packaged smoke 与
`codesign --verify --deep --strict` 通过。Node 26 的首次构建在 packaging 提前结束，
无完整产物；改用本机已有 Node 24.18.0 后统一打包入口成功，不改构建源码。
测试包 SHA-256 为 `f647984439d054f5930e15c70c039256954d839b536e56ac2e28dac978e26ab9`，
bundle id 为 `com.xd.cindycn`，与当前正式 App 一致。初次成功的 Global 包已弃用；
启动入口校验时曾误发一次该包启动请求，该进程退出后真实 B 仍在线，16 项插件投影与
基线一致。入口改用实际 `ps` 命令行检查，实测正式实例运行时阻止启动，并校验区域与提交。
对比正式安装包与当前 checkout 的 174 份 SQL、companion 和 journal 资源，全部一致；
此项仅为发布资源核对，没有直接打开或改写用户数据库。

用户已选择「当前电脑，复用现有数据」，授权 B 临时运行测试版。正式 B 承载当前任务，
切换需退出正式 App，再从独立产物启动并回到原任务续测；未覆盖 `/Applications/Cindy.app`。
已准备只在正式 App 退出后启动的单次入口及续测记录，并关闭本任务上轮额外目标沙盒、
保留其数据。测试包、启动入口和分层结果记录在本地 `cindy-real-device-acceptance.swcCY8`
目录；真实目标写操作仍待切换后执行，不标为通过。

### 项目菜单空分组修复（2026-10-15）

用户截图中的双分隔线来自本机没有最近项目时，仍渲染空项目分组及其上下分隔线。
`PluginScopePicker.tsx` 仅在有项目时渲染项目列表，空本机菜单保留一条分隔线；
远程电脑的项目空态和禁止本机目录选择保持原有行为。

新增 4 项回归覆盖空本机、最近项目、远程空态及远程项目 ID 选择。与导航、远程插件页
合计 45 项测试及 Desktop 类型检查通过。当前 worktree 沙盒在真实 Light / Dark 页面
均回读到 2 个选项、1 条分隔线，未替换数据或使用 mock；截图为
`project-menu-empty-light.png` / `project-menu-empty-dark.png`。
此前 head `5bc671080` 的 Windows CI 在 Python 协议探针启动子进程时出现
`spawnSync python ETIMEDOUT`；scheduler-host 代码未在本 PR 变化，本机及新 head 的
结果分别记录，不把上轮 CI 标为通过。
本机单独复跑该 Python 协议测试 4 项通过；本次 2 个源码/测试文件的 ESLint 通过。

### 同机双沙盒验收与停用配置入口（2026-10-15）

用户确认使用同一台 Mac 上两个独立沙盒验收：A 为本 worktree 控制端，B 为
`e29a1c97b` 的运行副本；本轮只改 Renderer，两端 Host 与 preload 源码一致。各自使用
独立 profile、设备身份和同一个 XD 企业账号，经真实 device-link 通信。
本节替代上文等待退出正式 App 切换真实 B 的安排；两台物理电脑的差异仍未验证。

用户在 B 的 XD Feishu 停用时点击 Configure，真实回执为 `GHOST_ASLEEP`。远程页面未
对齐本机设置页的启用条件：现按全局启用态禁用配置按钮、提示先打开上方开关，停用时
不提供自定义设置入口。目标在点击前被其它控制端停用时，按原回执回读状态，不重复写入。
Host 的配置校验、凭证桥和本机配置行为保持原有边界。

验证：新增 2 项回归先失败后通过；相关 5 文件 / 106 项测试、Desktop 类型检查、ESLint、
Prettier、i18n 结构与术语检查通过。真实 A→B 操作覆盖停用提示、远程启用、打开飞书
授权卡、取消及恢复原停用态；A 清单不变，未发起第三方 OAuth 或提交凭证。停用态
Light/Dark 均实拍并目检；停用态截图已在下节更新为精简布局，历史配置卡保留为
`config-enabled-form-light.png`，当轮结果见 `config-disabled-runtime.json`。本轮未执行本地
全量门禁，等待新 head 的 PR CI；Windows 与第三方 OAuth 完整授权未验证。
CI 术语回归将英文提示中的动词短语误计为模型轮次；已改用等义表述并重拍停用态截图，
本地复现的同一检查由 70/71 恢复为 71/71，通过后仍等待新 head 完整 CI。

### 授权结果回读与停用态精简（2026-10-15）

用户要求停用态只显示先启用的原提示；现省略这一块的配置标题、保存位置说明与配置
按钮。本机配置页面保持原行为。启用态复用同一详情区块标题与语义 token。

用户已在 B 完成飞书授权。A 原先只展示配置入口，完成回执触发刷新后瞬时提示又被清除，
没有呈现 Host 已提供的配置摘要。现通过既有 `maker:remote-resources:get` 读取
`plugin-capabilities.usage.configuration`，显示状态与已授权账号数。实际 B 返回
`setup.state=ready`、OAuth `configured`、`count=1`，A 已显示相同结果，重新进入详情仍可见。
没有更改 Main、preload、wire 契约或凭证桥，也不读取账号标识、令牌或已有密钥。

读取与当前 owner、电脑、已装实例和快照绑定；切目标或换实例后的迟回不显示到另一页。
配置卡仅显示在所属物理实例详情，避免同名 public/org 插件串卡。失败时“刷新状态”
只重读配置，不重发授权；旧 Host 未提供摘要时不虚构未授权或数量 0。

验证：相关 7 文件 / 132 项通过（新增状态回读、重开、失败重读、目标切换、同名实例隔离
与精简区块回归）；Desktop 类型检查、ESLint、修改文件格式、i18n 结构与术语、术语规则
71 项、文档和设计台账检查通过。真实 A→B 验证已有授权状态的读取、重开详情与停用提示，
Light/Dark 均实拍并目检，见[页面证据](assets/remote-plugin-management/README.md)。
临时停用后恢复 B 当前的启用态，前后 A/B 插件清单、版本、启停状态一致，Renderer
exception 为 0，A 主题恢复。本轮没有重新授权、撤权或修改已存凭证。

本地全量门禁未执行，等待 PR CI；两台物理电脑、Windows/Mobile 和再次完成整段 OAuth
流程未验证。此前的测试与 CI 结果按各自提交记录，不与本轮数字累加。


## 原设置页通用代理修正（2026-10-15）

用户裁决为 A 展示 B 的原设置页，Host 执行读写和授权，结果回到原页，凭证只保存在 B。
本轮删除按 OAuth / Key / connection 生成的配置摘要与逐项 Configure，不按插件 ID 改布局。
旧章节中的配置摘要截图和远程桌面替代方式均为历史方案，不代表当前实现。

- 目标 Host 按已安装实例和批准版本创建 Desktop settings lease，供给原 HTML/JS/CSS；
  无需插件重新声明 mobile、重新安装、重新确认权限或重配凭证。
- A Main 使用临时非持久分区，复用原 webview 的主题和高度；原页面的 KV、secret、OAuth、
  connection 端点经签名、加密 v3 通道交 B 原执行器，读取只返回原端点允许的脱敏状态。
- 原 BroadcastChannel 保留插件的交互协议和 B 的逻辑沙箱；原目录选择交给可信 A 宿主，
  仅浏览和选择 B 的目录，由 B 校验并签发既有授权回执。作者页面不能回答 Host 目录请求。
- 原生确认框归属 A 当前窗口。关闭页面、切电脑、切号、撤权和实例代次变化作废旧响应；
  写入超时只回读，不重放。API Key 不进入应用 Renderer store、普通远控 invoke 或日志。
- 同步 canonical main 的单一模型设置：复用当前 PluginTaskPrefs，模型列表、辅助模型标签、
  权限和保存都归目标 Host；不恢复主干已移除的分能力模型偏好。没有自定义设置页的插件
  只展示其实际声明的 Host 控件。
- 短时操作结果改用既有悬浮 Toast；离线及设备范围提示保留，Toast 不占文档流。

### 本轮白盒与静态检查

- 合并 canonical main 后 Desktop 定向 37 文件 / 564 项通过，覆盖原端点、密封通道、
  页面租约、目录交接、原页组件和当前单一模型偏好；早先 546 项属于上一代码状态，不累加。
- Device Link 全包 45 文件 / 893 项通过，Device Link build 与 Desktop 类型检查通过。
- 全 PR 77 个 Desktop TS/TSX 文件 lint 对照 canonical main：37 条既有问题原样复现，
  无新增 lint 错误；不把该结果表述为整包 lint 全绿。
- 五语种 12,500 key 一致，术语检查、设计台账与开发文档合同通过；保留 1,300 条既有
  i18n 警告与 18 条待裁决术语警告。
- 本地全量门禁曾运行但未通过：根 runner 582 项中 4 项 restart/isolation 环境用例失败，
  已在原基线 archive 复现。未修改测试基础设施，也未删除或放宽测试；完整门禁由新 head CI 复核。

### 运行验收与边界

最终源码已在同一 Mac、同账号、两个独立 profile 中复验，走真实
preload/Main/device-link/v3 加密链路。目标 source 副本的 Git HEAD 不是运行代码 SHA，
已按同步清单逐文件核对源码 hash；这是两个独立 Host，不是两台物理电脑。

- A 展示 B 的 Web Search 原设置页，在原开关修改偏好后，B 本机 `/kv` 独立回读变化，
  A 重开页面后仍回显；结束后恢复原值。
- 在原输入框保存虚构测试 Key，B `/secrets` 回读已保存，A 原页及重开后回显；测试 Key
  已通过原清除按钮移除。未读取、覆盖或复制用户既有凭证明文。
- A 的飞书原账号行显示 B 已有的 1 个账号和默认标记；TapTap 原页与 B 本机页面均显示
  已连接，验证原 BroadcastChannel 链路。本轮未重新授权、断开或撤销这两个已有授权。
- Light、Dark 和 780×800 窄布局均加载实际 Electron 原设置页，无 Host 或 guest 横向溢出；
  三张原页截图均已目检，见[页面证据](assets/remote-plugin-management/README.md)。
- 页面已滚动至 `scrollTop=160` 后，Toast 出现前、出现中和消失后的设置区
  `top=242.96875`、`left=347.5`、`height=322`、`scrollTop=160` 完全一致。
- Art 1.14.0 未声明 `settingsHtml`，不创建原页 webview 或已移除的分能力模型控件。
  验收前后 A/B 的插件清单、版本和启停状态一致。

原生整窗截图受到本机 ScreenCaptureKit 采集失败限制；本次提供实际 Electron guest
截图及 Host 布局测量，不用拼接图冒充整窗截图。TapTap 的目录同步按钮因当前没有可同步
项目而禁用，原页目录选择的成功与取消交互本轮未实测；固定目标、一次提交、取消、过期、
关闭租约与外来回答拒绝已由白盒回归覆盖。

两台物理电脑、Windows、Mobile、完整的新第三方 OAuth、两控制端并发及物理断网中途
提交仍未验证。B 已有授权的回显通过不代表重新完成一次 OAuth。

## 技能页按原 Skill Hub 交互接入远程执行（2026-10-16）

用户明确要求：管理电脑切换只改变数据与操作目标，保留完整技能首页、公开／组织目录、分类、搜索、分页、详情和安装位置弹窗。先前独立的远程简化列表不符合这个要求；修复 `user` 范围解析只解决了已装数据丢失，没有完成市场管理。

本轮实现合同：

- 本机与远程复用同一首页、市场列表、市场详情、本地详情和装卸控件；不再维护简化远程市场布局。
- 市场分类、卡片完整元数据、分页、详情及已发布文件通过目标 Host 的原 Skill Hub 服务读取；已装状态只由该 Host 的扫描与安装记录派生；保留自发布条目的来源和发布者身份，继续使用原有作者匹配规则，不把公开目录副本误标为未安装。
- 原安装位置弹窗展示目标电脑的全局位置和已有项目。项目使用 Host 签发的 ID／代次，Host 在确认前与执行时重新校验，不接受控制电脑提交的文件路径。
- 安装、更新、启停与卸载均在目标 Host 执行，沿用已有安装锁、原生确认、回执查询与回收站；断线只查询已有操作，不重放写入。
- 本地目录导入、编辑、发布及分析任务保持既有本机范围；旧 Host 缺完整目录能力时明确提示升级，不把本机数据混入目标页。
- Light／Dark 均复用原组件的语义 token。当前轮次的测试与实机证据在完成后单独记录，不沿用旧截图宣称已验收。

### 本轮验证结果

- 恢复主干原有的「公开／组织／本地技能」切换，不再把全部已装列表置于市场之前；本机与远程共同复用首页、市场列表、详情和安装位置弹窗。与这次需求相反的旧首页测试同步恢复为原交互断言。
- Desktop 定向 14 文件 / 243 项通过，包含完整市场分页、分类、搜索、组织目录、已装状态、目标项目安装、启停和卸载，以及旧 Host `user` 范围、离线禁写和迟回隔离。清单见 [技能测试文件](assets/remote-plugin-management/skills-full-desktop-test-files.json)。Desktop 类型检查、改动文件 ESLint、开发文档、术语及设计台账检查通过；台账由原生成器更新，人工区未改。
- 同一 Mac 的独立沙盒 A/B 经真实 device-link：A 的公开目录与 B 本机原 `listMarket` 返回逐项一致；公开首屏 24 项，原「加载更多」增加到 48 项；组织首屏 24 项、分类 13 项、本地已装 58 项。页面未替换 IPC、注入目录 fixture 或混入 A 的扫描结果。
- 从 A 的原市场详情和安装位置弹窗，把 `systematic-debugging@1.0.1` 安装到 B 的临时项目。B 的扫描与安装记录可回读该项目副本，A 的全局安装记录仍为 0；随后从远程本地详情经真实 OS 确认框卸载，B 回到未安装，A 仍为 0。只操作本轮测试项目，不改用户全局 Skill 文件。
- [市场 Light](assets/remote-plugin-management/skills-target-market-light.png)、[市场 Dark](assets/remote-plugin-management/skills-target-market-dark.png) 与 [B 已装列表](assets/remote-plugin-management/skills-target-installed-dark.png) 来自本轮最终产品源码的实际 Electron 页面，已目检；采集后恢复原 Dark 主题。源码摘要见 [SHA-256 清单](assets/remote-plugin-management/skills-full-source-sha256.json)。
- 两台物理电脑、Windows/Mobile、远程「其他目录」选择、本地目录导入、编辑/发布/统计不属于本轮实际验收。历史全量环境失败保留；不借用旧 head CI 通过或旧截图作为本轮证据，PR 保持 Draft。

### 同步主干后的复验

- 合并 canonical main `ae54765a3`。唯一冲突是 `device-link/ipc.ts` 的导入：保留本分支的原生确认框导入，同时保留主干 MCP Apps 常量及普通桥拒绝 App RPC 的边界；未改变任一执行路径。
- 主干新增依赖按其原锁文件安装，不把 staged 上游依赖当作本 PR 新增依赖。设计台账原生成器复核通过，人工区与自动合并结果一致；23 个 Skill 源码 SHA-256 均未改变。
- 合并后 [19 文件 / 274 项](assets/remote-plugin-management/skills-merged-desktop-test-files.json)通过（原技能 14 文件及远程资源、原生确认、IPC 诊断、MCP Apps IPC），Desktop 类型检查、冲突文件 ESLint、设计台账与文档检查通过。
- A 从合并后的 worktree 重新启动，`DESKTOP_DEV_VERDICT=ready`；B 保持本轮技能修复 Host。实际 A→B 复验公开 24→48、组织首屏 24、已装 58，重新拍摄并目检市场 Light/Dark 与 B 已装列表，恢复原 Dark。仅继续只读复验，不重复下载或改用户全局技能。

### 技能页常驻目标提示（2026-10-16 补充）

- 正常读取后保留目标电脑及保存位置说明，与插件页共用原提示组件、语义 token 和多语言文案；公开、组织、本地技能三项切换均保留提示。加载、离线、读取失败及旧 Host 的说明保持可见，正常状态不出现重试按钮。
- 修正 `marketRoutes.test.ts` 对旧布局 `controls` 的遗留断言，恢复对原 `headerActions` 的检查，保留电脑控件和原市场布局检查；这是 `6405c83e6` Linux/Windows 同源 CI 失败的原因。
- `RemoteSkillsPage.test.tsx`、`SkillhubHomeNavigation.test.tsx`、`marketRoutes.test.ts` 共 3 文件 / 55 项通过；Desktop 类型检查、改动文件 ESLint 通过。与历史 274 项不相加，新 head CI 不借用旧结果。
- 实际 A→B 页面已通过热更新复验，公开、组织、本地技能均有目标提示，本地仍为 58 项；重拍并目检原三张 Light/Dark 截图，恢复原 Dark。本轮未重复安装/卸载或修改目标技能；见[页面证据](assets/remote-plugin-management/README.md)。

### Project Scope 保留主干能力（2026-10-16 补充）

- 对照 `main@6e2ba9286` 的原选择器，保留本机当前目录／最近项目／原生目录选择；远程菜单恢复目标完整路径、全部最近目录与「选择其他文件夹」，复用已有固定目标的远程目录选择器。旧版「远程禁止浏览」仅为历史限制，本轮已按能力位恢复。
- Host 校验选中目录并签发临时项目 ID；不创建任务或写最近项目，读取／启停使用 ID 与 revision。换电脑、账号或连接代次不沿用旧选择；旧 Host 缺少浏览能力时仍可管理其已有项目。
- 相关 12 文件／157 项、Desktop 类型检查、其余修改文件 ESLint、设计台账和开发文档检查通过；`index.ts` 的 13 个文件级 lint 错误与修改前一致，未改无关代码。首轮新增测试的模拟环境／类型声明错误已修正后通过。
- 同 Mac 独立 A/B 沙盒、真实 device-link：A 最近项目 0 项，B 最近项目 1 项；浏览成功／取消不改两端最近列表，同名项目显示完整路径；A 停用／启用 B 浏览目录中的 Art，B 本机回读生效并恢复，全局、另一项目与 A 同路径偏好未改变。Light/Dark 已目检；截图及源码摘要见[页面证据](assets/remote-plugin-management/README.md)。跨物理电脑、Windows 与 Mobile 未实测。

### 项目菜单与技能筛选区收紧（2026-10-16 补充）

- 保留上述功能，项目子菜单改为 320px 宽并受视口约束；名称与路径单行省略，完整路径仍在悬停提示中可读，不改变目标项目 ID 或浏览行为。
- 技能页电脑选择独立放在标题右侧，来源与分类筛选集中在其下；目标提示保持常驻，正常状态改为轻量单行，离线／失败仍保留警示与重试。移除正常提示的大块背景和重复留白。
- 实际 A→B、1440px Light/Dark 与 640px Dark 目检通过，正常目标提示高 20px、项目菜单宽 320px，无页面横向溢出；公开／组织／本地切换、分类和搜索清除已操作。6 文件／80 项、Desktop 类型检查、4 个修改文件 ESLint 通过。源码摘要与本轮截图见[页面证据](assets/remote-plugin-management/README.md#项目菜单与技能筛选区收紧2026-10-16)。本轮未重复装卸、授权或修改目标配置，跨物理电脑与 Windows/Mobile 未实测。

## 提交前代码审查与主干冲突解决（2026-10-16）

基于 `d5c63e822` 审查本 PR 的设备隔离、异步回执、原设置页、项目范围与完整 Skill Hub 链路，
并合并 canonical main `febe2e511`。本轮是 owner 自查；指定 Sonnet 5.5 的独立审查任务因
当前宿主模型不可用而未创建，不将自查写成外部 review 或当前 head 5/5。

- 解决 9 个文件的冲突，保留 main 新增的插件作者、共享统计及本机个人调用卡。远程卡片／
  详情绑定目标市场元数据，远程详情不读取控制端同名插件的个人记录。个人统计与清除尚未
  接入远程接口，不能据此声称完整远程统计已实现。
- 删除被原 settingsHtml 替代、已无界面调用的远程 Setup 配置卡路径，包括 Host configure
  分支、setup 回执 DTO／解析和 pageSource 适配；原任务授权与加密设置页路径保留。恢复
  main 的任务型 Setup 参数，清除无用 export、mock、旧展示参数及历史过程性注释。
- 复现原生 Skill 确认请求失败后，重连仍被 confirming 标记拦住的问题。回归测试修复前
  失败（预期确认 2 次，实际 1 次），修复后通过；重连继续确认同一个 operationId，begin
  仍只有 1 次，不重复安装。
- Desktop 去重覆盖 89 文件／1,712 项通过；最后 3 文件／80 项复验为其中子集，不重复
  相加。Device Link 全包 46 文件／930 项及其类型检查通过，Desktop 类型检查通过。
  文件清单见[审查验证清单](assets/remote-plugin-management/review-desktop-test-files.json)。
- 89 个受影响 Desktop 源码／测试文件执行 ESLint：85 个无错误，其余 4 文件共 33 个
  错误，与 `main@febe2e511` 原文经相同配置检查的 rule/message 多重集完全一致；保留
  既有错误并披露，没有修改无关模块或降低规则。五语种 key／术语、文档合同、设计台账、
  设计颜色硬门与 diff 空白检查通过；i18n／术语／设计报告中的非阻断警告保留。
- 重启本任务 A 沙盒，ready 后经真实 device-link 读取既有 B Host。Light/Dark 的
  Web Search 原设置页与作者信息正常，远程个人调用卡未挂载；Art／XD 业务数据助手
  实际 manifest 未声明 settingsHtml，不生成空页面。Skill 三来源、分类、搜索清除、
  320px 项目菜单与 640px 窄布局已复验，证据见[本轮页面记录](assets/remote-plugin-management/README.md#提交前审查复验2026-10-16)。

本轮为同一 Mac 的两个独立沙盒，不是两台物理电脑；B 保持其前轮兼容实现，未覆盖其
已有检出。未重新装卸、保存凭证或发起第三方 OAuth，也未进行实机断网故障注入；确认
重连修复以回归测试验证。历史全量失败保留，不重跑无关全量，也不沿用旧 head CI／评分。
PR 继续保持 Draft，指定维护者 Approve、当前 head CI 与明确 5/5 仍待后续完成。
