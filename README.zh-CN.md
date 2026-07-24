<p align="center">
  <a href="https://cindy.cn"><img src=".github/assets/hero-zh.webp" width="100%" alt="CINDY —— 想到，就能做到。开源、开箱即用的 AI Agent，在你自己的电脑上替你把真实工作做完。"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License" /></a>
  <a href="https://github.com/makecindy/cindy/actions/workflows/ci.yml"><img src="https://github.com/makecindy/cindy/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-22.x-brightgreen.svg" alt="Node.js 22.x" /></a>
  <a href="https://pnpm.io"><img src="https://img.shields.io/badge/pnpm-10-orange.svg" alt="pnpm" /></a>
</p>

<p align="center">
  🌐 <a href="https://cindy.cn">中国大陆版</a> | <a href="https://cindy.app">国际版</a>
</p>

<p align="center">
  ⬇️ <a href="https://cindy.cn/#download">中国大陆版下载</a> | <a href="https://cindy.app/#download">国际版下载</a>
</p>


Cindy 运行在你自己的电脑上，使用你本地的文件和已登录的应用，底层由
Claude Code 与 Codex 作为 agent 引擎驱动。
她能操作浏览器、电脑和手机，以「多 agent 团队」协同工作，并支持从 IM 和定时任务派活。

本仓库是 Cindy 的开源**客户端** —— 桌面端、手机端及其共享 packages，以 pnpm
monorepo 组织。

客户端本身免费使用，源码以 Apache-2.0 开源。使用官方模型服务时按用量额度计费、
花费透明可见；你也可以配置你自己的 API key。具体的服务说明、价格和下载入口请按
所在区域查看[中国大陆官网](https://cindy.cn/#pricing)或[国际版官网](https://cindy.app/#pricing)。

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
| 远程托管 | Cindy 云端账号 | 使用 Cindy 的完整托管服务；[中国大陆定价](https://cindy.cn/#pricing) · [国际版定价](https://cindy.app/#pricing)。 |
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
# 中国大陆版 Cindy 账号
pnpm restart:desktop:remote --region=cn

# 国际版 Cindy 账号
pnpm restart:desktop:remote --region=global
```

Remote 开发会使用你自己的 Cindy 云端账号和现有登录态，因此可以继续已有的会话与工作。
中国大陆账号必须使用 `cn`，国际版账号必须使用 `global`，不要依赖内部默认值。完整的
桌面端、手机端、数据隔离和验证流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

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

## 许可证 / License

除非另有说明，本仓库的源代码依据 [Apache License 2.0](LICENSE) 授权。
源文件不单独携带许可证头，统一以仓库根目录的 `LICENSE` 为准。

模型权重、数据集、提示词、商标，以及其他单独标识的材料，可能适用各自的许可条款，
不因根目录的 Apache-2.0 而被自动覆盖。第三方开源组件保留各自的版权与许可，其归属
声明与 SPDX SBOM 统一收口在 [`docs/legal/`](docs/legal/)；各分发产物的精确清单
见 [`docs/legal/notices/`](docs/legal/notices/)。本项目的版权与归属信息见
[`NOTICE`](NOTICE)。
