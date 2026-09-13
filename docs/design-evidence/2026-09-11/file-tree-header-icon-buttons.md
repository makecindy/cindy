# 文件树标题行图标钮圆角统一（#4301）

日期：2026-09-11。平台：Desktop / Windows（用户本机 dev 实例，`DESKTOP_DEV_VERDICT=ready`）。
基点：`64520dd75`（本批本地未提交改动）。采集时 head 与仓库工作区一致。

设计依据：`DESIGN.md §5 Border Radius Scale` Step 2 —— 控件框（含 transient
hover / pressed 表面）登记在 pill 档，`No 3px / 6px / 10px`；`§14.6` 图标钮的
`aria-label` + tooltip 交付合同。治理依据：`design-governance.md §13.3`（圆角分类
审查边界：须指出登记项与作用层，不得用建议改形状代替分类裁决）。

## 本次改了什么

文件树标题行原先只有新增的「显示被忽略的目录」开关走 pill，同排三个存量图标钮
（搜索 / 收起 / 刷新）各自写 `rounded-md`(6px)，同一行出现两种圆角。改为四个按钮
（含搜索态的 X）共用 `FILE_TREE_HEADER_ICON_BUTTON_CLASS`，统一 pill；doc 模式宿主
的标题触发器（项目名下拉）同排，同步收为 pill。两个宿主的图标钮类名不再各自复制。

## 有意差异登记

| 表面 | 改前 | 改后 | 依据 |
| --- | --- | --- | --- |
| RSB 文件浏览器标题行：搜索 / 显示被忽略的目录 / 收起 / 刷新（+ 搜索态 X） | 6px（新开关已是 pill） | 9999px | §5 Step 2 控件框 = pill |
| doc 模式侧栏标题行：同上四个按钮 | 6px | 9999px | 同上 |
| doc 模式侧栏标题触发器（项目名 + ChevronDown） | 6px | 9999px | 同一行的控件框、同样带 hover 表面 |

未改：该行之外的同文件控件（错误态「重试」文字按钮、切换项目下拉项）不属本行，
按存量随各自表面迁移处理，未借本次改动一并迁移。

## 自动检查

```
pnpm --filter desktop run typecheck                    通过
vitest FileTreeIgnoredDirsToggle.test.tsx              12 passed
  （含几何守卫与 aria-label 守卫：两个宿主的标题行图标钮必须走共享常量、必须带可访问名）
vitest typographyDiscipline                            5 passed
vitest useFileTree / useFileBrowserPreference          12 passed
vitest expandedStore                                   3 passed（新增：展开态按 showIgnoredDirs 分片）
node scripts/design-inventory.mjs                      已重新生成（49 surfaces）
node scripts/hardcoded-color-audit.mjs                 新增硬编码颜色 0
pnpm test:unit:related                                 通过（desktop 全量 + file-browser-core / remote-file-service）
```

## 真实 Desktop 构建内的实测值

dev 实例（本 checkout，独立命名沙箱 `dev`）经 CDP `Runtime.evaluate` +
`getComputedStyle` 取实测值；截图由 `Page.captureScreenshot` 采集。

| 主题（`data-theme`） | 未按下：图标色 / 圆角 / 尺寸 | 按下：底色 / 图标色 | `--sidebar-item-active` |
| --- | --- | --- | --- |
| `cindy-light` | `rgb(136,136,131)` / 9999px / 20×20 | `rgb(60,63,67)` / `rgb(252,252,252)` | `214.3 5.5% 24.9%` |
| `cindy-dark` | `rgb(111,111,111)` / 9999px / 20×20 | `rgb(238,238,238)` / `rgb(21,21,21)` | `0.0 0.0% 93.3%` |

- 两个宿主各四个按钮实测圆角全部 `9999px`（改前三个为 6px）；按钮 20×20、图标 14。
- 按下态在两种主题下都有持久底色（非仅 hover 可见），与 token 值一致。
- 四个按钮的图标色在 idle 态一致（来自 `--sidebar-action-icon`）。

## 目检

RSB 文件浏览器（会话视图右栏）与 doc 模式侧栏（`#/cc-agent/files/<sessionId>`）
两种布局 × Light / Dark 共 4 张截图已由作者目检：入口位置（眼睛按钮在搜索右侧）、
按下态反馈、图标变化（EyeOff ↔ Eye）与 tooltip 文案均符合预期；开关打开后
`node_modules` / `logs` 等目录出现在树里（即本次改动要修的场景）。

## 缺口登记

- **unsupported 禁用态未实机目检**（评审修复轮新增）：该状态只在 device-link 连到不支持
  `showIgnoredDirs` 的老 Desktop 时出现，本机无该环境。可见面为 `aria-disabled` +
  `opacity-45` + `cursor-not-allowed`（与仓库内 `PermissionSelector` 禁用项同款），
  行为（点击不改偏好、树按隐藏态建立）由单测锁定。
- 远端 SSH 会话未实机验证（无可用远端环境）：远端 `listDir` 的开关透传与
  daemon 事件过滤只在单测层面覆盖，见 PR「未执行的验证」。
- 截图未上传 PR：GitHub 图片附件端点依赖网页会话，需由人拖拽上传。本地路径
  `tmp/design-evidence/{rsb,doc}-{light,dark}-flat.png`（gitignore 覆盖的临时目录，
  栅格不入仓）。上传后可把评论链接回填到本文件。
- 换肤中间帧未验证：截图前已等主题切换完成（relaunch 后采集），未检查换肤动画时序。
- 窗口背景透明（vibrancy），CDP 原图含 `alpha=0` 区域；本目录引用的查看版本已把
  alpha 展平到对应主题表面色上，避免看图工具各自合成底色导致误判明暗。

## 采集版本源码 SHA-256

哈希按文件内容的 LF 规范化形态计算（`sed 's/\r$//' <file> | sha256sum`，与 Git blob 一致）。
下表已更新到**评审修复轮 + 虚拟滚动轮之后**的源码：默认态 / 按下态的实测值仍然适用
（此后只加过 aria-label、unsupported 禁用态、展开态分片与虚拟滚动接线；标题行控件本身的
配色 / 圆角 / 尺寸未变），unsupported 禁用态本身未实机目检（见「缺口登记」）。

| 文件 | SHA-256 |
| --- | --- |
| `features/cc-agent/workdir-browse/fileTreeHeaderButtonClass.ts` | `571c2021d9589b99141e8ca2c07331f7bab7994384f0a860d3a55534a2232840` |
| `features/cc-agent/workdir-browse/FileTreeIgnoredDirsToggle.tsx` | `de2b2070c559c3f82410761c34e35f84c6fb0cf62fcc78b2eff49b5991f69726` |
| `features/right-sidebar/plugins/file-browser/FileBrowserBody.tsx` | `9733c40b3d319a37c1ab79fe060c4216c835f3967a55472a6562b157a73eb1ea` |
| `features/cc-agent/workdir-browse/WorkdirBrowseSidebar.tsx` | `67a095a2d548546bf7cc39dd1e1a9c2083d9079bbba1db7a939d0defb8cbd0e3` |
