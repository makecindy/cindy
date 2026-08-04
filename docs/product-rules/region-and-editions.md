# 区域与版本关系

> **状态**：权威产品规则（authoritative）
> **适用范围**：所有涉及区域分支的产品行为、身份命名、默认值、UI 标注与对外表述
> **读取时机**：新增或修改区域分支逻辑、构建身份、端点选择、区域相关 UI 或对外
> 文案之前

## 1. 基本关系

Cindy 是一个面向全球的产品。中国大陆版是它为当地法规、网络与服务依赖单独构建的
版本，不是主版本，也不是唯一基线。

这不是"国内版 + 出海版"的关系。产品叙事、命名、默认值和界面表达都应体现同一个
结构：**Cindy 本身就是全球产品，被单独标注出来的是中国大陆版**。

原因：

- 产品定位如此。Cindy 从第一天就面向全球用户构建，不是先做国内、再做海外输出。
- 相反的结构会主动触发"某中国公司的海外版"这一联想，与产品实际定位不符。
- 工程侧的区域标识本来就是 `global` / `cn`（`config/endpoint.global.json`、
  `CINDY_AUTH_REGION`、`--region=global`），产品口径与工程标识一致，减少歧义。

### 1.1 两个发行版本与第三个构建身份

`CindyRegion` 有三个值（`packages/maker-shared/src/brandIdentity.ts`）：

- `global` 与 `cn` 是**面向用户的两个发行版本**，本文的全部条款针对它们。
- `dev` 是**内部开发构建身份**，不是发行版本：它有自己的标识符（`CindyDev`）与端点
  清单（`config/endpoint.dev.json`），行为语义归 cn 系。

本文涉及对外表达的条款（§2.1 的无限定词归属、§2.3 的标注规则、§2.5 的对外口径）
**不适用于 `dev`**——它不面向用户发行，带 `dev` 限定是其身份本身而非"被标注的变体"。
§2.2 的缺省方向对它适用：未显式指定区域时落在 `global`，不落在 `dev`。

新增区域相关判断时，不要把三个值当作并列的三个版本处理。

## 2. 产品不变量

### 2.1 无限定词身份归 Global

**按区域派生的标识符**——无后缀的可执行名、appId、配置文件名、产物名、目录名——
无后缀的那个归 `global`，中国大陆版带 `cn` 限定。

- **共享展示名是本条的例外**：展示名两版同为 `Cindy`，不随区域变化，也不需要给
  中国大陆版加后缀（2026-07-26 决策，见 `brandIdentity.ts` 的
  `executableNameByRegion`）。本条约束的是**按区域取不同值**的标识符，不约束两版
  共用的名字。
- 新增任何按区域派生的标识符时，`global` 取无后缀值，`cn` 取带限定值。

### 2.2 默认值落在 global

新增区域维度分支时，**如果该处允许省略区域**，缺省必须落在 `global`。

不允许"未指定 → cn"、"cn 为基线、global 为覆盖"或"global 走特例分支"的写法。

**本条不要求把"必须显式指定"改成有默认值。** 发布与打包入口（
`apps/mobile/scripts/build-ios.mjs`、`build-android.mjs`、`resolveSelfHostRegion()`、
`apps/desktop/scripts/package-desktop.mjs` 的带版本路径）**故意拒绝省略 region**，
这是防止误发错版本的 fail-closed 保护，属于本条的正当例外，不得以本条为由移除。
本条约束的是"有默认值时默认哪一个"，不是"处处都要有默认值"。

### 2.3 只标注中国大陆版

需要在界面上区分两个版本时，只标注中国大陆版；Global 构建不加版本标签。

用户看到的默认形态就是 Cindy 本身，不需要向用户证明"这是全球版"。当前存在与本条
冲突的既有实现，见 §4。

### 2.4 区域是构建期维度，不是用户可选项

用户不在产品内选择"我属于哪个版本"。区域由所安装的构建决定，运行期不可切换。

产品不应出现"请选择你的版本 / 地区"这类入口。需要向用户说明差异时，说明的是当前
构建连接的服务，而不是让用户自行归类。

### 2.5 对外英文口径

- 英文使用 `Global` 与 `Mainland China`。
- 禁用 `overseas`、`international edition`、`domestic`、`China version` 等表述——
  它们都在暗示存在一个本土主场版本。
- 中文口径保持「国际版」与「中国大陆版」不变（这两个词在中文语境里没有对应的
  贬义联想，且已在多处落地）。

与术语表的分工：`i18n/glossary.json` 的机制约束的是**同一英文源词的各语言译法**，
它无法表达"英文该选哪个源词"——`overseas` / `international edition` 与 `Global`
是不同的英文词，不是同一个词的不同译法。因此本条的英文源词选择由本文约束、由 review
把关；只有当这些词**作为 UI 文案落地**时，才按 `i18n/GLOSSARY.md` 的流程登记译法。

当前两版关系没有稳定的 UI 文案形态：登录页原有的 `login.globalRegion` 正由 PR #554
替换为四语同文的 `login.regionPill.{cn,dev}`（区域代号不翻译），Global 侧不再有标签。
在 UI 形态定下来之前提前登记译法，会把一个尚未存在的用法写成裁决。

### 2.6 中国大陆特有的服务不作为全球默认

中国大陆特有的第三方连接、生态入口和服务依赖，不应在 Global 构建里作为默认项或
唯一选项呈现。

接入这类服务时，同时确认 Global 构建里的对应形态：使用该服务的国际版本、提供等价
的替代项，或在 Global 构建中不呈现该入口。三者都做不到时，属于需要产品决策的事项，
不要默认让 Global 用户看到一个只对中国大陆有意义的入口。

