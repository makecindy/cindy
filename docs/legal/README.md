# 法律与合规资料

`docs/legal/` 是本仓库法务资料的统一入口。人工维护的隐私、条款、SDK 合规、
第三方审计和发布合规文档都应放在这里；第三方许可声明与 SBOM 也统一生成到
[`notices/`](./notices/)。本页登记因生态识别、上游归属或随包分发要求而无法物理
搬迁的文件，避免出现“有文件却找不到入口”的情况。

## 快速导航

### Cindy 自有许可与归属

- [Apache License 2.0](../../LICENSE)：仓库根目录固定文件，供 GitHub、包管理器、
  Podspec 和源码分发识别。
- [项目版权与归属声明](../../NOTICE)：仓库根目录固定文件；其中的第三方材料入口
  指向本目录的 `notices/`。

### 人工维护的合规记录

- [微信 Open SDK 合规记录](./wechat-open-sdk-compliance.md)：版本、隐私披露、用户
  同意和发布前复核记录。
- [个人微信 IM 合规与发布记录](./wechat-personal-im-compliance.md)：iLink 协议来源、
  数据处理、腾讯接入授权与 GA 门禁。

### 第三方许可、受限组件与 SBOM

- [第三方声明与 SBOM 说明](./notices/README.md)：生成命令、覆盖范围、审计门禁和
  分发方式。
- [全工程开源声明](./notices/THIRD-PARTY-NOTICES.txt)：由
  `pnpm licenses:generate` 生成。
- [全工程受限组件审计表](./notices/THIRD-PARTY-RESTRICTED.txt)：由同一命令生成，
  不作为开源包数量统计。
- [各平台声明与审计表](./notices/)：桌面 Windows、macOS、Linux，以及移动端 iOS、
  Android 的平台精确产物。
- [SPDX 2.3 SBOM](./notices/sbom/)：与上述平台产物对应的依赖清单。

## 固定路径登记

以下文件仍是法务资料，但不能简单移动到本目录。它们的权威来源、保留原因和维护
方式如下：

| 文件或目录 | 权威来源 | 为什么保留原位 |
| --- | --- | --- |
| [`LICENSE`](../../LICENSE)、[`NOTICE`](../../NOTICE) | 本仓库根目录 | GitHub、包管理器、Podspec 和源码分发会按约定路径识别。 |
| [`apps/desktop/resources/THIRD-PARTY-NOTICES.txt`](../../apps/desktop/resources/THIRD-PARTY-NOTICES.txt)、[`THIRD-PARTY-RESTRICTED.txt`](../../apps/desktop/resources/THIRD-PARTY-RESTRICTED.txt) | [`notices/`](./notices/) | 随桌面安装包分发的生成副本，禁止手工修改；运行 `pnpm licenses:generate` 更新。 |
| [`apps/android-platform-tools-bin/win32-x64/NOTICE.txt`](../../apps/android-platform-tools-bin/win32-x64/NOTICE.txt) | 上游 Android Platform Tools | 必须与随仓库分发的原生二进制保持相邻。 |
| [`apps/desktop/native/sqlite-vec/LICENSE`](../../apps/desktop/native/sqlite-vec/LICENSE) | 上游 sqlite-vec | vendored 原生组件的上游许可证，随组件源码保留。 |
| [`apps/desktop/src/renderer/vendor/drawio/LICENSE`](../../apps/desktop/src/renderer/vendor/drawio/LICENSE)、[`tapdb/LICENSE`](../../apps/desktop/src/renderer/vendor/tapdb/LICENSE) | 各自上游项目 | vendored 前端资源的上游许可证，随资源分发。 |
| [`packages/browser-control-runtime/src/_generated/vendor/fs-safe/LICENSE`](../../packages/browser-control-runtime/src/_generated/vendor/fs-safe/LICENSE) | 上游 fs-safe | 生成或 vendored 代码旁的上游许可证，不能与代码拆开。 |
| [`cindy-protocol/LICENSE`](../../cindy-protocol/LICENSE)、[`cindy-protocol/NOTICE`](../../cindy-protocol/NOTICE) | `cindy-protocol` submodule | 协议是独立仓库，由协议仓库维护；本仓只锁定 submodule commit，不复制真源。 |

固定路径文件如有变化，应在对应的 `docs/legal/` 说明或生成器中同步登记，而不是
再创建一份容易漂移的手工副本。

## 维护规则

1. 新增人工维护的法务、隐私、条款、SDK 合规或第三方审计文档，默认放在本目录，
   并在本页或下级 README 增加入口。
2. 第三方依赖的许可声明、受限组件清单和 SBOM 只通过
   `pnpm licenses:generate` 生成；不要直接编辑 `notices/` 下的产物。
3. 新增 vendored 源码、原生二进制或字体时，保留上游随附的 `LICENSE`、`NOTICE`、
   `COPYING` 等文件，并把路径登记到上面的固定路径表。
4. [`CONTRIBUTING.md`](../../CONTRIBUTING.md) 与 [`SECURITY.md`](../../SECURITY.md) 是
   GitHub 识别的社区流程入口，不属于法务真源，因此继续保留在仓库根目录；它们
   分别负责贡献流程和漏洞披露，并从这里作为相关入口查找。
5. `cindy-protocol/` 的法律文件不在本仓库重排；需要修改时应在协议仓库单独提交，
   再更新本仓库的 submodule 指针。
