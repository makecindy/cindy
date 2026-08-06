# Model provider catalog

本目录保存客户端仓库维护的模型目录发布源。这里的 JSON 是构建输入和运行期兜底快照，**不是面向最终用户的启动配置文件**。

## `providers.json` 的职责

`providers.json` 当前承载：

- xAI / SuperGrok 的静态模型清单。该 OAuth 接入没有可用的列模型接口，因此需要随目录维护；
- 第三方 Provider 的连接预设（`presets`）；
- Catalog 格式版本。

它不承载以下内容：

- Anthropic、OpenAI、XD、Gemini 等内置 Provider 的身份、鉴权和路由契约；这些随代码维护在 `../src/builtin.ts`；
- Anthropic、OpenAI 和 XD 的运行期模型清单；这些由各自的动态发现或服务端接口提供；
- 统一模型元数据与参考价格；这些保存在严格版本化的 `model-registry.json` 中。

## 加载与覆盖关系

发布版启动时优先请求 Model Access 的公共 Catalog API。远端不可用时，客户端会依次尝试上次有效快照、迁移期 OSS 目录，最后回退到随 App 打包的 bundled catalog。具体加载链见 `../src/source.ts`。

远端或本地开发目录不是对 bundled catalog 的无条件整文件替换：客户端会按 Catalog 版本和字段契约合并随包身份卡、Provider、presets，并对 `modelRegistry` 执行版本回退保护。因此，直接修改仓库中的 `providers.json`：

- 适用于维护随包 xAI 静态清单、Provider presets 和对应 OSS 发布源；
- 需要重新构建或发布客户端后，才会改变随包兜底内容；
- 不能被视为安装后稳定生效的用户偏好设置；发布版在线启动时，同一 Provider 或 preset 的远端有效数据可能优先于随包内容。

开发环境需要验证一份完整 Catalog 时，可通过 host 提供的本地目录路径读取；命中本地路径后不会联网。该入口用于目录开发和测试，不改变 `providers.json` 作为仓库发布源的定位。

## 编辑约束

- `providers.json` 必须保持严格 JSON，不能加入注释、`_comment` 或其他 schema 未声明字段；未知字段会在解析阶段被拒绝。
- 修改 xAI 模型清单时，应同时检查 `model-registry.json` 的元数据是否仍然一致。
- 不要把 Provider 身份、鉴权或路由协议从 `builtin.ts` 复制进本文件；两处重复会产生不明确的覆盖关系。
