# iOS 应用图标切换（Alternate App Icon）方案

> 状态：已实现（2026-11-14），待真机验收与冷更把关人确认；不代表已排期发售。
> 核对日期：2026-11-14。源码基线：`origin/main` `d13d75ea83`（2026-11-14）。
> 范围：`apps/mobile` 的 iOS 构建（CN `com.xd.cindycn` / Global `com.xd.cindy`），首批只做
> `wordmark` 一个备选图标。Android 与桌面不在本方案内（桌面已有 Dock 图标选择）。

## 1. 结论

- **官方能力，不是私有 API**：`UIApplication.setAlternateIconName(_:completionHandler:)` 自
  iOS 10.3 起公开，Xcode 用「Alternate App Icon Sets」build setting 生成
  `CFBundleAlternateIcons`。不需要 entitlement，App Review 也没有额外权限申请。
- **切换本身不需要发版**：用户选一次图标，系统立即换主屏、设置与搜索里的图标；但
  **“让包具备这个能力”必须随一次冷更包发布**——备选图标是编译进安装包的资源，OTA 改不了。
- **首批范围**：主图标不变，新增一个 `wordmark` 备选。设置 → 外观里提供「默认 / Cindy 字标」
  两个选项，切换只在这台设备生效（与桌面 Dock 图标的选择范围一致）。
- **素材**：桌面现有 wordmark 是 512、带透明、已烘圆角的 Dock 成图，iOS 不能直接用。改用仓库内
  官方 SVG 字标 + 同色渐变底重排 1024 满幅不透明图；该路径已在本机验证（见附录 B）。

## 2. 官方支持依据

