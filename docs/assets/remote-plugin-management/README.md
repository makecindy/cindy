# 远程插件与技能管理页面证据

以下为 macOS 隔离 Electron 的真实截图，只保留插件/技能区域，不含任务记录或凭证。

## 完整 Skill Hub 远程管理（2026-10-16）

以下三张图片来自本次修正最终产品源码的实际 Electron：A 管理独立沙盒 B，复用原有
「公开／组织／本地技能」、分类、卡片、详情与安装弹窗。真实目标数据经原 device-link
读取，没有替换 IPC 或注入目录 fixture；同机双沙盒不等于两台物理电脑。

| 图片 | 覆盖 |
| --- | --- |
| [skills-target-market-light.png](skills-target-market-light.png) | Light：选择 B 后显示完整公开市场，保留作者、下载量、分类和原页签。 |
| [skills-target-market-dark.png](skills-target-market-dark.png) | Dark：相同目标与市场布局，已实机目检。 |
| [skills-target-installed-dark.png](skills-target-installed-dark.png) | B 的「本地技能」列表，共 58 项，含原有内置条目。 |

公开市场与 B 本机原服务返回逐项一致，首屏 24 项、分页后 48 项；组织首屏 24 项。
原安装弹窗已把市场 Skill 装到 B 的临时项目，随后从 B 的本地详情经 OS 原生确认卸载；
A 的全局安装记录均未改变。操作仅涉及测试项目。
[测试文件清单](skills-full-desktop-test-files.json)为 14 文件 / 243 项，
[源码 SHA-256](skills-full-source-sha256.json)记录采集源码；截图随本次修正一起提交。
合并 main@ae54765a3 后，A 从合并源码启动并重新读取 B、重拍上述截图；[合并复验清单](skills-merged-desktop-test-files.json)为 19 文件 / 274 项（含原技能用例，不累加），类型检查、冲突文件 ESLint、文档/设计台账检查通过。B 保持技能修复 Host；下文截图与数字保留各自历史归属。

### 技能页常驻目标提示（2026-10-16 补充）

技能页在正常读取完成后也显示「正在管理的电脑／修改保存位置」，与插件页复用
`CatalogManagementNotice` 及原有多语言文案。离线、旧 Host 和读取失败仍显示对应说明；
正常状态不显示重试按钮。上方三张截图已从实际 A→B 页面重新采集，公开、组织和本地技能
切换后提示持续可见；Light/Dark 均已目检，本地技能仍为 58 项。

本轮 `RemoteSkillsPage`、`SkillhubHomeNavigation`、`marketRoutes` 三个测试文件共 55 项通过，
Desktop 类型检查和改动文件 ESLint 通过。`6405c83e6` 的 Linux/Windows CI 同源失败来自
遗留 `controls` 源码断言，已对齐原页面的 `headerActions`；保留电脑控件与原市场交互的断言。
本轮只复验页面与读取，安装/卸载证据保留前述历史归属，新 head CI 另行回读。

## Project Scope 保留主干功能（2026-10-16）

对照 `main@6e2ba9286` 的原 Scope Picker，保留本机当前目录／最近项目与原生目录选择，
远程项目同样显示名称和完整路径，保留目标最近目录（包括暂时不可访问的目录）。
「选择其他文件夹」复用现有远程选择器并固定所选电脑；只生成临时项目 scope，
不创建任务或改写最近项目。项目启停使用 Host ID 和 revision，全局开关仍为主开关。

| 图片 | 实机覆盖 |
| --- | --- |
| [project-scope-target-light.png](project-scope-target-light.png) | B 的最近项目与浏览目录；同名项目通过路径区分。 |
| [project-scope-target-dark.png](project-scope-target-dark.png) | 同一目标项目菜单的 Dark 模式。 |
| [project-scope-browse-light.png](project-scope-browse-light.png) | 复用原远程目录选择器，目标固定为 B，真实浏览 QA 目录。 |

同一 Mac 的两个独立已登录 Electron Host，通过真实 device-link 验收，未替换 IPC：
A 最近项目为空，B 最近项目为 1 项；浏览成功与取消后两端最近列表均未改变。
A 对 B 浏览目录中的 Art 执行停用／启用，B 本机回读确认项目例外生效并恢复；
B 全局开关、B 另一项目、A 的同路径偏好均未改变。Light/Dark 截图已目检，
源码与验收摘要见 [project-scope-source-sha256.json](project-scope-source-sha256.json)。

