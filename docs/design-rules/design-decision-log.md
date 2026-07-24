# Cindy 设计决策史(design-decision-log)

> `DESIGN.md` 只保留「现行有效」的规范;历史决策、被推翻的方案、勘误过程按日期
> 归档在本文件(中文)。每条记录:日期 / 决策 / 背景与被取代方案 / 现行落点
> (DESIGN.md 章节 + token / 冻结测试)。
> 本文件是只增不改的台账,不承载任何现行规范——**与 `DESIGN.md` 冲突时以
> `DESIGN.md` 为准**。
>
> 范围现状(2026-07-24 建档):首批归档为原 `DESIGN.md §13` 的 G1–G4 勘误全文与
> 旁注 backlog。`§15` CINDY 皮肤族的决策史(红色体系重构、caret 改稿、vibrancy
> 定稿等)仍留存于 `DESIGN.md §15` 各小节内,待 §15 重构(梳理 C5)时迁入本文件。

## 2026-07

- **07-24** 设计文档整体梳理启动:DESIGN.md 去除 Ollama 官网叙事(标题改
  `Cindy Design System`,§4/§5/§8/§9 官网内容删除或重写为 Cindy 自述);
  §12 结构化组件规格试点采纳并入 §4(§12 编号保留占位);§13 G1–G4 归档至本文件;
  focus ring 文档追平代码(`#3b82f6` → `#417CDD`,代码 2026-07-17 已定稿,文档滞后);
  §2/§9 二级三级文字与 chip 双 slot 表述修正(以 `colors.ts` 为准);
  §10 写死 token 计数移除(以 `colors.ts` 为准)。

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
- R2 §4.3 Project_List 五点差异(2026-07-17 lead 裁决本轮不做):Project_List 三态拆分、项目 header/list card 选中中性底、去选中组 focus-ring 蓝 ring、小箭头 #A61629 强调等。详见 DESIGN.md §15.10 backlog 段(§15 重构时迁入本文件)。
