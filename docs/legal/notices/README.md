# Third-party notices

本目录位于 `docs/legal/notices/`。`pnpm licenses:generate` 根据锁定依赖生成
以下合规产物：

- `desktop-win.txt`：Windows x64 桌面安装包，包含 Rust updater 与 ADB。
- `desktop-macos.txt`：macOS x64/arm64 桌面安装包。
- `desktop-linux.txt`：Linux x64 glibc 桌面安装包。
- `mobile-ios.txt` / `mobile-android.txt`：移动端 JS 生产依赖与仓库显式声明的原生 SDK。
  按 app 实际分发到的设备过滤，不含只在开发机构建期使用的平台可选原生包（这些包的
  JS 主包本身仍在声明内，只是其 `darwin`/`linux`/`win32` 预编译二进制不随 app 分发）。
- `*-restricted.txt`：与各产物对应的专有、source-available 或许可待确认组件；不计入开源包数量。
- `THIRD-PARTY-RESTRICTED.txt`：上述受限组件的全工程聚合审计表。
- `THIRD-PARTY-NOTICES.txt`：上述开源组件的全工程保守聚合声明。
- `sbom/*.spdx.json`：对应产物的 SPDX 2.3 SBOM。

桌面安装包内继续携带开放声明和桌面全平台受限声明，打包后按目标平台覆盖成
精确版本。移动端 Expo config plugin 会把同样两份文件复制进 iOS bundle 或 Android
`res/raw`。生成器会
阻断 UNKNOWN/UNLICENSED、非法 SPDX 表达式、单一强 copyleft、未锁定 Rust 依赖和
未登记的二进制资产。

每个产物闭包都按显式目标平台收集，产物内容不受生成机器上装了哪些平台可选包影响。
生成器判断可选依赖是否存在靠 `node_modules` 里有没有对应目录，而 pnpm 并不保证只
安装 `pnpm.supportedArchitectures` 声明的架构，因此省掉目标平台参数会让声明内容随
生成机器漂移。覆盖全部支持架构的闭包由 `SUPPORTED_TARGETS` 按该字段叉乘得出。目标平台
是必填的：省掉它会让生成直接失败，而不是静默产出与本机相关的声明。

移动端使用 Expo managed workflow，完整 Pod/Gradle 图只在原生构建阶段产生。因此移动端
静态声明会明确标注范围，不能替代发布构建所产生的 `Podfile.lock` 或 Gradle dependency
report。每次冷更发布仍应留存对应原生依赖报告，后续接入构建机后可将该报告并入 SBOM。
