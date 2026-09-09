# Mobile 开发、模拟器与验证

> **读取时机**：开发、启动、调试或验证 `apps/mobile` 及其共享能力时

本文是 Mobile 日常开发命令及其使用条件的权威说明；可执行脚本以当前 checkout 的根
`package.json` 与 `apps/mobile/package.json` 为代码事实源。

## 日常模拟器入口

普通开发使用根脚本维护 Metro、区域配置和 worktree 归属：

```bash
pnpm mobile:sim:start
pnpm mobile:sim:whoami
```

Windows 下 `mobile:sim:start` 还会复用或启动 `cindy-api36` Android AVD，等待系统启动完成，
并为 Metro 端口建立 `adb reverse`。中国大陆版的一键入口名称带有明确区域限定：

```bash
pnpm mobile:sim:start:cn
```

可用 `-- --avd <name>` 选择其它 AVD；只需 Metro 时传 `-- --no-emulator`。脚本从
`ANDROID_SDK_ROOT`、`ANDROID_HOME` 或 Windows 标准 Android Studio SDK 目录解析工具，
不要求把 `adb`、`emulator` 加进 `PATH`。

修改原生依赖、Expo 原生配置，或切换到尚未安装对应开发包的区域时，重新构建：

```bash
pnpm mobile:sim:rebuild
pnpm mobile:sim:rebuild -- --region=cn
pnpm mobile:sim:start -- --region=cn
```

不传 `--region` 的日常入口默认运行 Cindy（Global）；中国大陆版必须显式传
`--region=cn`，或使用名称已明确限定区域的 `mobile:sim:start:cn`。发布构建继续要求显式
指定 region。

不要用临时 Metro、端口探测或手工修改 `.env` 代替这些脚本。多 worktree、原生构建、
登录态和日志排查见 `apps/mobile/docs/simulator-debugging.md`。

## 分层验证

```bash
pnpm --filter mobile typecheck
pnpm --filter mobile exec vitest run <测试文件路径>
pnpm --filter mobile test
pnpm --filter mobile test:scope
pnpm --filter mobile test:smoke
```

- TypeScript 改动至少运行 typecheck 和相关定向测试。
- 修改跨端协议、Device Link、导航主流程或原生边界时，追加 scope、smoke 或相应 E2E。
- 视觉改动同时遵守 [Cindy 设计规范](../design-rules/cindy-design-system.md) 与
  [Mobile 设计规范](../../apps/mobile/docs/mobile-design-guide.md)。
- 记录实际执行和结果；未执行的高相关检查必须说明原因。

## 专项入口

- 模拟器与真机排错：
  [`simulator-debugging.md`](../../apps/mobile/docs/simulator-debugging.md)。

## 原生配置与 runtime fingerprint(冷更边界)

Mobile 用 `runtimeVersion.policy: "fingerprint"`:OTA 热更只在**指纹一致**的装机上生效,
指纹一旦变化就必须**冷更出包**(新商店包 / 自建重装),存量装机拿不到该次热更。

### 硬性规则:除非必要,不得提交会改变指纹的改动

触发冷更的代价由全体存量用户承担——他们拿不到本次及后续热更,直到装上新包。性质上这与
技术框架变动同级,因此:

- 只为实现 JS / UI 需求时,不得顺手改动指纹输入。同样效果能用不动指纹的写法达成时,必须
  选不动指纹的写法。已知踩点与既有规避写法:调试信息走 `EXPO_PUBLIC_*` 进 JS bundle,不写进
  `app.config.js` 的 `extra`;新增开发脚本放仓库根 `package.json`,不放
  `apps/mobile/package.json`(后者的 `scripts` 是指纹输入,见
  [`simulator-debugging.md`](../../apps/mobile/docs/simulator-debugging.md))。
- 确实必须冷更时(升原生依赖、改 config plugin / 原生模块、动 production 段 `app.json` /
  `eas.json`),PR Description 必须写明三件事:为什么冷更不可避免、存量装机影响范围、发版
  节奏建议。
- **审查标准:会触发冷更的 PR 与技术框架变动同级,必须由仓库指定的把关人针对冷更明确
  确认后才能合并。** 不看改动大小,也不看谁提的——提交者是不是维护者、有没有拿到普通
  Approve、有没有被标回 Ready 都不构成例外;把关人自己提的 PR 同样要留下一条显式的冷更
  确认。未确认前不进入自动审查与自动合并路径;判定、hold 与放行走与技术架构变更门同一套
  机制(讨论 issue + 转 draft + 确认后放行),名单与细则属维护者内部 gate。
- 提交前自查:在改动前后各跑一次
  `node apps/mobile/scripts/ci-fingerprint.mjs compute --output <file>` 并比对 hash。PR 上
  出现 fingerprint guard 的 sticky comment 时,以它给出的 base(main) vs 合并结果对比为准。

### 判断哪些改动会动指纹

- 改 `app.json` / `app.config.js` 前先判断是否会动指纹。被哈希的是**解析后的
  ExpoConfig**(app.config.js 的输出),不是源文件本身:凡进入 resolved config 的字段,
  改了值就会变指纹;只有被 app.config.js **覆写 / 剥离、传不到 resolved config** 的值才指纹
  中性(如自建线的 `updates.url` 被占位覆盖)。改动前后可用仓内 `@expo/fingerprint` 比对
  (见 `scripts/ci-fingerprint.mjs`)。
- 除 config 外,这些也是指纹输入:`apps/mobile/package.json` 的依赖与 `scripts`、
  `eas.json` 的 production 段(`beta-*` profile 由 `fingerprint.config.cjs` 剔除)、
  `plugins/`、`modules/` 下的原生模块、`fingerprint.config.cjs` 自身,以及原生依赖版本变化
  (含仅体现在 lockfile 上的传递依赖)。
- **EAS 账号绑定与凭据不入仓**:`owner` / `extra.eas.projectId` / `updates.url` 及 provider
  凭证由**构建期环境变量**注入(`EAS_OWNER` / `EAS_PROJECT_ID`,provider secrets 走 EAS
  environment / 自建区域配置),仓库留空,外部使用者用自己的 Expo 项目(`eas init`)填 env。
  因为哈希的是 resolved config,发布环境注回**相同值**时逐字节不变 → 指纹不变、不冷更;缺省
  (dev / fork)则不带账号绑定、不配 OTA。变量清单见 `apps/mobile/.env.example`。

## 边界

本文只覆盖本地开发、调试和验证。商业发布、版本分发、签名与渠道运维属于维护者内部
流程，不在公开仓库文档或 Agent 手册中维护。
