# #9088 伙伴设计方法与验收材料

本目录提供两项独立 Cindy Skill 的源码、可导入包及资源校验清单，供复现 [#9088](https://github.com/makecindy/cindy/issues/9088) 的完整使用过程。方法不自动安装，也不会修改任何已有伙伴。

| 方法 | 源码 | 导入包 |
| --- | --- | --- |
| 伙伴设计与调整 | [companion-designer](skills/companion-designer/SKILL.md) | [companion-designer-candidate.zip](companion-designer-candidate.zip) |
| 名字与形象 | [companion-fy](skills/companion-fy/SKILL.md) | [companion-fy-candidate.zip](companion-fy-candidate.zip) |

下载 ZIP 时使用 GitHub 的 Download raw file，在 Cindy 的「技能」页本地导入。方法之间不要求新插件；包内相对资源跟随 Skill 目录。

## 复现完整流程

1. 在包含本候选的 Cindy 中，通过 `cindy_helper.list_tools` 核对三个目标入口：`inspect_teammate_configuration`、`update_teammate_configuration`、`set_target_teammate_avatar`。方法包本身不会添加这些宿主工具。
2. 导入 companion-designer；普通任务可以直接使用，伙伴采用能力白名单时按其原有能力入口加入，并在下一轮核对实际可用。
3. 选择或原生创建一位研究伙伴，读取完整身份和当前版本。要求它“表达更自然，保留研究职责”，只修改 `identitySource`，保存后读回并确认其它字段保持。
4. 需要名字或头像时使用 companion-fy。其原始参考图、固定提示词和装配脚本都在源码目录；生成后用当前任务的受管图片绑定，提交刚读取的版本和旧头像。
5. 在目标原有聊天开展一项真实工作，用实际结果判断，再调整必要字段。区分保存版本、最新运行快照与特定输出的采用证据；回执为 `unconfirmed` 时先读取并查同步状态，不自动重放。

## 本次验证的边界

Core 基线为 `5c81ec6d7ee47d07677ac1ff762915e8421e3d13`。源码及 ZIP 与 [package-verification.json](package-verification.json) 的哈希逐项一致。

两个包经过生产打包、检查和本地导入服务，在隔离临时目录逐文件比对；从导入目录执行头像装配脚本，确认提示词和原始参考图哈希。账号注册与全局链接投影用测试替身隔离。这证明包结构与资源可用，尚未证明在每个引擎中实际召回，也不是本候选的真实模型端到端或跨端头像刷新验收。

原生 Profile 事务、头像媒体绑定、任务授权及运行配置采用另有生产入口回归。完整候选的实机步骤见上，未运行的范围不以历史原型成果替代。

## 素材与维护

来源、历史验证与限制见 [sources.md](skills/companion-fy/references/sources.md)；官方参考图、裁剪示例、[LICENSE](skills/companion-fy/LICENSE) 和 [NOTICE](skills/companion-fy/NOTICE) 随包保留。包中不含私人伙伴身份、真实对话、账号或设备资料。

这里保留本次贡献的可复现方法快照；需求问法、写作、美术与反馈诊断继续由 Skill 演进。后续改方法时，应从相同源码重新生成 ZIP 并更新校验清单，不手工修改生成包。
