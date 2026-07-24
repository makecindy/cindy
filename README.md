<p align="center">
  <img src="apps/mobile/assets/splash/cindy-splash-illustration.webp" alt="Cindy" width="200" />
</p>

<p align="center">
  <strong>想到，就能做到。</strong><br />
  你的全能 AI 助理 —— 她能操作你的电脑，代替你完成真实工作，而不只是给答案。
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License" /></a>
  <a href="https://github.com/makecindy/cindy/actions/workflows/ci.yml"><img src="https://github.com/makecindy/cindy/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-22.x-brightgreen.svg" alt="Node.js 22.x" /></a>
  <a href="https://pnpm.io"><img src="https://img.shields.io/badge/pnpm-10-orange.svg" alt="pnpm" /></a>
</p>

<p align="center">
  🌐 <a href="https://cindy.cn">国内版</a> | <a href="https://cindy.app">海外版</a>
</p>

<p align="center">
  ⬇️ <a href="https://cindy.cn/#download">国内版下载</a> | <a href="https://cindy.app/#download">海外版下载</a>
</p>


Cindy 运行在你自己的电脑上，使用你本地的文件和已登录的应用，底层由
Claude Code 与 Codex 作为 agent 引擎驱动。
她能操作浏览器、电脑和手机，以「多 agent 团队」协同工作，并支持从 IM 和定时任务派活。

本仓库是 Cindy 的开源**客户端** —— 桌面端、手机端及其共享 packages，以 pnpm
monorepo 组织。