本轮相关 12 文件／157 项通过，Desktop 类型检查、其余修改文件 ESLint、设计台账与
开发文档检查通过。`index.ts` 文件级 ESLint 的 13 个错误在修改前的 `2817ec131` 同样存在
（2 个未使用变量、11 个 fallthrough），本轮未修无关代码。首轮新增测试的模拟环境／
类型声明错误已修正并重跑通过。跨物理电脑、Windows 与 Mobile 未实测。

## 历史列表与电脑菜单

| 图片 | 来源与覆盖 |
| --- | --- |
| [plugins-menu-light.png](plugins-menu-light.png) | `e8ec478bf` 清理后合并 `main` 的 `a7aaaee10`，当前产品源码的本机插件列表、电脑下拉与项目子菜单入口。 |
| [skills-menu-light.png](skills-menu-light.png) | 同一次运行的技能页，共用电脑选择且没有项目菜单；裁去本机技能清单，仅展示标题和电脑菜单。 |
| [dual-host-list-light.png](dual-host-list-light.png) | `76bc4f502` 验收：控制端 A 读取目标 B 的实际插件列表，含两项 QA 插件与三项未修改的默认插件。 |
| [dual-host-list-dark.png](dual-host-list-dark.png) | 同一轮双 Host 验收的 Dark 列表；本次清理及合并主干后没有重新目检 Dark。 |

双 Host 是同一台 macOS 上两个隔离 profile，通过真实 relay、preload/Main、filePeer 与原安装器通信，不等同于两台物理电脑。QA 包没有外部请求，测试完成后已通过远程 UI 卸载。

当前合并后复验为 Desktop 57 文件 / 1,243 项通过、Desktop 类型检查和 Device Link build 通过。此前双 Host 轮次另有 50 文件 / 1,048 项白盒通过；两轮数字不能相加当作不同用例。完整过程、已有检查失败和未验证项见 [实施记录](../../remote-plugin-management-implementation.md)。
PR 首轮 CI 暴露的设计台账登记与生成区块遗漏已修复，台账检查及完整脚本测试 52 项通过；产品源码没有变化，以上当前页面截图继续对应修复后的产品实现。

上述首轮截图是页面与菜单的只读复查；后续真实授权结果的回读见下文。两物理电脑、Windows/Mobile、物理断网和两控制端同时写入仍未实测。

## 旧 Host 兼容修复（2026-10-15）

以下新增截图来自本轮源码的 headful Chrome，使用正式组件与隔离测试数据，页面顶栏
明确标记来源。旧 Host 没有新增管理能力时，仍显示正常的已装卡片及详情；提示说明
更新哪台电脑、哪些操作受限。截图没有使用真实用户插件目录或凭证。

| 图片 | 覆盖 |
| --- | --- |
| [legacy-list-light.png](legacy-list-light.png) | Light 正常卡片、图标、真实启停状态、目标电脑和能力提示。 |
| [legacy-detail-light.png](legacy-detail-light.png) | Light 详情标题、作者/版本、工具、权限和信息网格。 |
| [legacy-list-dark-narrow.png](legacy-list-dark-narrow.png) | Dark 560px 窄窗口，保留共同电脑入口，无横向溢出。 |
| [legacy-detail-dark-narrow.png](legacy-detail-dark-narrow.png) | Dark 560px 正常详情，隐藏不支持的配置及本机写操作。 |

本轮 19 张 fixture 截图另覆盖工具/权限展开、离线、另一电脑的版本、空态、缺字段和失败
后刷新。真实目标的 Light/Dark 列表/详情也已只读验证，其截图仅本地保留。

## 项目菜单空分组修复（2026-10-15）

[Light](project-menu-empty-light.png) / [Dark](project-menu-empty-dark.png) 来自本修复
提交源码的实际 macOS 隔离 Electron，最近项目确为空，未注入 fixture 或替换 IPC。
仅截项目子菜单，不包含电脑清单、任务记录或凭证。空本机菜单为 Global 与选择目录
两个选项、一条分隔线；有项目和远程空态另由定向回归验证。
这两张菜单截图不作为真实目标安装、配置或卸载的验收证据。

