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

## 2026-07

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
