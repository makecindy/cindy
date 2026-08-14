# Cindy 设计决策史(design-decision-log)

> `DESIGN.md` 只保留「现行有效」的规范;历史决策、被推翻的方案、勘误过程按日期
> 归档在本文件(中文)。每条记录:日期 / 决策 / 背景与被取代方案 / 现行落点
> (DESIGN.md 章节 + token / 冻结测试)。
> 本文件是只增不改的台账,不承载任何现行规范——**与 `DESIGN.md` 冲突时以
> `DESIGN.md` 为准**。
>
> 范围现状:2026-07-24 建档,首批归档原 `DESIGN.md §13` 的 G1–G4 勘误全文;
> 2026-07-25 起 `§15` CINDY 皮肤族的决策史(红色体系重构、caret 改稿、vibrancy
> 定稿等)已随 §15 保号重构迁入本文件,`DESIGN.md §15` 只保留现行规范。

## 2026-08

- **08-03** **排版立法:字重梯改四档、桌面字号白名单建档(拍板人 = 用户,issue #1505)**——
  本条**推翻**原 `DESIGN.md §3` 的「字重只允许 400/500、never bold」表述(§3 Principles /
  §7 Don'ts / §9 Iteration Guide 三处同步改写)。背景:2026-08-03 全仓走查发现桌面端在无守卫
  状态下已实际漂移——`font-semibold`(600)生产代码 ×72(含测试 ×74)、`font-bold`(700)×11、
  `font-extrabold`(800)×1,任意值字号 `text-[Npx]` 生产代码约 549 处(含 21 处小数、
  7 处 <10px:6×9px + 1×8.4px;计数口径 = 生产代码 occurrence,测试与注释另计);
  而手机端 2026-07 已收敛到
  400/500/600/700 四档 token 并有 `typographyTokenDiscipline.test.ts` 守卫。三项决策:
  (1) **字重四档收编**:400/500/600/700,与手机端 `fontWeight` token 对齐,两端一张梯子;
  600 收编存量 72 处 semibold(合法化、不改代码),700 只许经豁免登记表(markdown `<strong>` /
  hljs 主题移植 / 登录品牌画布),800 清零。工程理由:桌面未设 `font-synthesis: none`,
  PingFang 公开档位到 600,UI 用 700 会触发中文伪粗体——中文层级不得依赖 600 vs 700。
  (2) **字号「只归写法、不动数值」**:本轮不做档位迁移,白名单 = UI 段 {10–16} + 标题段
  {18, 20, 24, 28};只做小数吸附、<10px 升下限、任意值归 `text-<n>` token；语义别名只收编
  `xs/sm/base/lg`，源码侧禁止 `xl` 及以上（由守卫拦截）。`theme.extend.fontSize` 中的
  `xl..5xl` 遗留项不在配置侧删除范围，避免删除后静默回退到 Tailwind 内置固定值、失去用户字号缩放；
  配置遗留项的清理另行处理。
  任意值归 token 的附带修复:
  doc 紧凑模式(`.chat-rail-compact`)按类名枚举缩字号,任意值不在枚举内会静默漏缩。
  (3) **`LegacyMigrationDialog` 裁决**:其 23/19/17 字号是登录画布 680→490(×0.72)的缩放
  产物而非手滑,但仍吸附回白名单(24/18/16,±1px);字重 700 归登录品牌域豁免。
  line-height 混轨、语义类 `text-xs/sm` 机械统一等登记为 non-goals。
  (→ `DESIGN.md §3`「字重阶梯 / 桌面 UI 字号白名单 / 排版豁免登记表 / 排版 non-goals」
  四个新小节;施工与守卫拆四个 PR,台账 = issue #1505)

## 2026-07

- **07-29** **「跳过登录」恢复过协议门 + 协议行整行热区 + 未登录态命名(拍板人 = 用户)**——
  本条**推翻** 07-27 记录里的「跳过登录免协议门」(桌面侧;那条其余内容——入口形态换文字按钮、
  面板 440→500、圆钮行删游客——继续有效)。三项决策:
  (1) **跳过登录过协议门**:不登录账号也是在使用 Cindy 客户端,面板内「跳过登录」文字按钮与
  桌面 `error` 步 footer 逃生口都改回经 `requireConsent`——未勾选先弹服务条款 / 隐私协议弹窗,
  同意后才进未登录状态,并写入统计采集同意。是否真的上报仍由 main 侧闸决定
  (`analyticsSettingsService` 对本地会话一律 `!isLocalMode()` 不放行,该逻辑不动)。
  ⚠️ 合规实现约束(#907 review 引出,勿改顺序):这条链路的同意记录必须落在
  `auth:enter-local` **之后**——`acceptPrivacyConsent` 会同步广播 `allowed`,提前落时
  `isLocalMode()` 还是 false,`allowed:true` 会让 TapDB 当场 init 并发 `device_login`,
  把「未登录态不上报」破一个窗口。落码 = `deferConsentPersist` 选项 + `openLocalMode`
  自己落同意,顺序由 consent 测试的 `invocationCallOrder` 断言锁住。同批还要求切换窗口内
  不接任何新动作(`requireConsent` 顶部 `localModePendingRef` guard;企业 SSO 入口与
  `error` 步 `reset` 因绕过 requireConsent 另行自挡),否则窗口里点邮箱 / 社交会走
  「放行即落同意」分支再次广播 `allowed:true`。取舍:用行为层 guard 而非给全部控件加
  disabled(窗口只有几十毫秒,全量 disabled 会换来可见闪变)。
  (2) **协议同意行整行可点**:热区由 radio 的 24px 圈体扩到整行 680×40(原来要瞄准一个小圆点);
  两个内联链接与 radio 自身 `stopPropagation`(前者只开链接,后者防冒泡二次 toggle),
  行容器不加 role / tabIndex(radio 仍是唯一无障碍交互点),整行 `select-none`。
  (3) **未登录态改名**:应用内不再出现「本地模式」这个说法——账号状态名统一为「未登录」
  (侧边栏账号胶囊、设置页资料卡、语音服务提示四语同步),动作名沿用「跳过登录」;
  未登录态头像不再取状态文案首字(会渲染成「未」/「N」)或写死「L」,改中性人形图标。
  代码内部标识(`AuthState mode='local'`、`authEnterLocal` IPC、data owner)不受影响,仍用 local。
  术语已登记 `not-signed-in` / `skip-sign-in` 两条 proposed(`i18n/glossary.json`)。
  (→ `DESIGN.md §16` 协议门表 + 协议行整行热区条 / `LoginPage.consent.test.tsx`
  与 `LoginPage.region.harness.test.tsx` 的过门断言 / `userInfoSectionHover.test.ts` 头像契约)
- **07-29** **手机端功能区落位改回新稿标注值(拍板人 = 用户,依据 = 实机比例对照图)**——
  本条**修正**下方 07-28 记录里「功能区落位保持 main 原值不动」那一句(该句作废,原记录
  保留在册)。**背景**:07-28 剥离手机端跳过登录时,把功能区落位一并退回 main
  (`loginY` 694 / 933、锚常量 `dh-640`),但**品牌簇已整档换成新稿基准**——两半来自不同
  构图,拼接后「字标底↔面板顶」间距变成 **短屏 92 / 长屏 131.65** 设计px,而 main 是
  18.98 / 22、新稿是 20 / 25.65,**该值在任何一份稿里都不存在**;实机折算短屏多空 ≈38pt、
  长屏 ≈57pt(约半个输入框高),肉眼可见。当时的不变式只断言「字标底 < 面板顶」(不重叠),
  对「空太多」无感,故静默通过。
  **决策(方案 B)**:`loginY` 取新稿标注值 **622 / 827**(figma `705:915` / `705:799` 的
  Log_in 组 @(35,622) / @(35,827))。间距回到稿内 20 / 25.65。dh<1334 段改为
  `min(622, max(0, dh-640))`——保留紧凑底距 18 再钳到短屏档落位;**曾试过把锚常量直接
  改成 `dh-712`,被 review 实算否掉**:那会让 dh∈[712,1222) 全段字标被不透明面板盖住
  (dh=1000 压 40 设计px),因为短屏档那 90 的底距只属于 dh≥1334,窄屏空间不足时不该保留。
  **已知偏离**:新稿手机帧面板为 500 高(含「跳过登录」栏),手机端已剥离该入口、面板回 440、
  组回 560,少掉的 60 **全部落到底部留白**(90 / 175,稿内为 30 / 115)。
  **被否方案 A**:品牌簇整体下移 60(`loginY` 682 / 887),可让间距与底距双双回稿值,
  代价是品牌簇整体比稿位低 60(叠加避脸上移后立绘顶 120 / 166);审图后不采纳——优先
  保真品牌簇的稿内顶部构图。
  **pad 竖屏不受影响**:无 figma 新稿帧、品牌簇未换基准,内部自洽,保持 621 / 158。
  **防回归**:`loginSkinLayout.test.ts` 新增三条不变式——「间距上界不变式」(= 稿值,取代
  原先只判不重叠的下界)、「锚常量连续性不变式」(dh=1334 上下不跳变)、「间距不变式
  (短屏以下分支)」(dh∈[850,1334) 采样点面板顶不得压到字标底);任一侧单独改动、或窄屏
  分支被改出压盖,都先在此红(已用注入 `dh-712` 实测:2 条转红)。
  (→ `DESIGN.md §16.2` 几何表 + 「面板 500→440 少掉的 60 去向」条 + §16 末尾勘误块 (6);
  `cindy-design-system.md` 版本记录 2026-07-29 行)
- **07-28** **手机端「跳过登录」与无账号通路整体剥离(拍板人 = 用户)**——本条**修正**下方
  两条 07-27 记录(「手机端新增跳过登录入口与无账号通路」及其连带的移动端键盘锚 / 配置错误屏
  逃生口 / 移动命中区 50),07-27 那两条**作废但保留在册**(决策轨迹不删)。背景:本轮 PR 的
  任务边界是「登录页只改 UI」;独立核实确认 (a) 手机端在 main 基线(`55e3eac2b`)**从无**
  游客 / 无账号功能,(b) 2026-07-24 产品拍板「手机 / pad 为远程连接客户端、必须有账号、
  不加游客登录」**仍然有效**——07-27 的「推翻」缺产品侧确认,且 `loginConsent.test.ts` 里
  锁死该拍板的反向断言当时被改写掉了。故手机端跳过登录属越界新增功能,整体剥离。
  **剥离范围**:删 `localModeStore` / `skipLoginGate` / `homeRemoteSyncGate` /
  `authGeneration` 及其测试;`AuthContext` 回 main 等价(无 `isLocalMode` / `enterLocalMode` /
  冷启动恢复 / 账号优先清标记,`clearLocalSession` 回裸 generation bump,
  `acceptOutcome` / `completeOAuthCallback` 的 `expectedGeneration` 一并回退——它是跳过登录
  review 引出的改动,越界不留);登录页删入口挂载与协议门豁免、路由门回 `isAuthenticated`、
  首页回 main 行为、删 `LoginSkipLoginLink` 组件与 `skipLogin` 四语 key;几何回 main
  (面板 440、组 560、圆钮行 480、协议行 582、error 槽 680×60 @380、删 `LOGIN_SKIP_LOGIN` 与
  键盘停靠锚常量、pad 竖屏推导值回原值);`loginConsent.test.ts` 恢复 2026-07-24 三条反向断言。
  **保留的手机端视觉改版**(与跳过登录无关,本轮唯一保留项):短屏 / 长屏品牌簇换新稿
  `705:915` / `705:799` 逐字段基准(cindy / slogan / word),含 07-27 拍板的避脸落值
  (长屏 slogan 下移 31.32 距字标 24px、短屏立绘上移至 y=60);功能区落位 `loginY`
  (694 / 933 / `dh-640`)与面板几何同源,**保持 main 原值不动**。
  **桌面端不动**:桌面本来就有 local-mode 能力,UI 换成「跳过登录」文字按钮合法,
  07-27 的桌面侧决策继续有效。手机端保持无游客 / 无账号行为不变。
  (→ `DESIGN.md §16` 末尾勘误块 / `cindy-design-system.md` 变更史 2026-07-28 行)
- **07-27** 登录页改版:**「跳过登录」取代游客圆钮入口,且免协议门**(拍板人 = 用户;
  依据 = figma 新稿 `705:915` / `705:799` / `700:783` + 本轮任务指令)。第三方圆钮行
  删除游客人形圆钮(guest 图标资产一并删除,`count` 按 provider 动态:CN = Apple+SSO
  2 颗 / Global = Apple+Google+SSO 3 颗),入口改为**面板内「跳过登录」文字按钮**
  (新稿容器 `705:1068` / `700:910` 680×60 @面板内 y430)。同时**推翻 2026-07-24
  「个人登录一律先同意协议再发起(含游客)」**:跳过登录 / 本地模式(含桌面 `error`
  步 footer 逃生口)不过 `requireConsent`、radio 未勾选也直接进主界面,**且不写入统计
  采集同意**(不创建账号、不上报数据,没有明示同意就保持采集闸关闭);其余个人链路协议门
  与企业 SSO 豁免均不变。(→ §16.2 几何表 / §16.3 组件表 / §16.4 协议门过门点与豁免 /
  §16.5 决策记录;`figma-component-spec §12.1`)
- **07-27** **手机端新增「跳过登录」入口与无账号通路**(拍板人 = 用户;依据同上,新稿
  手机帧已画出该入口)——**推翻 2026-07-24「手机 / pad 为远程连接客户端、必须有账号、
  不加游客登录」**。落点:`AuthContext.isLocalMode` 与登录态**正交**(本态下无 token /
  user,业务请求仍 UNAUTHENTICATED,只有路由门「有账号 ∨ 已跳过」并列放行),标记跨重启
  保留(AsyncStorage `cindy.mobile.auth.localMode`,非凭证不占安全存储);账号优先——
  真正登录成功即清标记,登出 / 会话终止一并清除回登录页。原锁死该拍板的测试断言
  (mobile 登录源码不得出现 localMode 入口)随之改写。(→ §16.3 组件表 / §16.4 逐屏表)
- **07-27** **面板 440→500、登录组 560→620**(拍板人 = 用户;依据 = 新稿三端一致
  680×500,`700:791` / `705:886` / `705:1062`,同文件旧稿对照 440)。增的 60 全部给面板内
  新增的「跳过登录」槽(430..490,槽底距面板底 10),**面板内其余元素 y 坐标一律不动**
  (标题 31 / 副标题 75 / 输入框 158 / 主按钮 300 / error 380);error 槽由 h60 回到
  **680×50 @380**(2026-07-24 的「占满到面板底 h60」是面板 440 时代的等价写法),与跳过槽
  首尾相接、同时可见不重叠;圆钮行 480→**540**、协议行 582→**642** 随组顺移(圆钮行距
  面板底恒 40、协议行距组底恒 22 均不变)。**Splash 借用登录面板时不跟随 500,保持 440**
  (拆出 `SPLASH_PANEL.height`:Splash 五帧无该入口、设计稿未改版,跟随会在启动态凭空多
  50 CSS px 空白;同批把 Splash 的 `no-drag` 盒高度从登录组高 620 收到面板高 440——盒语义
  是「只有面板内容不参与窗口拖拽」,跟着组高会把面板下方空白也划成不可拖拽区)。
  (→ §16.2 / §16.3 `LoginPanel`;`token-decision-table §4`)
- **07-27** **「登录文字按钮」定性为新组件类别,与「文字链接」分家**(拍板人 = 用户)。
  `LoginSkipEntry`(桌)/ `LoginSkipLoginLink`(手)**不是** `LoginTextLink`:色走
  `--login-secondary-text`(`#6F6F6F`,light / dark 同值,**零新增 token**、不走
  `--login-link-*` 族),**hover / pressed 不变色**(只靠常显下划线 + 指针形状反馈),
  字号取稿值 24(≠ Text_link 的 20);**热区 = 当前语言实际文字渲染宽度 + 左右各扩
  (桌面 30 / 移动 50 设计px)、高度占满 60 槽**,680×60 仅布局容器且自身不可点
  (桌面 `pointer-events:none` + 内层 button;移动 `box-none` + 内层 `Pressable`
  放大 bounds——不用 `hitSlop`,它不越父 View 边界、Android 界外触摸不派发);超长译文靠
  `maxWidth 680` + 单行 + ellipsis 防御兜底,**可见截断 = 文案 bug**(改文案不改布局)。
  文案复用既有 `login.localModeEntry`(四语齐全,mobile 影子 catalog 新增同译法
  `skipLogin` key;孤儿 key `login.returnToLocalMode` 四语删除)。
  (→ §16.3「登录文字按钮」/ §16.2 长度预算表;`figma-component-spec §12.1`)
- **07-27** **移动端键盘停靠锚由「面板底」改为「error 槽底」(面板坐标 y=430)**
  (拍板人 = 用户)。背景:面板 440→500 后若继续拿面板底当停靠锚,每次停靠会比改版前多顶
  60 设计px,短屏更容易触发 clamped-fallback 把品牌层 / 标题挤掉。**取舍**:键盘弹起时
  「跳过登录」槽(430..490)允许被遮挡——它不是输入链路必需元素,收起键盘即可见;停靠引擎
  (10px 贴附 + safe-top 上限 + clamped-fallback)与悬浮相交判定锚(输入框 ∪ 主按钮)不变。
  (→ §16.2「键盘停靠锚」)
- **07-27** **SLOGAN 避脸:长屏 slogan 下移 31.32(距字标留 24px)+ 短屏立绘上移 27**
  (拍板人 = 用户,审 demo 两次拍板:先「slogan 下移不挡脸也不压字标」,再「短屏走方案 B
  立绘上移」)。判据是**像素级实测**而非目测:立绘脸部 skin 连通域 x402..552 / y315..475、
  slogan 资产 ink 5244px,双方按各自 `contain` 折算到 stage 求交——长屏原值 `y=536.68`
  时 ink ∩ 脸 = 290px、短屏 = 91px、中段 dh≈1400 最高 113px。落值:长屏 slogan inner
  `y` 536.68→**568**(容器 514→545.32,x / 宽高不动),底 645.29 距字标顶 669.17 = **23.88**
  (该档硬上限,再下移撞字标);短屏无下移余量(底距字标顶仅 5.83),改为立绘 `y` 87→**60**,
  改后 dh ≤1450 全段 ink ∩ 脸 = **0**,dh 1500..1624 残留 3..9px(仅下巴尖,受长屏 24px
  上限约束)。边界:可见发顶 = 60 + 86×0.79823 = 128.65,仍在 Status Bar 下沿 115.67 之下
  12.98(资产 y<86 是透明留白),**不侵入状态栏、无顶部裁切**;底部淡出渐隐,上移后尾部由
  「藏在面板下 20.6」变成「露出面板上 6.4」(长屏本来就露 25,同款观感)。
  (→ §16.2「移动端 stage 几何」/「SLOGAN 避脸」)
- **07-27** 手机 stage 几何**整档换新稿基准**(依据 = 新稿 `705:915` / `705:799` 逐字段
  实测;其中立绘 / slogan 的 y 随同日「避脸」拍板再修正,见上一条):短屏 dh=1334
  (立绘 599×720@(75,60)、slogan 254.01×72.8@(462.55,408.37)、
  字标 335×115@(208,487)、loginY 622)、长屏 dh=1624(立绘 750×902@(0,106)、
  slogan 269.66×77.29@(444.9,568)、字标 387×132.18@(182,669.17)、loginY 827);
  短屏以下锚常量 `dh-640`→**`dh-712`**(= 组底 682 + 新稿底距 30,在 dh=1334 处与
  loginY=622 连续)。**2026-07-24「视觉+功能区整体上移 40 设计px」拍板由本次新稿取代**
  (那条是为修旧稿协议行溢出,新稿自带 30 底距,不再叠加)。**pad 竖屏无 figma 新稿**:
  按「组底仍落 1114.94 / 字标框底↔面板顶仍 14.84 / splash 期簇位不变」三条不变量,把品牌簇
  与登录组一起上移 `60 × 0.794117 = 47.647` 设计px(`loginY` 621→573.353,`splashOffset`
  158→206)——**该值为推导、非设计源,用户 2026-07-27 接受推导,竖屏几何待设计侧回看确认**;
  pad 横屏组底 774.95 仍在 stage 820 内,几何原值不动。(→ §16.2「移动端 stage 几何」;
  `figma-component-spec §5.4`)
- **07-26** 外部主题导入(VSCode / Obsidian)落地,同批引入 Markdown 文字色 token。
  两条关键决策:
  ① **转换模板不新设计,取自已有的人工移植成果**。
  `apps/desktop/src/renderer/themes/builtin/` 下 7 个从
  VSCode 移植的社区主题,`colors` 的 key 集合逐字相同(91 个 token = 35 个 Tier1
  slot + 56 个 alias/singleton),值全部由同一组 13 个色板角色派生;
  `apps/desktop/src/shared/theme-import/palette.ts` 就是那套派生规则的代码化,并以这些主题自身做
  golden 对照(喂入其手写色板常量应重现其 colors)。选 allow-list(只产出这 91 个
  key)而非"先大量产出再过滤",因为这 7 个主题本来就没碰豁免族,照抄 key 列表即
  自动守住 §10/§16 边界。
  ② **`--md-h1-fg`…`--md-h6-fg` / `--md-strong-fg` 默认值定为 `inherit`,不是
  `var(--text-primary)`**。这些元素在引入 token 前的颜色就是继承来的
  (`baseComponents` 只给字号字重);若默认接主文字槽,blockquote / tool card /
  secondary 文字区里的标题与加粗会由弱化色变回主色 —— 那是实打实的观感回退。
  `inherit` 让全部内置主题渲染结果不变,同时给导入主题(Obsidian `--hN-color` /
  VSCode `markup.heading`)留出可覆盖槽位。守卫见
  `themes/__tests__/markdownColorTokens.test.ts`。
  连带扩展:本地主题 JSON 新增可选 `family` 字段,让 Obsidian 双态 CSS 的两个产物
  合成一个可跟随 Light/Dark 的家族;无该字段的老主题家族 id 与行为逐字不变。
  已知取舍:Obsidian 侧是**调色板导入**(只取 CSS 变量,布局/圆角/字体一律丢弃,
  `color-mix()` 等动态值跳过并计入报告),还原度低于 VSCode 侧,UI 文案如实说明。
- **07-26** §10「双模式交付门槛」放宽为「实现硬性 / 目检尽力」:**实现**两模式(走语义
  token、禁单模式硬编码、覆盖本次改动涉及的状态)仍是硬性要求;**两模式实机目检**从
  硬门槛降为尽力项——做不到不阻塞交付,但必须在 commit / PR 验证说明里写明哪种模式
  未验证,且不得把「复用既有 themed 样式、无新增裸色值」当作「双模式已验证」;一旦目检
  发现某模式不可读 / 无区分 / 缺态 / 明显回退,仍按真实缺陷处理必须修。背景:原门槛
  要求每次 UI 改动都实机跑两遍,纯复用 themed 样式的小改动也被卡在「未完成」上,与
  Agent 日常交付节奏不匹配(用户拍板)。同步改 `AGENTS.md` 规则索引对应条目。
- **07-25(梳理批次 2)** `DESIGN.md §15` 保号重构:小节编号冻结为稳定标识
  (15.9 从未分配;15.13 物理位置移回 15.12 与 15.14 之间),各小节只留现行规范,
  决策史迁入本文件;§10/§11/§14/§15 及 §2/§4/§5 残留中文段英文化(§16 冻结暂缓,
  外部引用的关键标题保留中文括注);§16 两处「§2 双模式交付门槛」误指修正为 §10
  (门槛正文在 §10,冻结例外,一行级)。
- **07-24(梳理批次 1)** 设计文档整体梳理启动:DESIGN.md 去除 Ollama 官网叙事(标题改
  `Cindy Design System`,§4/§5/§8/§9 官网内容删除或重写为 Cindy 自述);
  §12 结构化组件规格试点采纳并入 §4(§12 编号保留占位);§13 G1–G4 归档至本文件;
  focus ring 文档追平代码(`#3b82f6` → `#417CDD`,代码 2026-07-17 已定稿,文档滞后);
  §2/§9 二级三级文字与 chip 双 slot 表述修正(以 `colors.ts` 为准);
  §10 写死 token 计数移除(以 `colors.ts` 为准);§10 Tier-1 表删除幽灵行
  `--accent-fg-on-pure`(colors.ts 无注册,值与 `--surface-on-card` 重复)。
- **07-22** splash 字标资产统一:白字(DARK 用)/深字(LIGHT 用)两版统一为
  459×156(@2x),渲染框 229.5×78 恰为 2x 满框——此前白字版 486×184 塞同框被
  object-contain 缩小 ~10%,DARK 字标偏小(用户实机发现,换图修复);同日拍板
  splash 字标双模式**均不带投影**(原 drop-shadow 移除),`SplashScreen.test.tsx`
  反向断言。(→ §15.7)
- **07-20** U2 二级信息色 light 两轮调参定稿:`#9A9DA3`(Figma 原值)→ `#919399`
  → `#8C8E94`,桌面 cindy-light 与移动 tokens.ts 同步;dark `#6F6F6F` 不变;
  `text-secondary-cross` light 未随调仍 `#9A9DA3`。`cindyThemes.test.ts` ⑦ 锁值。(→ §15.5)
- **07-20** `sidebar-item-active` 撤红改反相胶囊(light 深底 `#3C3F43`+浅字
  `#FCFCFC` / dark 浅底 `#EEEEEE`+深字 `#252222`,描边 transparent;用户三轮改稿
  定稿,PR #174/#190 落地),同时退出红例外 map。(→ §15.10)
- **07-19** `drop-overlay-bg` 红 10% 撤红回中性灰遮罩(用户实机否决:整窗红罩语义
  似警报);`migration-bar-fill` 随主干迁移条退役(token 已删,非撤红);splash 根
  容器由半透改**不透明 `--surface`**(加载完成前必须完全遮盖已挂载主界面);vibrancy
  材质缺省定稿 `hud`(sidebar 实测回写)。(→ §15.10/§15.12)
- **07-18** caret 光标:日间定品牌红 `#DF0C27`、当晚被用户覆盖定稿为蓝 `#417CDD`
  (与 focus ring 同值,双端一致);历史文档中「caret 品牌红」表述一律作废。(→ §15.11)
- **07-18** vibrancy 体系定稿:透壁纸三重管线经实机 A/B 实证(窗口创建期设透明底
  + 根容器让路 + 禁 CSS backdrop-filter);唯一半透面 token
  `surface-translucent-sidebar`;浅色红渐变层经用户确认设计稿无此元素整层砍除,
  splash 渐变辉光层未实现入 backlog。同日发布双端换肤定稿规则(§15.13)。(→ §15.12/§15.13)
- **07-17** E1D 红色体系重构(用户批准):常规主操作弃品牌红改反相中性四态
  (light `#3C3F43`/`#FCFCFC`,hover `#2E3237`,pressed `#25282C`;dark `#EEEEEE`/
  `#252222`,hover `#E2E2E2`,pressed `#D4D4D4`)。B 类改中性 11 项:
  `accent-cta-bg`/`-pure`/`-emphasis`/`-soft`/`-hover`、`update-btn-border`/`-text`、
  `confirm-btn-primary`、`perm-allow-btn`、`primary`、`settings-btn-primary`(alias)、
  `accent-pure-cta-fg`/`settings-btn-primary-text`(中性字)。C 类逐项裁决:confirm
  普通中性(danger 另设)/ perm-allow 中性+警示橙 chip / primary 中性 /
  sidebar-item-active 当时 light 红胶囊、dark 深红(07-20 撤红,见上)/
  migration-bar-fill 保留红(07-19 退役)/ drop-overlay 保留红 10%(07-19 撤红)/
  brand-login-cta 不动。send-btn 族六 token 纳入 CINDY override 值表 + disabled 灰
  `#444242`/`#585555`;侧栏颜色层级整改(正文/二级暗灰/选中胶囊/running 橙,
  详见 §15.10 现行文)。三份新 map(`NEUTRAL_PRIMARY_EXPECTED_BY_ID`/
  `NEUTRAL_PRIMARY_FOREGROUND_BY_ID` + `RED_EXCEPTION_ALLOWED_IDS`)取代旧
  `BRAND_RED_*`;D2T ⑤/⑦/⑧ 迁移。(→ §15.2/§15.10)
- **07-17** 〔归档〕E1D 前的旧 `BRAND_RED_*` 三份名单原文(cindyDecisionData.ts 中
  保留供 D2T 迁移、迁完删):
  - `BRAND_RED_EXPECTED_BY_ID`(必须等于品牌红/深红):`accent-cta-bg`/
    `accent-cta-bg-pure`/`accent-emphasis`/`confirm-btn-primary-bg`/
    `perm-allow-btn-bg`/`update-btn-border`/`update-btn-text`(均 `#DF0C27`);
    `primary`(HSL,RGB 归一等价品牌红)。
  - `BRAND_RED_ALLOWED_IDS`(允许含红全集 = EXPECTED ∪ 派生):上述 +
    `accent-soft`/`accent-hover`/`confirm-btn-primary-hover`/
    `settings-btn-primary-bg`/`-border`/`-hover-bg`。
  - `CTA_FOREGROUND_WHITE_IDS`(红底白前景):`accent-pure-cta-fg`/
    `confirm-btn-primary-text`/`perm-allow-btn-text`/`primary-foreground`/
    `settings-btn-primary-text`。
- **07-17** `status-badge-fg` 拆分推导:橙徽章此前借用 `accent-pure-cta-fg` 白字,
  `#FFFFFF`×旧橙 `#FF6600`=2.94:1 不达标 → 拆独立 token,default 镜像
  `accent-pure-cta-fg`(9 主题零变化),CINDY 两模式 override `#1F1F1F`
  (×新橙 `#EA6B17`=5.19:1 ≥4.5,用户亲批;不达 4.5 则加深 `#000000`);覆盖数组
  115→116;消费点迁移见 §15.8 现行文。(→ §15.8)
- **07-17** hljs 语法高亮双门槛 D 裁决全推导:hljs 属辅助性视觉编码,对齐
  selection/边界 3:1 口径(语法色 ≥3:1、正文 ≥4.5:1)。light 三项 <4.5 但 ≥3
  (keyword 4.31 / built_in 3.29 / name 4.36)判 default 同源折损不整改,逐项落
  豁免档;dark `.hljs-section` `#1f6feb`×`#312F2F`=2.87 <3 补
  `[data-theme="cindy-dark"]` 提亮 `#2573ec`(H212 S84% L52→53.5%,=3.00);
  `.hljs-punctuation`/`.hljs-tag` github-dark 无显式色,继承 text `#c9d1d9`
  (8.62 达标),防御性补显式覆盖。落档 `cindyCodeBlockContrast.test.ts`。(→ §15.4)
- **07-16** U2 裁决:二级信息色 (b) 忠于 Figma 原值,接受可读性折损(实测
  × surface 2.32/2.92:1 等,均低于 AA 4.5:1),作为记录在案的显式偏离;
  `#686B72` 加深方案证伪仅存档。(→ §15.5)
- **〔勘误注记〕`brand-login-*` 已退役**:`brand-login-bg`/`brand-login-error-border`/
  `brand-login-error-text`(E1D A 类「保留红」)已随 wave4 登录白底改版退役——
  `colors.ts` 无注册,仅存于 `cindyDecisionData.ts` 红例外白名单字符串(白名单语义
  是"允许存在",token 不存在时无害);现行品牌红唯一出口为 `--login-brand-accent`
  (§16.1)。

## 2026-06 · Spec / Token Gaps 勘误(原 DESIGN.md §13 全文归档)

> §12 结构化重写过程中暴露的设计系统欠债。下列"现状"均已 grep 源码核实(以源码
> 为准),非臆测。四条均已解决,结论已并入 §2 / §4 / §5 / §10。

- [x] **G1 — 白底次按钮文字 `#404040`「Button Text Dark」是文档漂移,非真 token**(已解决 2026-06)
  现状:§2 / §4 称其"专用于白底按钮文字",但全仓库只有 `features/maker-experimental/MakerExperimentalView.tsx`(实验视图,裸 hardcode)出现 #404040,**无任何真实次按钮**用它做文字色;§10 也无对应 token。
  处理:§2 标废弃、§4 White Pill 文字改引 `--text-primary`(#262626)。未动 token,纯文档。

- [x] **G2 — 次按钮边框 `#d4d4d4`「Border Light」同为漂移**(已解决 2026-06)
  现状:§4 称白底按钮边框 `1px solid #d4d4d4`,但无真实组件这么用;#d4d4d4 的线上出现要么在实验视图(裸 hardcode),要么是**暗色主文字**(`--text-primary` dark = #d4d4d4,如 SchedulerPage CTA 注释),与"边框"无关。真边框 token 是 `--border-default`(#d7d7d4)。
  处理:§2 标废弃、§4 White Pill 边框改引 `--border-default`(#d7d7d4)。纯文档。

- [x] **G3 — placeholder token 碎片化 + 取值自相矛盾(真欠债)**(已解决 2026-06)
  现状:4 个 per-surface alias 无统一 slot,且取值打架——`--settings-input-placeholder` = #c4c4c4(§4 认证的"淡到读着像空"),但 `--chat-input-placeholder` = `var(--text-tertiary)` = **#a3a3a3(Silver)**,而 §4 白纸黑字说 Silver **太显眼、读着像已填、不可做 placeholder**。即聊天输入框 placeholder 实际违反了我们自己的 §4 规范。
  处理:`colors.ts` 新增语义 slot `--text-placeholder`(#c4c4c4 / #525252),4 个 alias(chat/ask/settings/plan-action-fb)default 收口为 `var(--text-placeholder)`;7 套非默认主题原 `settings-input-placeholder` override 就地改名为 `text-placeholder`(沿用原常量,避免回退,符合第 10 节对每套主题的 override 评估)。默认主题下 chat placeholder 由 #a3a3a3 修正为 #c4c4c4。2 套亮色主题(atom-one-light / solarized-light)的 `text-placeholder` 进一步从 tertiary 改用各自 **disabled 档**(更淡)——亮色背景下 tertiary≈2.6:1 命中 §4 禁用 Silver 的对比度,placeholder 须更淡才读着像空(2026-06 review 反馈)。**本地/复制主题兼容**:slot 引入前创建的本地主题快照只冻结了旧 per-surface placeholder key、无 `text-placeholder`,加载期 `mapWireTheme` 经 `local-themes-normalize.ts` 归一化——缺 `text-placeholder` 时从旧 `settings-input-placeholder`(或任一 per-surface 值)播种并丢弃 4 个旧 per-surface override,使四个输入面统一走新 slot(不改写盘上 JSON、幂等;2026-06 review 反馈)。

- [x] **G4 — `--radius`(8px)与容器圆角同名不同义(已解决 2026-06)**
  现状:`--radius` 实为 `0.5rem`(8px,shadcn 原语用);容器 12px 圆角实际靠 Tailwind `rounded-xl` 直接量实现。
  处理:**圆角体系正式从"二元"改为"三档"**(8px 内层控件 / 12px 容器 / 9999px pill,见 §5 + §7 + §1)。8px 这一档窄范围限定多行输入框、下拉 / 菜单选中行、段内小单元,实现为 `rounded-lg`;shadcn `--radius`(8px)与这个内层档数值相同但语义独立(原语专用),容器仍走 `rounded-xl`(12px)。**本次纯文档,未动 token**。是否进一步 token 化为 `--radius-inner`(8px)/ `--radius-container`(12px)/ `--radius-pill`(9999px),收益偏低、**暂缓**,要做走第 10 节的新增 token 流程。

## Backlog(已知、刻意搁置)

- `MakerExperimentalView.tsx` 通篇裸 hardcode hex(#404040 / #d4d4d4 / #262626 / #333),违反 DESIGN.md 第 10 节 token 规则。因是 experimental 视图,暂不清理,仅备忘(原 §13 旁注,2026-06)。
- R2 §4.3 Project_List 五点差异(2026-07-17 lead 裁决本轮不做,出处为设计阶段工作文件 `2026-07-17-r2-ui-specs.md` §4.3,不入仓库):① Project_List 三态拆分(active-task-pill / project-card / flat-list-row 不共用 `sidebar-item-active`);② 项目 header / list card 选中应中性底(`#312F2F`/`#F6F6F6`,非 `#DF0C27` 大红);③ 去 Project_List 选中组 `focus-ring-soft` 蓝 ring,改 card stroke `#DCDFE3`/`#434343`;④ 小箭头 `#A61629` 强调(非整行红底);⑤ 本轮收敛不扩战线,后续另开。
- splash 渐变辉光层未实现(2026-07-18 backlog,待用户表态)。