## 历史配置摘要与停用提示（2026-10-15）

本修复提交的真实 macOS Electron A，通过同账号 device-link 管理独立沙盒 B。
用户已在 B 完成飞书授权；本轮只回读现有状态，未重新发起 OAuth。截图仅保留插件
详情，不含任务记录、本机路径、账号标识或凭证；未注入 fixture 或替换 IPC。

| 图片 | 覆盖 |
| --- | --- |
| [config-disabled-light.png](config-disabled-light.png) | Light：停用时只保留先启用的提示，省略配置标题、保存位置说明与按钮。 |
| [config-disabled-dark.png](config-disabled-dark.png) | 同一真实目标的 Dark 停用态，已目检。 |
| [config-authorized-light.png](config-authorized-light.png) | Light：A 读取 B 的实际配置状态，显示 1 个已授权账号；重新进入详情仍可见。 |
| [config-authorized-dark.png](config-authorized-dark.png) | 同一真实授权结果的 Dark 页面，已目检。 |
| [config-enabled-form-light.png](config-enabled-form-light.png) | 历史 3553d3afc 的授权配置卡截图；当轮只打开后取消，不作为本轮授权完成证据。 |

本轮临时停用验收后恢复 B 当前的启用态及 A 初始主题，A/B 插件清单、版本与启停状态
均恢复原值。相关 7 文件 / 132 项回归及 Desktop 类型检查通过。第三方授权由用户完成；
本轮验证其最终结果能经真实链路回读并展示，没有重新走一次完整 OAuth 流程。两台物理
电脑仍未验证。


## 当前方案：展示目标插件原设置页（2026-10-15）

上节授权摘要卡已经撤回。当前方案直接加载目标已安装插件的原 HTML/JS/CSS，使用其
原有布局、账号行、保存按钮和错误提示；模型等 Host 控件复用当前主干的单一模型设置。
以下是同一 Mac 上两个独立 profile、同账号、真实 device-link 链路的实际 Electron
guest 截图，均已目检；没有替换 IPC、注入页面 fixture 或拼接 Host 窗口。原生整窗采集
因本机 ScreenCaptureKit 失败而未完成，截图仅覆盖原设置区。窄布局通过 Electron CDP
设置为 780×800，Host 与 guest 均无横向溢出。

| 图片 | 覆盖 |
| --- | --- |
| [original-settings-web-search-light.png](original-settings-web-search-light.png) | Light：B 原 Web Search 布局、开关、渠道、Key 输入和原保存/清除按钮。 |
| [original-settings-web-search-dark.png](original-settings-web-search-dark.png) | 同一原设置页的 Dark 主题。 |
| [original-settings-web-search-dark-narrow.png](original-settings-web-search-dark-narrow.png) | 780×800 窄布局中的原设置页。 |

A 修改原开关后，B 本机独立回读已保存，A 重开回显；虚构测试 Key 也完成保存、回显、
重开和清除。偏好已恢复，测试 Key 已移除，A/B 插件清单、版本、启停不变。飞书已有的
1 个账号与默认标记在原账号行回显，TapTap 已有连接在原页面回显；未重新授权或断开。