客户端本身免费使用，源码以 Apache-2.0 开源。只有使用 Cindy 提供的 Token / API
时才需要按官网规则付费；你也可以配置自己的 API Key。具体的服务说明、价格和下载
入口请按所在区域查看[国内官网](https://cindy.cn/#pricing)或[海外官网](https://cindy.app/#pricing)。

## 本仓包含什么

| 路径 | 说明 |
| --- | --- |
| `apps/desktop` | Electron 桌面客户端 |
| `apps/mobile` | Expo / React Native 手机客户端 |
| `packages/*` | 客户端共享能力（鉴权、device-link、agent 编排、模型供应商等） |
| `apps/*-bin` | 桌面端附带的工具二进制；仓库内只含 android-platform-tools（Git LFS），claude-code / codex / ripgrep 由 `pnpm install` 按平台自动下载、不入库 |
| `cindy-protocol/` | 与服务端共用的协议（git submodule） |

**服务端不在本仓库：** 服务端位于独立仓库，不属于本 monorepo。

| 使用方式 | 账号要求 | 可用范围 |
| --- | --- | --- |
| 远程托管 | Cindy 云端账号 | 使用 Cindy 的完整托管服务；[国内定价](https://cindy.cn/#pricing) · [海外定价](https://cindy.app/#pricing)。 |
| 本地模式 | 无需登录 Cindy 账号 | 在登录页选择「本地模式」即可使用本机 agent 功能。依赖服务端的能力在该模式下不可用。 |

## 前置要求

- **Node.js** 22.x
- **pnpm** 10.x（暂不支持 v11）
- **Git LFS**

## 开始开发

开发者安装、公开 submodule 初始化、Git LFS、依赖更新和权限说明统一见
[`CONTRIBUTING.md`](CONTRIBUTING.md)。公开贡献者只需初始化公开的协议 submodule；
插件通过 SkillHub 或手动安装，不要使用未列出的递归初始化命令。

最短入口：

```bash
git clone https://github.com/makecindy/cindy.git
cd cindy
git submodule update --init --recursive cindy-protocol
git lfs pull
pnpm install
```

## 开发入口

```bash
# 中国版 Cindy 账号
pnpm restart:desktop:remote --region=cn

# 海外版 Cindy 账号
pnpm restart:desktop:remote --region=global
```

Remote 开发会使用你自己的 Cindy 云端账号和现有登录态，因此可以继续已有的会话与工作。
中国账号必须使用 `cn`，海外账号必须使用 `global`，不要依赖内部默认值。完整的桌面端、
手机端、数据隔离和验证流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

登录页的「本地模式」不是连接本地服务端，而是无需登录 Cindy 账号即可使用本机
agent 的模式。依赖服务端的能力在该模式下不可用。

**关于默认服务器：** 客户端默认连接 Cindy 官方云服务（端点清单见
[`config/endpoint.json`](config/endpoint.json) 与
[`config/endpoint.global.json`](config/endpoint.global.json)，桌面端自动更新
同样来自官方 CDN）。这是有意的设计——外部开发者不需要自建服务端，用 dev
构建登录自己的 Cindy 账号即可直接对着官方服务器开发和测试。

## 架构

- [`DESIGN.md`](DESIGN.md) —— 视觉设计系统、颜色 token 与 UI 规范
- [`docs/README.md`](docs/README.md) —— 完整文档与规则索引
- [`CONTRIBUTING.md`](CONTRIBUTING.md) —— 面向社区贡献者的环境、验证与提交流程
- [`AGENTS.md`](AGENTS.md) —— 工程规范、启动 / 运行时契约、模块边界
- [`docs/dev-rules/`](docs/dev-rules/) —— 架构深度文档（如 Orca 多 agent 协同）

## 贡献

改动通过 pull request 合入 `main`。请先阅读
[`CONTRIBUTING.md`](CONTRIBUTING.md)，再按
[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) 提交。
同时请遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)；普通使用问题见
[`SUPPORT.md`](SUPPORT.md)，安全问题仍按 [`SECURITY.md`](SECURITY.md) 私下报告。

## 安全

任何凭证 / 授权文件都不得提交进工作区。发现安全问题请按照
[`SECURITY.md`](SECURITY.md) 的说明私下报告，不要开公开 issue。

## 隐私与遥测

**官方分发的安装包**包含 [TapDB](https://www.taptap.cn/tapdb) 使用统计，用于
产品层面的匿名量级分析（设备 / 系统 / 应用版本等元数据；登录后关联账号 ID）。
它**不采集**聊天内容、文件内容或工作目录数据。此外，登录云端账号时客户端会向
Cindy 服务发送在线心跳（仅账号 ID、平台与版本号）。崩溃转储只保留在本地，
不会自动上传。

**从源码自行构建**时不必保留统计：

- 移动端默认即关闭 —— 未在构建时注入 TapDB 凭据（`clientId` / `clientToken`）
  时，`apps/mobile/src/analytics/mobileTapdb.ts` 自动空转；
- 桌面端可移除 `apps/desktop/src/renderer/index.tsx` 中的 `initTapdb()` 调用
  （实现见 `apps/desktop/src/renderer/analytics/`），即可完全剥离。

## 内容合规审查（仅中国区发布版）

为满足中国大陆对面向公众提供生成式 AI 服务的内容安全合规要求，客户端内置了
内容审查接口（实现见
[`apps/desktop/src/main/content-moderation/`](apps/desktop/src/main/content-moderation/)）。
在此如实向用户与开发者披露它的行为和边界。

**什么情况下不启用（如何不启用）：**

- **海外（global）发布版**：永不启用；
- **dev / 源码运行：默认不启用** —— 只有显式传入 `--content-moderation`
  启动参数（或未打包运行时设置环境变量 `XDT_CONTENT_MODERATION=1`），且端点
  配置了 `moderationSignTestApiBaseUrl`，才会进入测试环境审查；两者仓库内默认
  都没有，所以不做任何设置即为关闭；
- **本地模式（未登录）或组织账号登录**：不启用；
- **自行从源码构建**：注意——按 cn 区**打包**的产物启动时同样会拉取官方 cn
  端点清单，用个人账号登录后审查**会启用**，这一点与官方发布版一致。想保持
  关闭，请以 dev（未打包）方式运行、按 global 区打包，或在构建时把
  `cdnBaseUrl` 指向你自己的端点清单且不下发 `moderationSignApiBaseUrl`。

**什么情况下会启用（必须同时满足，判定入口
[`eligibility.ts`](apps/desktop/src/main/content-moderation/eligibility.ts)）：**

1. 官方**打包发布**的**中国区（cn）构建** —— 区域在构建期由
   `VITE_CINDY_AUTH_REGION` 烘焙，运行期不可切换；
2. 以**个人云端账号**登录（组织账号不经由该接口）；
3. 启动时从区域 CDN 拉取的端点清单中 `moderationSignApiBaseUrl` 非空 ——
   打包构建的端点清单一律在运行时从官方 CDN 下发（解析逻辑见
   `apps/desktop/src/main/clientEndpointsService.ts`），官方中国区清单会下发该
   地址；仓库内 [`config/endpoint.json`](config/endpoint.json) 仅供 dev（未打包）
   运行使用，该字段为空。

**启用时审查什么：** 你发送给助手的消息（文本与图片附件）、助手的流式回复、
自定义提示词、昵称与头像。这些内容会经 Cindy 的审查签名服务提交给内容安全服务
判定放行或拦截：输入被拦截时消息不会发出并退回输入框；回复被拦截时本轮输出中止，
已展示的内容保留，并追加一条固定提示语。定时任务与多 agent 协同的内部消息不送审；
审查服务不可用或超时按放行处理（fail-open），不会阻断正常使用。

## 许可证 / License

除非另有说明，本仓库的源代码依据 [Apache License 2.0](LICENSE) 授权。
源文件不单独携带许可证头，统一以仓库根目录的 `LICENSE` 为准。

模型权重、数据集、提示词、商标，以及其他单独标识的材料，可能适用各自的许可条款，
不因根目录的 Apache-2.0 而被自动覆盖。第三方开源组件保留各自的版权与许可，其归属
声明与 SPDX SBOM 统一收口在 [`docs/legal/`](docs/legal/)；各分发产物的精确清单
见 [`docs/legal/notices/`](docs/legal/notices/)。本项目的版权与归属信息见
[`NOTICE`](NOTICE)。
