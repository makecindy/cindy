# 凭证与本地存储安全

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改凭证或授权信息处理、文件落盘位置、用户持久数据、临时文件、
> 测试目录或运行时生成物之前

本文约束 Desktop、Mobile、共享 package、脚本和测试中的本地文件写入。数据库 migration
另见 [`database-and-migrations.md`](database-and-migrations.md)，Renderer 与 IPC 边界另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)。

> **增量适用原则**：本规则约束新增和正在修改的代码，不要求为统一目录结构专项迁移
> 存量数据。存量凭证或用户数据迁移必须单独设计兼容、回滚和验证方案。

## 凭证不入仓

- 用户凭证、OAuth 授权、API key、访问令牌、刷新令牌、私钥和 Agent 授权文件不得以
  复制、链接、fixture、日志或生成物等形式进入仓库工作区或任何可能被 Git 跟踪的路径。
- `.gitignore` 只是误操作兜底，不是凭证存储方案。发现凭证曾进入 Git 历史时，应立即
  停止传播并通知用户作废凭证；删除工作区文件不能撤销泄露。
- 运行时需要持久化秘密时，复用现有 Main／宿主管理的 credential store 或 Electron
  `safeStorage` 边界。不要新增自定义明文凭证文件，也不要把秘密下放给 Renderer、插件
  或不受信任页面。
- access token 等只需短期使用的秘密优先保留在内存中。日志、错误、遥测和调试输出不得
  包含凭证明文、完整鉴权头或可直接复用的授权材料。
- 测试只使用明显无效的假凭证，不读取或复制开发者真实的 `HOME`、Agent home、
  Electron userData 或系统凭证目录。

## macOS safeStorage 钥匙串条目

- macOS 上 Electron `safeStorage` 的钥匙串条目名由 `app.name` 派生
  （service = `<app.name> Safe Storage`）。当前语义（#871）：packaged cn / global 与
  **共享 userData** 的 dev 共用 `Cindy Safe Storage`；**显式隔离**的 dev 沙箱
  （`--isolated` / `XDT_ISOLATED=1`）在首启（profile 为空）时选定独立的
  `CindyDev Safe Storage`，并把身份写入 profile 根的 `keychain-identity` 标记文件、
  跨重启粘住（见 `apps/desktop/src/main/devKeychainName.ts`；身份不能用「目录是否
  为空」做持续判据）。隔离沙箱默认目录随之升纪元为 `<userData>-dev2[-<名字>]`：旧
  `-dev` 目录属 `Cindy` 身份纪元、留给旧 checkout，同名目录被两种身份轮流打开会互毁
  密文。无标记且已有数据的旧沙箱永久保持默认条目名（存量密文绑定旧
  条目主密钥，零迁移只对新沙箱成立）；裸设 `XDT_USER_DATA_DIR` 只是目录覆写、不表达
  隔离意图（devCliFlags 契约），**绝不认领 `CindyDev`**——但打开的目录已带标记时依
  标记运行（观察模式：身份是 profile 的属性，不随启动旗标切换），标记不可读或内容
  不可识别同样拒绝启动。空 profile 的身份在两种模式下都经标记文件**原子落定**
  （隔离启动认领 `CindyDev`，覆写启动认领默认身份 `Cindy`，输家依胜者标记），
  防并发启动对同一 profile 以两种身份写密文。
- 钥匙串条目名与 userData profile 的存量密文一一绑定：**不得**在共享既有 profile 的
  进程里改 `app.name`——换名后新写入的密文对共用该 profile 的其它身份不可解，双向串坏。
  改动条目名属存量凭证迁移，按上方增量适用原则必须单独设计兼容/回滚/验证方案。
- 同机装过 cn 与 global 双版的机器上，后启动的版本首次访问 `safeStorage` 会触发系统
  钥匙串授权弹窗，属 macOS 按预期征求同意；应引导用户点「始终允许」。点「拒绝」后
  加解密降级失败，authManager 的 safeStorage helpers 会按原因落一次 warn 日志。
- 不要在启动路径主动调用 `safeStorage.isEncryptionAvailable()` 做探测——macOS 上探测
  本身可能触发钥匙串授权弹窗，把弹窗时机提前到与用户动作无关的启动期。

## 路径与生命周期

| 数据性质 | 正确位置 |
|---|---|
| Cindy 管理的持久数据 | Desktop 使用 `app.getPath('userData')`，共享 package 由宿主注入等价根目录 |
| 可丢弃的临时数据 | `app.getPath('temp')` 或 `os.tmpdir()` 下的任务专属目录 |
| 测试生成物 | `os.tmpdir()` 下通过 `mkdtemp` 创建的独立目录，并在测试结束时清理 |
| 用户明确导出的文件 | 用户选择或任务明确指定的目标路径 |

- 禁止把 `process.cwd()`、仓库根或源码目录作为 userData、凭证目录或临时目录的默认回退。
  特别不要写 `process.env.TEMP ?? process.cwd()` 一类跨平台会落入仓库的逻辑。
- 使用 `path.join`、`path.resolve` 和现有路径策略，不硬编码平台分隔符，不手拼 `~`、
  `%APPDATA%` 等平台目录。
- 共享 package 不直接依赖 Electron 来猜宿主目录；由 Desktop、Mobile 或测试显式注入路径。
- 新模块不得在 import 时创建目录、写文件或复制授权材料。文件系统副作用应在显式初始化
  或用户动作中发生，便于控制路径、失败语义和清理。
- 临时文件使用唯一目录或文件名，完成、失败和取消路径都应尽力清理；需要跨重启保留的
  内容不属于临时文件，应进入明确的 userData 存储与生命周期设计。

## Review 清单

1. 写入目标是否可能位于仓库、当前工作目录或被 Git 跟踪的路径？
2. 是否把真实凭证带入了测试、fixture、日志、错误或 Renderer？
3. 持久数据、临时数据和用户导出是否选择了正确的生命周期与目录？
4. 路径回退在 Windows、macOS 和 Linux 上是否都不会落入工作区？
5. package 是否由宿主注入路径，且初始化没有隐式写盘副作用？
6. 失败、取消和测试结束后，临时数据是否能安全清理？

命中凭证进入仓库或不受信任边界的改动必须阻断。验证命令按
[`desktop-development.md`](desktop-development.md) 或
[`mobile-development.md`](mobile-development.md) 选择，并为路径回退、清理和秘密不外泄补
定向测试。
