# 伙伴对话执行过程收拢

以下截图来自 macOS 上的隔离 Chromium 组件渲染，不是完整 Electron 客户端实机截图。使用同一组模拟消息、真实 WorkGroupBlock / AgentActionRow / BotAvatar 组件及产品 Light / Dark 主题；顶部、输入框和正文容器是预览夹具。修改前使用原有伙伴过滤逻辑，修改后使用新的呈现投影。预览脚手架不进入产品。

| 场景 | Light | Dark |
| --- | --- | --- |
| 修改前：执行期间的六段公开说明分别占一行头像 | [截图](evidence/teammate-before-light.png) | [截图](evidence/teammate-before-dark.png) |
| 修改后：执行期间默认收拢 | [截图](evidence/teammate-after-light.png) | [截图](evidence/teammate-after-dark.png) |
| 修改后：完成结果保留在主区 | [截图](evidence/teammate-completed-light.png) | [截图](evidence/teammate-completed-dark.png) |
| 修改后：主动展开仍可查看公开说明和工具 | [截图](evidence/teammate-expanded-light.png) | [截图](evidence/teammate-expanded-dark.png) |
| 整合动态状态：过程收拢，输入框上方保留唯一动作反馈 | [截图](evidence/teammate-integrated-light.png) | [截图](evidence/teammate-integrated-dark.png) |

同一执行序列的主区头像行从 6 行变为 0 行和 1 个过程入口；包含末段尚未跟随工具的说明，运行时也默认收拢。完成后显示 1 行结果和 1 个过程入口。两种主题均已目检，浏览器无 JavaScript 错误。

整合截图额外使用真实 BotWorkingStatus / WorkingStatusText 组件，验证与主干动态状态功能共用一个出口；未调用文案润色模型，采用组件即时状态。外层布局仍为隔离预览夹具。

自动化测试使用三种引擎的归一化事件夹具，经过真实 renderer reducer、消息构建及工作分组，逐帧验证文字→工具→再次说明→最终答复；另覆盖完成标记、无 final 的末段正文回退、历史懒加载与重试、授权/提问/错误卡、附件及媒体交付。尚未验证完整客户端中 Pi / Claude / Codex 的实时端到端流程。
