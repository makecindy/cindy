# PR #5043：真实端点刷新验收

验收日期：2026-10-10。对应 [Issue #5024 更新](https://github.com/makecindy/cindy/issues/5024#issuecomment-5811665454)。

## 构建与范围

- macOS arm64 隔离开发版，构建提交 `dcf401d2500fd01a9f315abffeb9368a964d65b0`。
- 已合入 main `5feeb591811b9ff779cbf62d30e7096ac7f18ec1`，无冲突。
- 启动器与 `desktop:whoami` 确认 `DESKTOP_DEV_VERDICT=ready`，沙箱 `pr5043`，Global，passive。
- Codex pin 为 `0.159.2`，未修改版本 pin。验收使用原问题的 Sub2API 端点和两条原有模型连接的凭证，在独立沙箱建立验收连接；生产配置未改动。
- 连接通过应用配置 API 建立，刷新通过真实设置页的“刷新模型列表”按钮执行；模型详情与滑杆通过真实 Renderer 检查，未伪造发现响应或替换 IPC。

## 结果

| 模型 | 上游声明及刷新后的发现档位 | 发现默认档 | 滑杆实际顺序 |
| --- | --- | --- | --- |
| Grok 4.6 / 4.7 | low, medium, high, xhigh | high | 低 → 中 → 高 → 超高 |
| GPT-6 Sol / Luna | low, medium, high, xhigh, max | medium | 低 → 中 → 高 → 超高 → 最高 |

1. 初始模型配置只填 ID/name，无显式档位，也无 `discoveredMetadata`。当前主分支的目录继承已能为这些已知型号提供有效档位，因此验收判据是刷新后新增的发现资料，不把初始界面描述成完全无档位。
2. 两条连接均以 Codex 原生 Responses、无显式 modelsUrl 刷新。四个目标模型的声明写入 `discoveredMetadata` / `userModelConfig.discoveredMetadata`，最终能力与上表一致。Sol/Luna 普通 `/v1/models` 仅返回名称；`?client_version=0.159.2` 才包含五档声明。
3. 另将 Grok 验收连接设置为显式普通 `/v1/models`，清除其旧发现资料，按应用路由变更规则重新提交同一连接的密钥，再点刷新。camelCase `reasoningEfforts` / `reasoningEffort` 同样生成四档和 high 默认值，验证通用解析路径。
4. 对每个目标模型，进入任务输入框模型列表的“自定义”详情，用 Home 和 ArrowRight 逐档移动滑杆，逐步核对档位标签与滑杆范围；列表同步显示选中的档位。保持配置中的 Codex 引擎可选；没有发起任务或真实推理。
5. 为 Luna 设置显式 `efforts: [high]` / `defaultEffort: high`，再次执行真实刷新。发现层仍保留五档，生效能力仍为用户指定的单档；列表显示“高”，详情不显示可调滑杆。这个单档例子是用户覆盖验收，不冒充上游仅默认档响应。仅默认档响应另由单测覆盖。

原始响应只保留目标模型的档位字段；应用数据只保留相关模型能力。脱敏数据见 [results.json](results.json)。截图已遮盖端点或无关账号信息。滑杆截图中的最高档是验收时主动选择的值，不代表上游默认档。

## 界面证据

- [Sol 列表与详情滑杆](sol-slider.png)、[Luna 列表与详情滑杆](gpt-6-luna-slider.png)
- [Grok 4.6 列表与详情滑杆](grok-4.6-slider.png)、[Grok 4.7 列表与详情滑杆](grok-4.7-slider.png)
- [Sol 设置页五档](sol-settings.png)、[Grok 普通目录刷新后的设置页四档](grok-settings.png)
- [Luna 单档覆盖刷新后：列表显示高、详情无滑杆](luna-single-override.png)

## 自动验证

- `@cindy/model-providers` 全包：52 个文件，1,245 项通过。
- Desktop 发现、OAuth、分页、配置 IPC 和刷新界面：5 个文件，347 项通过。
- Desktop 配置合并、档位消费、继承、模型选择：4 个文件，46 项通过。
- `@cindy/model-providers` 的 `tsc --noEmit`、Desktop 全包 `tsc --noEmit -p tsconfig.json` 通过。Desktop 默认 8 GB 堆上限不足，本次以 16 GB 重跑通过，未改仓库脚本。
- Desktop 首轮 SQLite ABI 不匹配；重建本地依赖后重跑通过。
- 开发文档合同 10 项通过；DCO 与 PR 相对 main 的空白检查通过。

## 未验证

本次是隔离开发构建的真实刷新与界面验收，不是正式安装包或发布验收。未执行逐档推理、Windows/Linux、Mobile 实机、Dark 模式；未声称 CI 通过或维护者已批准。自定义模型手动能力声明入口属于 #4931，仍不在本 PR 范围。