Toast 在滚动位置 160 出现和消失时，设置区 top、left、height 与滚动位置均不变。
Desktop [37 文件 / 564 项定向验证](original-settings-desktop-test-files.json)、Device Link
45 文件 / 893 项及类型检查通过。目录选择的真实成功/取消、新第三方 OAuth、两台物理
电脑、Windows/Mobile、两控制端并发和物理断网中途提交未验证；完整结果及既有全量门禁
失败见[实施记录](../../remote-plugin-management-implementation.md#原设置页通用代理修正2026-10-15)。

## 项目菜单与技能筛选区收紧（2026-10-16）

以下截图来自本轮最终源码的真实 macOS Electron A，经同账号 device-link 读取独立
沙盒 B；Light/Dark 均已目检，没有替换 IPC 或列表数据。

| 图片 | 覆盖 |
| --- | --- |
| [项目菜单 Light](project-scope-compact-light.png) / [Dark](project-scope-compact-dark.png) | 菜单宽 320px；长名称和路径省略，悬停保留全文，仍以目标 ID 选择项目。 |
| [技能筛选 Light](skills-filters-compact-light.png) / [Dark](skills-filters-compact-dark.png) | 电脑选择在标题右侧；目标提示为 20px 高的单行；来源与分类筛选集中排列。 |
| [技能窄窗口 Dark](skills-filters-compact-narrow-dark.png) | 640px 窗口内无横向溢出，分类保持横向滚动，卡片自然变为单列。 |

公开／组织／本地技能切换、分类选择、搜索与清除已实际操作；未重复装卸或变更目标
配置。6 文件／80 项、Desktop 类型检查、4 个修改源码文件的 ESLint 通过。完整源码
摘要与尺寸见[验收摘要](compact-layout-source-sha256.json)。本轮仅 Renderer HMR；
跨物理电脑、Windows/Mobile 未实测。本地全量门禁未执行，等待 PR CI。

## 提交前审查复验（2026-10-16）

本轮合并 main `febe2e511` 后重启 A，读取前轮兼容实现的 B；两者为同一 Mac 上的独立
profile，使用真实 device-link，无列表或 IPC fixture。以下截图已目检，历史截图保持
原提交归属，不作为本轮新源码的截图。

| 图片 | 覆盖 |
| --- | --- |
| [插件列表 Light](review-plugins-target-light.png) | 目标电脑的插件与作者，main 新 metadata 布局。 |
| [详情 Light](review-plugin-detail-light.png) / [Dark](review-plugin-detail-dark.png) | 目标插件作者与版本；远程详情没有控制端个人调用卡。 |
| [原设置 Light](review-original-settings-light.png) / [Dark](review-original-settings-dark.png) | Web Search 原页面正常加载，无横向溢出；本轮只读，未保存 Key 或改变偏好。 |
| [技能 Light](review-skills-filters-compact-light.png) / [Dark](review-skills-filters-compact-dark.png) | 公开市场与常驻目标提示、完整来源与分类；三来源、分类、搜索与清除已操作。 |
| [技能窄窗口 Dark](review-skills-filters-compact-narrow-dark.png) | 640px、侧栏收起时无横向溢出，卡片单列。 |
| [项目菜单 Light](review-project-scope-compact-light.png) / [Dark](review-project-scope-compact-dark.png) | 320px 宽、长路径省略，悬停保留完整路径。 |

源码／图片摘要及尺寸见 [本轮验收清单](review-source-sha256.json)，测试见
[89 文件清单](review-desktop-test-files.json)。共享统计字段的渲染与远程个人调用隔离另有
回归覆盖；B 未提供统计字段，本轮实机不冒称已展示真实共享计数。确认重连使用白盒回归，
未做实机故障注入。Windows/Mobile、两物理电脑、新 OAuth 与重复装卸均未在本轮实测。

## 当前筛选区与全 PR 复查（2026-10-16）

本节取代上两节的筛选区视觉：目标提示复用插件圆角描边组件，来源为下划线导航，
分类为无左右箭头的横向标签，焦点滚动保留 20% 的边缘空间。当前源码经 A 的 Renderer
HMR，真实读取独立沙盒 B 的公开市场；[Light](review-final-skill-header-light.png) 与
[Dark](review-final-skill-header-dark.png) 均已目检。两者不是物理双电脑证据。

全 PR 复查清理了无引用文案、不可达分支、重复筛选和复述型注释，并修复原设置页读取
消息失败时漏发 `onmessageerror`；该回归先复现失败再修复通过。合并 main `c3d2f3b27`
后，[Desktop 91 文件 / 1724 项](final-review-desktop-test-files.json)、Device Link 47 文件 /
957 项、两包类型检查、i18n、文档与设计台账检查通过。ESLint 扫描 63 个生产文件，
33 项失败与同一 main 的对应文件逐项一致，没有新增；不冒称 ESLint 全通过。
本轮未重复装卸、新 OAuth、两物理电脑或 Windows/Mobile 验收。
本地全量门禁未执行，等待 PR CI。