## 3. 验收方法

新增或修改区域相关实现时，逐条自查：

1. 新增的区域分支若允许省略区域，缺省是否落在 `global`？（若该处是发布 / 打包入口，
   是否保持了"必须显式指定"的 fail-closed 行为，没有为满足本文而引入默认值？）
2. 新增的标识符、文件名、产物名、目录名中，无后缀的那个是否归 Global？两版共用的
   展示名不受此约束（§2.1 例外）。
3. 新增的界面区分，是否只标注了中国大陆版，而没有给 Global 加标签？
4. 新增的英文文案是否使用 `Global` / `Mainland China`，而不是 §2.5 的禁用词？若该
   文案进入 UI，是否已按 `i18n/GLOSSARY.md` 流程登记译法？
5. 新接入的外部服务，在 Global 构建里是否有合适的对应形态（§2.6）？
6. 是否引入了让用户自行选择版本或地区的入口（§2.4 禁止）？
7. 改动是否把 `dev` 当成第三个发行版本处理？它是内部构建身份，对外表达条款不适用
   （§1.1）。

具体命令、构建脚本与区域参数的用法见 `docs/dev-rules/desktop-development.md` 与
`docs/dev-rules/mobile-development.md`；本文只约束产品判断。

## 4. 已知例外与待收敛项

以下是与 §2 冲突的既有实现。按 `core-product-principles.md` §9，它们属于历史实现
遗留，**不构成对新代码的豁免**：新增代码一律按 §2 执行，既有项按用户影响与迁移
风险分阶段收敛。

| 项 | 现状 | 冲突条款 | 收敛难点 |
| --- | --- | --- | --- |
| 登录页区域徽标 | 原设计规范规定国际区在标题旁显示红色 `Global` pill、中国大陆版不标。规范散落三处：`docs/design-rules/DESIGN.md` §16.1、`docs/design-rules/figma-component-spec.md` §4.10、`docs/design-rules/token-decision-table.md`（§3 的 `#df0c27` 语义与 `login-global-badge-bg` token）。落码在 `apps/desktop/src/renderer/components/login/LoginControls.tsx` 的 `LoginTitleBlock`（`LoginPage.tsx` 只负责传入） | §2.3 | **正在收敛**：PR #554 已将徽标翻转为 global 不标、`cn` / `dev` 标注，并同步修订 `DESIGN.md`。但它只改了三份设计源中的一份——`figma-component-spec.md` §4.10 与 `token-decision-table.md` 仍规定 `Global` pill 可见。**本行的删除条件是实现与三份设计源全部收敛，而不是 #554 单独合并** |
| 侧栏与移动端的区域标签 | 桌面侧栏 `apps/desktop/src/renderer/components/sidebar/UserInfoSection.tsx` 的 **§2.3 部分已收敛**：区域代号统一走 `apps/desktop/src/shared/regionCode.ts` 的 `CINDY_REGION_CODE`（cn → `CN`、dev → `Dev`、global 为 `null` 不标），Global 构建的版本行只剩版本号。**§2.5 部分未收敛**：cn 构建仍渲染代号 `CN`，不是本文规定的 `Mainland China`。`apps/mobile/src/settings/mobileSettings.ts:124` 的 debug 项两条都未收敛，仍输出 `Global` / `CN` | §2.5（桌面）；§2.3、§2.5（移动端） | 属于调试 / 身份自查信息而非产品叙事表达，收敛优先级低于登录页。**`CN` → `Mainland China` 是待产品裁决项**，不是单纯落码：术语表把 `CN` / `Dev` 登记为 `proposed`（`i18n/GLOSSARY.md` region-code-cn / region-code-dev），且 `DESIGN.md` §16.3 现规定徽标值就是四语同文的区域代号——改判要同时动设计规范、术语表与三条消费链路（登录页徽标、侧栏版本行、issue 正文）。本行的删除条件是移动端补上 §2.3、且 `CN` 措辞冲突被裁决或重新归类 |
| 端点清单文件名 | `config/endpoint.json` 是中国大陆版，`config/endpoint.global.json` 才是 Global | §2.1 | 改名牵动构建脚本与发布链路 |
| Electron userData 目录名 | `cn` 为 `Cindy`、`global` 为 `CindyGlobal` | §2.1 | 已发布客户端的数据目录不能直接改名，需要迁移方案 |
| Mobile 构建的 region 缺省 | `apps/mobile/app.config.js` 的 `resolveRegion()` 与 `scripts/shared/client-endpoint-build-env.cjs` 的 `resolveRegion()` 在未注入 `EXPO_PUBLIC_CINDY_AUTH_REGION` 时缺省为 `cn` | §2.2 | **有意保留的兼容基线**：这是 mobile 原生指纹基线，翻转默认值即触发一次全量冷更（`app.config.js` 顶部注释已写明）。日常开发脚本都显式注入 `global`，该缺省只在无 env 时兜底。收敛必须并入一次计划内冷更，并按 `docs/dev-rules/mobile-development.md` 的「冷更边界」取得把关人确认 |

新增或收敛任一项时同步更新本表；涉及设计规范的项，必须与 `docs/design-rules/`
对应条款同时修订，不允许两处并存互相矛盾的规定。当同一项的规范散落在多份设计文档
时，**全部收敛后才能从本表删除该行**——只改其中一份会让本表失去它唯一记录的那条例外。

## 5. 规则变更

修改本文意味着改变 Cindy 的对外定位表达，必须先获得明确的产品决策，再与相关实现、
设计规范和开发规则同步更新。
