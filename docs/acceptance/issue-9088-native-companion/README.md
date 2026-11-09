# #9088 伙伴设计方法与验收材料

本目录提供两项独立 Cindy Skill 的源码、可导入包及资源校验清单，供复现 [#9088](https://github.com/makecindy/cindy/issues/9088) 的完整使用过程。方法不自动安装，也不会修改任何已有伙伴。

| 方法 | 源码 | 导入包 |
| --- | --- | --- |
| 伙伴设计与调整 | [companion-designer](skills/companion-designer/SKILL.md) | [companion-designer-candidate.zip](companion-designer-candidate.zip) |
| 名字与形象 | [companion-fy](skills/companion-fy/SKILL.md) | [companion-fy-candidate.zip](companion-fy-candidate.zip) |

下载 ZIP 时使用 GitHub 的 Download raw file，在 Cindy 的「技能」页本地导入。方法之间不要求新插件；包内相对资源跟随 Skill 目录。

## 复现完整流程

1. 在包含本候选的 Cindy 中，通过 `cindy_helper.list_tools` 核对本机名册与创建入口 `list_teammates`、`create_teammate`，以及三个目标入口：`inspect_teammate_configuration`、`update_teammate_configuration`、`set_target_teammate_avatar`。方法包本身不会添加这些宿主工具。
2. 导入 companion-designer；普通任务可以直接使用，伙伴采用能力白名单时按其原有能力入口加入，并在下一轮核对实际可用。
3. 用 `list_teammates` 选择或原生创建一位研究伙伴，读取完整身份和当前版本。主任务尚未准备时可修正同一伙伴的模型，能力目录须待运行准备；不要重复创建。要求它“表达更自然，保留研究职责”，只修改 `identitySource`，保存后读回并确认其它字段保持。
4. 需要名字或头像时使用 companion-fy。其原始参考图、固定提示词和装配脚本都在源码目录；生成后用当前任务的受管图片绑定，提交刚读取的版本和旧头像。
5. 在目标原有聊天开展一项真实工作，用实际结果判断，再调整必要字段。区分保存版本、最新运行快照与特定输出的采用证据；回执为 `deferred` 时等待安全运行边界；`unconfirmed` 时先读取并查同步状态，不自动重放。

## 当前候选的完整体验验收

验收以“用户能与原生伙伴合作，并在反馈后继续完善同一伙伴”为单位。本轮在 macOS Global 隔离开发实例中使用真实 Codex / `gpt-6.1-sol`，没有 mock 模型或替代目标工具。普通任务和目标聊天均沿原生 renderer 发送入口执行。

| 场景 | 本轮结果与证据 |
| --- | --- |
| 自然需求到创建 | 原生文件选择器导入 companion-designer；模型实际读取方法与适配说明，经 helper 发现、名册和创建工具得到原生伙伴；新伙伴自行开场 |
| 第一件工作 | 伙伴在自己的聊天读取发布说明与证据，指出全面验收、立即生效和可直接合并等越界声明，交付替换文字 |
| 反馈完善 | 根据实际答复过长的反馈，设计任务先读完整身份，再局部调整表达并选择目标目录里已有的写作 Skill；保存版本从 5 到 6，名称、简介、模型和其它能力保持，原职责与约束保留 |
| Skill 装载与继续工作 | 运行快照为 applied / v6，resolved skills 包含所选方法；随后同一聊天实际读取其 SKILL.md，交付 145 字的简洁答复。工具调用、方法读取和真实输出分别核对 |
| 选定头像 | 附件进入当前任务受管媒体，真实模型调用目标头像工具；原生读回为 256×256 PNG、哈希匹配，本机原聊天侧栏已显示。使用包内已有参考图，不包含新图生成或审美验收 |

运行中的排队和失败另通过确定性的生产转换回归核对：真实模型 applier 产生的 `ScheduledModelSelectionBusyError` 保留为 deferred，空闲后采用已保存选择；仅有后台任务时允许继续当前运行，任务结束后再采用新配置。旧 inherit 伙伴显式选 Skill 后进入 allowlist，实际 hydrate 装载；后续无关 patch 保留选择，清空后移除。无 canonical 的邀请对象可读取并修正模型，沿同一对象继续原生准备。这些边界回归没有冒充实机上的并发或故障注入验收。

`runtime.matchesSavedVersion` 只表示最近运行快照与保存版本一致，不提供每条历史输出的精确配置账本。继续延后的扩展及触发条件见 [伙伴运行时的 #9088 范围](../../product-rules/cindy-bots-runtime.md#原生伙伴设计与调整9088)。

## 本次验证的边界

Core 基线为 `5c81ec6d7ee47d07677ac1ff762915e8421e3d13`。源码及 ZIP 与 [package-verification.json](package-verification.json) 的哈希逐项一致。

两包经过生产打包、检查和临时目录导入，逐文件比对并从导入目录执行头像装配脚本；该包级测试隔离了账号注册和全局链接。上面的真实运行另验证了 companion-designer 的原生导入、模型读取及目标工具调用，没有替换这些生产入口。

本轮相关回归为 Profile 684、刷新协调器 21、signal 6、模型 reconciler 58、MCP 能力契约 12，共 781 项；另有包验证 1 项、文档合同 10 项，Desktop/MCP 类型和测试卫生检查通过。此前 HDR、EXIF、媒体持久引用、授权及三引擎 MCP 发现的回归结果保留，本轮未重复执行未变更的图像路径。定向 lint 仍报告旧代码问题，不将整次 lint 写成通过。

尚未完成跨设备头像刷新、其它引擎的真实方法使用、Windows/Linux 实机及新图生成体验验收。本轮使用本机隔离数据与已有模型连接，未连接第二台客户端；其它环境尚未建立。扩展这些验证时需记录两端版本与实际运行证据。完整 CI 与维护者确认仍由项目方处理。本轮不以本地通过代替维护者批准或用户对伙伴设计的主观接受。

## 素材与维护

来源、历史验证与限制见 [sources.md](skills/companion-fy/references/sources.md)；官方参考图、裁剪示例、[LICENSE](skills/companion-fy/LICENSE) 和 [NOTICE](skills/companion-fy/NOTICE) 随包保留。包中不含私人伙伴身份、真实对话、账号或设备资料。

这里保留本次贡献的可复现方法快照；需求问法、写作、美术与反馈诊断继续由 Skill 演进。后续改方法时，应从相同源码重新生成 ZIP 并更新校验清单，不手工修改生成包。