| 证据 | 已确认 | 不能据此推断 |
| --- | --- | --- |
| [`setAlternateIconName(_:completionHandler:)`](https://developer.apple.com/documentation/uikit/uiapplication/setalternateiconname(_:completionhandler:)) | “Use this method to change your app's icon to its primary icon or to one of its alternate icons.”；“You specify the names of additional icon assets available to your app using the **Alternate App Icon Sets** build setting. Xcode uses these settings to generate the entries for `CFBundleIcons` and `CFBundleAlternateIcons`.” | 系统切换提示的文案与时机由系统决定，不由此 API 承诺 |
| [Human Interface Guidelines · App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons) | “it's possible to let people visit your app's settings to choose an alternate version of your app icon”；“Alternate app icons in iOS and iPadOS require their own dark, clear, and tinted variants”；备选图标同样接受 App Review | 系统会替我们生成全部外观变体且效果达标 |
| 本机 Xcode 27.2 / iOS 27.2 SDK | `UIApplication.h` 仍有 `supportsAlternateIcons` / `setAlternateIconName:` / `alternateIconName`；`AssetCatalogCompiler.xcspec` 有 `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES`；`actool` 支持 `--alternate-app-icon` | 模拟器行为等同真机 |
| `iOS` 平台资产格式 | iOS/iPadOS 支持单张 1024×1024 自动生成全部尺寸；iOS 18 起支持 dark / tinted 外观 | clear 外观是否可由系统从单张图派生得足够好 |

结论：方案走的是 Apple 文档里写明的公开路径。唯一“不官方”的常见做法是屏蔽切换时的系统弹窗
（私有/取巧手段），本方案不做。

## 3. 现状核对（代码事实）

| 事实 | 依据 |
| --- | --- |
| Mobile 走 Expo CNG，仓库没有 `ios/` 目录，原生工程在 prebuild 时生成 | `apps/mobile` 目录树；`app.json` 的 `plugins` |
| 包身份按 region 分流，CN/Global 共用同一套图标资源 | `apps/mobile/app.config.js` |
| runtime 版本用 fingerprint 策略，原生输入一变就必须冷更 | `app.json` 的 `runtimeVersion.policy`；[`mobile-development.md`](../dev-rules/mobile-development.md) |
| 主图标是单张 1024 universal，由 Expo 的 iOS icon 插件写入 `Images.xcassets/AppIcon.appiconset` | `@expo/prebuild-config` 的 `withIosIcons` |
| 现有原生模块形态：`apps/mobile/modules/<name>`，Swift + expo-modules-core；`cindy-*` 模块由 `modules/` 自动链接，不需要在 `package.json` 登记 | `modules/cindy-haptics`、`modules/xdt-screenshot-monitor` |
| 桌面版只换 Dock 图标，Finder/Launchpad 不变，选项为 default/cat/wordmark/mark | `apps/desktop/src/main/app-icon.ts`、`components/settings/DockIconPicker.tsx` |
| 仓库内目前没有任何 alternate icon 实现 | 全仓检索 `setAlternateIconName` / `CFBundleAlternateIcons` 无命中 |

## 4. 用户看到的行为

1. 设置 → 外观，新增一行「应用图标」，两个 44pt 瓦片：默认、Cindy 字标。
2. 点 Cindy 字标：系统弹出「已更改图标」提示；主屏幕、设置、搜索里的图标立即变化。
3. 点默认：切回主图标，同样有一次系统提示。
4. 选择只保存在这台手机；重启 App 保持；卸载重装回到主图标。
5. Android 不显示这一行。

## 5. 设计

### 5.1 资源形态

- 新增 `Images.xcassets/AppIcon-Wordmark.appiconset/`，内含：
  - `wordmark-light.png`（1024×1024，RGB 无 alpha）
  - `wordmark-dark.png`（1024×1024，RGB 无 alpha）
  - `Contents.json`：两条 `idiom: universal` + `platform: ios`，其中一条带
    `appearances: [{ appearance: "luminosity", value: "dark" }]`。
- 资源集名称 `AppIcon-Wordmark` 同时是运行时名称，**发布后不得改名**（改名会让已选用户回落到
  主图标）。
- 不设 `ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS`，只登记明确的名字，避免以后新增的
  图标资源被意外打进包。

### 5.2 config plugin

新增 `apps/mobile/plugins/with-ios-alternate-app-icons.js`：

- `withDangerousMod('ios')`：把 `assets/app-icons/` 下的两张 1024 PNG 与 `Contents.json` 写入
  `ios/<name>/Images.xcassets/AppIcon-Wordmark.appiconset/`；每次 prebuild 覆盖，并清掉列表外
  的旧 appiconset，保证幂等。
- `withXcodeProject`：对 app target 的每个 build configuration 写
  `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = AppIcon-Wordmark`。
- 插件本身不碰主图标设置（`ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon` 仍由 Expo 负责）。
  现有同类先例：`apps/mobile/plugins/with-message-menu-icons.js` 就是在 prebuild 时把
  `assets/message-menu/*.imageset` 拷进 `Images.xcassets`；本插件沿用同一形态，只多一步写
  build setting。

### 5.3 原生模块

新增 `apps/mobile/modules/cindy-app-icon`（`platforms: ["apple"]`，`expo-module.config.json` 声明
`CindyAppIconModule`，无需在 `apps/mobile/package.json` 登记依赖）：

```text
getAlternateIconName(): string | null      // null = 主图标
supportsAlternateIcons(): boolean
setAlternateIconName(name: string | null): Promise<void>
```

- `setAlternateIconName` 必须切到主线程调用；不支持时 reject
  `ERR_ALTERNATE_ICON_UNSUPPORTED`，系统返回错误时 reject `ERR_ALTERNATE_ICON_SET` 并带上
  `localizedDescription`。
- JS 侧用 `requireOptionalNativeModule`，模块缺失（Android / 旧包）时整体 no-op，界面不显示。

### 5.4 JS 与 UI

- `src/settings/appIconPreference.ts`：本机偏好，键 `xdt-maker.mobile.app-icon.v1`（沿用现有
  `xdt-maker.mobile.*` 前缀），取值 `default` / `wordmark`；沿用现有 AsyncStorage 偏好 store 的
  读写与损坏值回落语义。
- `src/settings/useAppIcon.ts`：挂载时以原生 `getAlternateIconName()` 为准做一次对账（见 5.5），
  暴露 `{ choice, supported, pending, select }`。
- 组件按仓库现有的平台分文件写法：`src/settings/AppIconSettings.ios.tsx` 提供一行两瓦片
  （复用 `useSettingsRowStyles()` 保持与设置行同一内边距/字号；选中环、44pt 热区、
  `accessibilityRole="radio"`；失败回滚并用系统 Alert 说明），`AppIconSettings.tsx` 在 Android
  返回 `null`。挂载点：`app/settings.tsx` 的外观分组**之后**，自成一个「应用图标」分组——
  设置行规范要求说明性文字放在分组 footer，而外观分组的 footer 不能只描述其中一个行。
- i18n 键（12 个 locale 的 `settings.json`）：

```text
settings.appearance.appIcon.label             应用图标
settings.appearance.appIcon.rowLabel          样式
settings.appearance.appIcon.hint              切换后主屏幕图标会立即更新，只在这台手机上生效。
settings.appearance.appIcon.options.default   默认
settings.appearance.appIcon.options.wordmark  Cindy 字标
settings.appearance.appIcon.setFailed         图标没有切换成功，请稍后重试。
settings.appearance.appIcon.saveFailed        图标已切换，但没能保存选择。
```

文案沿用桌面 `settings.appearance.appIcon` 已发布的叫法（「Cindy 字标」）。术语表已补
`wordmark → Cindy 字标` 的 `status: "proposed"` 条目（`i18n/glossary.json`），规则仍是
“先登记待裁决，不在术语表之上做脚本替换”。

### 5.5 状态模型

系统里的 `alternateIconName` 是唯一真值，本地偏好只是缓存：

| 事件 | 系统图标 | 本地偏好 | 处理 |
| --- | --- | --- | --- |
| 首次安装 | primary（nil） | 空 | 显示默认 |
| 用户选择 wordmark | wordmark | wordmark | 一致 |
| 切到后台再回来 / 重启 | 保持 | 保持 | 启动**不**调用 set，避免无端弹窗 |
| 卸载重装 | primary | 清空 | 显示默认 |
| iCloud 恢复备份 | primary | 可能是 wordmark | 启动对账发现不一致：以系统为准，清掉偏好并显示默认 |

### 5.6 失败与边界

- `supportsAlternateIcons === false`：整行隐藏（或禁用并给一行说明），不提供会失败的入口。
- 设置失败：瓦片回滚到系统当前图标，toast 说明“图标没有换成功”，不写偏好。
- 系统弹窗：不做屏蔽；提示文案提前说明“会弹出系统提示”。
- iPad：同一 API，单张 1024 覆盖；验收需覆盖 iPad。
- 扩展 / Widget：不在扩展里调用（系统同样禁止），Widget 不展示 App 图标，无额外处理。
- 图标外观：首批提供 light + dark；tinted / clear 依赖系统从现有图派生，真机验收不达标再补图。

## 6. 素材

### 6.1 为什么不能直接用桌面成图

桌面 `apps/desktop/resources/app-icons/wordmark-*.png` 是 512×512、四周 47px 透明边距、圆角已烘进
文件的 Dock 成图（见 `apps/desktop/scripts/generate-mac-icns.mjs` 注释）。iOS 要求满幅方形、
不带 alpha、由系统自己加圆角；直接使用会出现透明角与“双重圆角”。

### 6.2 采用的路径

用仓库内官方字标矢量重排：

- 字标：`.github/assets/cindy-wordmark-light.svg` / `cindy-wordmark-dark.svg`（viewBox
  6828×2332，字色 `#040303` / `#FFFFFF`，箭头红 `#F70121`）。
- 底色：从桌面成图采样，light `rgb(255,255,250)` → `rgb(238,238,234)`，dark
  `rgb(50,44,44)` → `rgb(19,17,17)`，纵向线性渐变。
- 字标比例沿用桌面成图：宽 67.8% 画布、中心 y 50.2%；产物为 1024×1024、RGB 无 alpha。
- 生成脚本放仓库根 `scripts/generate-mobile-app-icons.mjs`（仓库规则：开发脚本不进
  `apps/mobile/package.json`，避免扩大指纹输入），用本机 ImageMagick 的 `magick` 栅格化 SVG
  （已验证透明底、矢量锐利），不新增 npm 依赖。产物入库，构建期不依赖 ImageMagick：
  `apps/mobile/assets/app-icons/wordmark-light.png`、`wordmark-dark.png`。

### 6.3 变体

| 外观 | 来源 | 本轮处理 |
| --- | --- | --- |
| default | light 1024 | 提供 |
| dark | dark 1024 | 提供 |
| tinted | 系统派生 | 先验证；不达标再补 |
| clear（iOS 26+） | 系统派生 | 先验证；不达标再补 |

## 7. 冷更与分发

会改变 runtime fingerprint 的输入：`plugins/`（新插件）、`modules/`（新原生模块）、
`app.json`（插件登记）、`assets/app-icons/`（新增素材，需显式加进
`fingerprint.config.cjs` 的 `extraSources`，写 `{ type: 'dir', filePath: 'assets/app-icons' }`，
否则以后改图不会触发冷更）。

按 [`mobile-development.md`](../dev-rules/mobile-development.md) 的冷更边界，PR 必须写明：

1. 为什么冷更不可避免：备选图标是原生资源 + build setting，OTA 无法下发。
2. 存量装机影响范围：升级到该包之前，所有存量装机都用不到这个功能；功能本身不改变既有行为。
3. 发版节奏建议：搭下一次计划内原生版本一起发，不为一个图标单独发版。

合并前需仓库指定的把关人针对冷更明确确认（与技术框架变动同一门禁）。仓库已有同类先例
（`cindy-haptics`、HTML 预览）的发布口径：随下一轮安装包发布，不向旧包发送指纹不匹配的 OTA。

回滚：撤回插件登记即可让新构建不再带备选图标；已发出的包无法远程撤销该能力，但用户可随时在
设置里切回默认。

## 8. 测试与验收

### 8.1 自动化

- `src/__tests__/appIconPreference.test.ts`：读写、默认值、损坏值回落。
- `src/__tests__/AppIconSettings.test.tsx`：mock 原生模块；选择成功 → 调 set 并写偏好；
  失败 → 回滚 + 错误提示；`supports=false` → 不渲染。原生桥接按 `cindy-haptics` 的口径覆盖
  桥接缺失、能力拒绝、成功、同步/异步异常四条路径（见 `apps/mobile/docs/haptics.md`）。
- 插件单测：给定 fixture 配置，断言 appiconset 文件与 `Contents.json` 结构；断言 build setting
  只写一次且值正确。
- `pnpm --filter mobile typecheck`、相关 vitest 全绿。

### 8.2 构建产物断言

`prebuild` 只证明源文件写对了；必须验证**最终包**里真的有备选图标：

```bash
plutil -p <Cindy.app>/Info.plist | grep -A6 CFBundleAlternateIcons   # 应有 AppIcon-Wordmark
xcrun assetutil --info <Cindy.app>/Assets.car | grep -i wordmark      # 应有对应图标条目
```

### 8.3 真机验收清单

- iPhone：默认 → Wordmark → 默认，主屏图标变化且无崩溃。
- 系统提示出现一次，文案可接受。
- 重启 App 保持选择；卸载重装回默认。
- 深色 / 浅色 / 染色 / 清晰外观下图标可读、无白边或裁切。
- iPad 同样通过。
- 冷更前安装的旧包：不显示该行，不报错。

## 9. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 系统提示不可定制 | 用户可能以为是异常 | 设置页提前说明；不屏蔽 |
| tinted/clear 由系统派生效果差 | 图标在个性化外观下发灰或失真 | 真机评审；不达标补设计变体 |
| 平面 PNG 在 iOS 26 玻璃外观下显旧 | 与系统图标观感不一致 | 先验收；后续评估 Icon Composer `.icon` |
| 素材与设计稿有细微差异 | 品牌一致性 | 设计复核产物；脚本参数可调 |
| 指纹变化 | 存量用户暂时拿不到后续热更 | 搭计划内原生版本发布，PR 写清影响 |
| 改图标期间 App 进入后台 | 调用失败 | 失败回滚 + 提示，不写偏好 |

## 10. 备选与取舍

- **快捷指令自定义图标**：用户可自己做，但不在 App 内、入口不受控，不满足需求。
- **Icon Composer `.icon` 备选图标**：Liquid Glass 效果最好，但“备选 `.icon` 能否被
  `setAlternateIconName` 切换”没有官方明文，本轮不采用，列为后续验证项。
- **只做主题色/深色模式**：不换图标，不解决“选图标”的需求。
- **本轮只做 wordmark**：素材与验证面最小；跑通后再评估 cat / mark。

## 11. 里程碑与工作量

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| 1 | 素材脚本与两张 1024 产物、设计复核 | 0.5 天 |
| 2 | config plugin + 单测 | 0.5 天 |
| 3 | 原生模块 + JS 封装 | 0.5 天 |
| 4 | 设置页 UI、i18n 12 个 locale、测试 | 1 天 |
| 5 | 冷更构建、真机/iPad 验收、PR 与门禁 | 0.5 天 |

合计约 3 人日（不含设计出图与排队发版）。

## 12. 实施流程与门禁（Craft）

> 进入 Make 前先满足前置条件；每一步都有产物、验证命令和退出条件，缺证据不进入下一步。
> 阶段与证据口径遵循 Craft 的 Definition of Done，验收只认实际执行的收据。

### 12.0 前置（G0）

| 项 | 要求 | 验证 |
| --- | --- | --- |
| 工作区 | 基于 `origin/main`（当前 `d13d75ea83`）的独立分支，不与别的任务混用 | `git log -1`、`git status --short` |
| 依赖 | 新 worktree 不共享 `node_modules`，先安装 | `pnpm --version`、`pnpm install`、`git lfs pull` |
| 指纹基线 | 改动前先算一次，作为冷更对比的 base | `node apps/mobile/scripts/ci-fingerprint.mjs compute --output /tmp/mobile-fp-before.json` |
| 冷更意图 | 确认搭下一次原生版本；PR 合并前需要把关人确认 | 记录在 PR 描述与评论 |

G0 退出：基线指纹、依赖就绪、冷更意图有据可查；任一项缺失即 `blocked`。

### 12.1 M1 素材（约 0.5 天）

产物：
- `scripts/generate-mobile-app-icons.mjs`（SVG → 1024 满幅、渐变底、无 alpha）
- `apps/mobile/assets/app-icons/wordmark-light.png`、`wordmark-dark.png`

验证：
- `sips -g pixelWidth -g pixelHeight -g hasAlpha`：均 1024×1024、`hasAlpha: no`
- 字标宽 67.8%、中心 y 50.2%，与桌面成图比例一致
- 设计复核：light/dark 两张在圆角遮罩下不裁切字标

退出：两张图 + 可复跑脚本；设计确认或明确由实现方拍板。

### 12.2 M2 config plugin（约 0.5 天）

产物：
- `apps/mobile/plugins/with-ios-alternate-app-icons.js`
- `app.json` 的 `plugins` 登记

验证：
- 插件单测：appiconset 文件与 `Contents.json` 结构、build setting 只写一次
- `npx expo prebuild -p ios --no-install` 后检查 `Images.xcassets/AppIcon-Wordmark.appiconset/`
  与 `project.pbxproj` 里的 `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES`
- 幂等：连续跑两次 prebuild，产物一致

退出：prebuild 产物正确且可重复；否则回到插件实现。

### 12.3 M3 原生模块（约 0.5 天）

产物：
- `apps/mobile/modules/cindy-app-icon/`（`expo-module.config.json`、podspec、Swift）
- `apps/mobile/src/settings/appIconNative.ts`（`requireOptionalNativeModule` 封装）

验证：
- `pnpm --filter mobile run --if-present typecheck`
- 桥接四路径单测：模块缺失、`supports=false`、成功、系统报错
- iOS 编译通过（`pnpm mobile:sim:rebuild`，或 `xcodebuild` 对应模拟器）

退出：模拟器能读到 `supports` / `getAlternateIconName`，错误码与设计一致。

### 12.4 M4 UI、偏好与 i18n（约 1 天）

产物：
- `apps/mobile/src/settings/AppIconSettings.ios.tsx` / `AppIconSettings.tsx`
- `apps/mobile/src/settings/appIconPreference.ts`、`useAppIcon.ts`
- `app/settings.tsx` 外观分组之后挂载「应用图标」分组
- 12 个 locale 的 `settings.json`、`i18n/glossary.json` 的 `proposed` 条目

验证：
- 组件测试：选择成功写偏好、失败回滚、`supports=false` 不渲染
- `pnpm check:i18n`、`pnpm check:i18n-glossary`
- 深浅模式下瓦片与选中环可读；44pt 热区

退出：交互闭环可用，文案与术语通过门禁。

### 12.5 M5 集成与产物验证（约 0.5 天）

验证命令（按顺序执行并留证据）：

```bash
pnpm test:unit:related
pnpm --filter mobile run --if-present typecheck
node apps/mobile/scripts/ci-fingerprint.mjs compute --output /tmp/mobile-fp-after.json
plutil -p <Cindy.app>/Info.plist | grep -A6 CFBundleAlternateIcons
xcrun assetutil --info <Cindy.app>/Assets.car | grep -i wordmark
```

退出：全部通过；指纹对比解释清楚；真机清单（8.3）完成。

### 12.6 Assure（聚焦审查）

- 审查范围：本次全部改动文件。
- 必查项：冷更声明、指纹前后对比、构建产物断言、失败与回滚路径、i18n/术语、
  Android 与旧包降级。
- 方式：单 hat `critique` 评审 + 修复路由 + 修复后复扫；争议项记录保留理由。
- 结论只能是 `ready` / `not-ready` / `blocked`；`not-ready` 必须给出下一步。

### 12.7 Close（交付）

- PR 描述：改了什么、验证命令与结果、冷更三件事、风险、回滚方式。
- 门禁：把关人对冷更明确确认（PR 评论留痕），不看改动大小。
- 发版：随下一轮原生版本；不向旧包发指纹不匹配的 OTA。
- 回滚：撤回 `app.json` 插件登记或后续构建移除模块；已发用户可在设置切回默认。

### 12.8 Learn（可选，交付后）

- 把「prebuild 写资源 + build setting + 原生桥接 + 冷更门禁」沉淀为移动端可复用样例。
- 更新本方案状态为已实现，并把实际验收证据补进文档。

### 12.9 证据对照

| 结论 | 由什么证明 | 不能证明什么 |
| --- | --- | --- |
| JS 交互与回滚正确 | vitest 组件/store 用例 | 真机系统行为 |
| prebuild 资源写入正确 | 插件单测 + prebuild 产物检查 | 最终打进包 |
| 包内真的登记了备选图标 | `Info.plist` / `Assets.car` 断言 | 用户能看到、能切换 |
| 确实触发冷更 | 改动前后 fingerprint 对比 | 发版判定（以 release 脚本为准） |
| 切换体验达标 | 真机 + iPad 截图与清单 | 其他 iOS 版本的实现细节 |
| 冷更授权成立 | PR 上把关人明确确认 | 产品排期 |

### 12.10 门禁与停点

| 门 | 时机 | 不通过时 |
| --- | --- | --- |
| G1 方案批准 | 进入 Make 前 | 停在 Shape，不改代码 |
| G2 素材批准 | M1 结束 | 换素材来源，不进入插件 |
| G3 prebuild 产物 | M2 结束 | 回到插件实现 |
| G4 真机验收 | M5 结束 | `not-ready`，列缺口 |
| G5 冷更确认 | 合并前 | PR 不进入合入流程 |

## 13. 未决问题

- tinted / clear 是否需要设计单独出图，取决于真机派生效果。
- 图标选择是否需要跨设备同步？当前按“仅本机”设计，与桌面 Dock 图标一致。
- 未来如果加 cat / mark，是否需要一次补齐全套外观变体。

## 14. 实施记录（2026-11-14）

在 `origin/main` `d13d75ea83` 上实现，验证结果如下。

| 检查 | 结果 |
| --- | --- |
| 新增单测 | 3 个文件 / 12 个用例全通过（偏好、组件、插件） |
| `pnpm test:unit:related` | 767 passed / 0 failed |
| `pnpm check:i18n` | 12 个 locale 全部一致 |
| `pnpm check:i18n-glossary` | 无新增违规 |
| `expo prebuild -p ios --no-install` | 连续两次产物哈希一致（appiconset 幂等） |
| prebuild 产物 | `Images.xcassets/AppIcon-Wordmark.appiconset` + 两个 1024 PNG + `Contents.json` |
| build setting | Debug/Release 均为 `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = AppIcon-Wordmark` |
| actool 产物断言 | partial Info.plist 含 `CFBundleAlternateIcons → AppIcon-Wordmark`；`Assets.car` 含对应 rendition |
| fingerprint | iOS `3140f266` → `b1455191`；Android `d79ebee5` → `32cb02dd`（确认冷更；`assets/app-icons` 已登记为 `extraSources`） |

未执行项：

- **完整 App 构建与真机切换验收**：本机首次构建需要 CocoaPods 全量编译（RN from source），
  耗时超出本次执行窗口；系统弹窗、tinted/clear 实际观感仍需真机或模拟器验证。
- **`pnpm --filter mobile typecheck`**：本次新增文件通过；仓库基线在
  `packages/agent-net-relay/src/cluster.ts:151,161` 有与本次无关的 `unref` 报错
  （stash 后在干净 HEAD 上复现），未在本 PR 内修改。

## 附录 A：证据摘录

- `setAlternateIconName` 文档原文（2026-11-14 读取）：“The name of the alternate icon, as
  declared in the `CFBundleAlternateIcons` key of your app's `Info.plist` file. Specify `nil`
  if you want to display the app's primary icon… Xcode uses these settings to generate the
  entries for `CFBundleIcons` and `CFBundleAlternateIcons`.”
- HIG 原文：“Alternate app icons in iOS and iPadOS require their own dark, clear, and tinted
  variants. As with your default app icon, all alternate and variant icons are subject to app
  review.”
- 本机核验命令：`grep setAlternateIconName .../iPhoneOS27.2.sdk/.../UIApplication.h`；
  `man actool | grep -A4 alternate`；
  `grep -A6 ALTERNATE_APPICON .../AssetCatalogCompiler.xcspec`。

## 附录 B：素材重建验证（2026-11-14）

用官方 SVG + 采样渐变底重排，产物 1024×1024、`hasAlpha: no`，字标宽 694px、高 237px、位置
(164, 396)，与桌面成图比例一致。对比结论：满幅无透明角、无逐行拉伸伪影；与桌面 Dock 图在
视觉上同一套字标与配色。
