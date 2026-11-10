# 原生伙伴设计师：整合对照（A1）

核对时间：2026-11-10 08:47 UTC起；以下结论固定到表内提交。这里只做代码、规则与合并模拟审计，不是组合版本的编译或真实运行验收。草稿分支规则不自动成为现行main规则。

## 结论

完整体验保留：需求与设计 → 创建或选中同一原生伙伴 → 落实身份、模型、必要能力与头像 → 原聊天真实工作 → 按反馈调整。现有目标工具、图像处理、原子版本检查和真实采用回执有独立价值，#9314、#9666、#8576均没有完整替代它们。

整合重点是能力配置和任务接入。V2主人主聊天按普通项目加载资源；#9666给仍走伙伴隔离策略的路径增加官方技能继承；两者不能简单叠成同一份可编辑名单。建议保持一套设计方法，按最终宿主实际能力管理资源，不为每种草稿创建一套设计师实现或第二套权限系统。

## 固定基线

| 对照对象 | 提交 | 已核实状态 / 作用 |
| --- | --- | --- |
| main | `9a4deaa2e9c24af6f8a0f8df6cb100184b1e8db0` | 08:39 UTC的主干；现行原生Profile、设置事务、媒体仓、能力选择及运行刷新底座 |
| [#9433](https://github.com/makecindy/cindy/pull/9433) | `014b401e8a48eb685f9082931da2a09ffa5451c1` | Open、非草稿；本贡献46文件，完整目标配置与方法候选 |
| [#9314](https://github.com/makecindy/cindy/pull/9314) | `df0df9e6496eb9dbfc2d32804c260305b9908750` | Draft、未合并；伙伴V2，543文件，与本贡献17文件重合 |
| [#9666](https://github.com/makecindy/cindy/pull/9666) | `993aaa223befd8cad023201df4b8338228452d79` | Open、未合并；官方技能默认继承，33文件，与本贡献4文件重合 |
| [#8576](https://github.com/makecindy/cindy/pull/8576) | `8daf839544c1a896fbea1c8ae310a439a03b1c4a` | Open、未合并；创建/自身头像与资料，20文件，与本贡献10文件重合 |

## 功能整合对照

| 功能 | 现行main与本贡献 | 关联变化 | 处理与验收重点 |
| --- | --- | --- | --- |
| 原生创建、选择与主聊天 | main已有创建、邀请、Profile与canonical；#9433补普通任务可发现/调用的管理名单、创建与目标操作，并处理创建已提交但准备未完成 | V2创建还须准备项目；#8576增加创建时头像和基础资料参数 | **保留入口，复用同一个创建事务**。合并参数与提交守卫，不能恢复成仅伙伴主任务可创建。缺模型时读取和修正原对象，继续同一邀请，不重复创建。[C1] |
| 身份与工作方式 | #9433按expectedVersion局部修改name、description、identitySource；native事务投影到SOUL | V2明确身份仍在Profile/SOUL，工作流程进workspace/AGENTS.md，项目技能进.agents/skills | **保留身份工具，改方法适配**。把身份和项目做事规则分清；后者复用现有项目/文件能力，不把所有工作流塞进identitySource。操作前准确定位目标项目，不按同名猜目录；检查原聊天实际采用。[C2] |
| 模型偏好 | #9433通过真实型号目录解析1—5个有序modelChain；null恢复默认，不改应用默认 | V2保留伙伴主模型候选链，删除的是旧委派的“任务模型”；另外两条PR不替代此功能 | **保留**。继续用原模型选择/排队/发送边界；保存偏好、实际运行模型与fallback分开核对。[C3] |
| Skill选择 | main旧隔离策略需显式外部选择；#9433统一名单与allowlist写入、目标目录和新增引用校验 | #9666官方来源随本机启停，不接受逐伙伴开关；V2主人主聊天直接用普通项目发现，不用旧外部allowlist决定加载 | **必须改写目标能力语义**。查询要区分实际来源、继承状态与可编辑范围；写入只作用于该路径真实消费的设置。不能把保存旧名单当作V2启用/停用成功，也不能用清空个人名单关闭继承的官方Skill。[C4] |
| MCP与工具集 | #9433引用已安装/已连接资源，null继承，数组为显式选择；不接管连接凭证 | V2三引擎不再对projectContext采用旧隔离MCP策略，工具集按普通任务可用集合；群/IM并非同一种上下文 | **复用普通项目能力，重接读写**。保留能力发现和真实采用核对，但不得为V2另造重复伙伴名单；按最终运行上下文处理，不把主人项目资源放开给隔离专线。[C5] |
| 头像与资料 | #9433由当前任务可读受管媒体生成256px PNG，含EXIF/HDR裁剪；版本+旧头像前置条件，资料/媒体引用共同提交 | #8576提供创建/自身入口及emoji、预设、路径、HTTPS输入；两边均使用main的setBotProfileAvatar与媒体存储 | **共享持久化底座，保留入口差异**。合并事务守卫，不重建媒体仓；#8576的路径/HTTPS读取授权不自动替代目标工具的受管媒体归属检查。继续做跨设备验证，不把它当已解决#9684。[C6] |
| 保存与运行回执 | #9433区分savedVersion、next-turn、deferred、unconfirmed；文件同步/运行失败不能被误报成功 | V2保留Profile快照和刷新入口，但项目文件/资源有自己的变更生命周期 | **保留回执，限定证据含义**。Profile版本匹配只证明Profile采用，不能证明AGENTS或项目Skill已加载。使用实际调用/输出验收，不为此新增精确执行账本。[C7] |
| 权限与工具发现 | #9433普通任务/伙伴共用目标入口；账号、Plan、任务代次、主力电脑与媒体归属各自校验 | V2删除伙伴专属来源分档和旧群授权接入，改用通用任务权限；保留账号/共享边界、暂停状态和通用渠道规则 | **重接通用权限，保留必要守卫**。重新核对直接/渐进调用、普通任务及三引擎入口；不带回已退役伙伴专属门，也不因删除旧门而漏掉通用边界。[C8] |

#8576不是当前候选的代码前置依赖；它先合入时复用其已确定接口，它后合入时保留本贡献独立可审阅的差异。V2主聊天与IM/群隔离路径须分开描述，不推导“全部伙伴所有渠道都继承所有能力”。

## 采用时机：能确认到哪一步

- **Profile身份/模型/旧名单**：本贡献提交后返回保存版本；正常后续步骤完成为next-turn，繁忙等待安全边界为deferred，投影/刷新失败为unconfirmed。不得承诺紧接的一条输入一定已采用；实际工具和模型继续用运行证据确认。
- **V2项目规则与项目Skill**：沿普通项目加载，AGENTS模板明确写“下一任务”采用；本轮没有验证原聊天在文件变化后的实际重载时机。Profile版本没有因此成为项目文件版本，A4必须补原聊天的加载证据。
- **#9666官方来源启停**：下一次能力装配根据执行电脑的有效启停与来源核验计算；不把继承项回写成个人选择。运行中变更何时被当前模型看到仍按A4实测，不用Profile保存回执代替。
- **头像**：已知本机事务保存与资源引用不等于远端客户端已经刷新；A5分别验证远端查看和主力电脑转移。

## 本轮识别的具体整合问题

1. **V2里旧能力patch可以保存，但不是实际控制面。** `projectContext`跳过外部Skill解析；`isolatedBotProfile`在该上下文返回undefined，三引擎的旧MCP筛选不再适用；toolset改为可用目录全集。另一方面，旧能力配置接口仍能保存skills/mcpServers/toolsets。这是静态调用链确认的语义不一致，不是已经跑出的组合运行故障。适配先解决读写是否落在真实消费位置。[C4][C5]
2. **官方Skill的自身入口与新增目标入口需要一致。** #9666在自身select中拒绝逐伙伴操作官方Skill，目标批量patch则是#9433新增，仍直接写references。模拟合并能保留官方来源标记的宿主注入，但不会自动补目标写入规则。明确“个人选择清空而官方继续继承”的回执和目录含义；不以joined一项同时表示持久选择和有效继承。[C4]
3. **与#8576存在类型耦合。** 本贡献的`TeammateConfiguration.profile`复用`BotControlState['profile']`；#8576给后者增加必需的`userContextSource`。机械合并会让目标读取契约也要求用户画像，现有目标读取实际不返回它。建议按本工具明确范围投影资料类型，不能为了满足类型就扩大目标读取字段。此处是静态契约冲突，尚未运行组合类型检查，更没有证据表明运行时已经泄露资料。[C9]
4. **头像/创建的提交守卫参数必须合并设计。** #8576把`assertAvatarAccess`函数放到createBotProfile第3参数、setBotProfileAvatar第5参数；#9433在相同位置使用带beforeCommit/onCommitted的guard对象。保留图片读授权复核和已提交回执两者；不得择一删除。继续共用已有事务，不新增另一套落库逻辑。[C6]
5. **本贡献有一处过期文档。** `agent-user-parity.md:265`仍写“主任务尚未准备时配置读取明确拒绝”；当前代码、host-adapters和cindy-bots-runtime已支持读取保存资料及修正模型，状态为not-prepared。A3收尾时统一该句；不把这项文档修正算作新增功能。[C10]

## 合并模拟：已重新验证

只对固定提交执行`git merge-tree --write-tree --name-only`，没有真实merge/rebase、分支改写或冲突解决。

| 本贡献与哪条分支比较 | 文本冲突 | 解读 |
| --- | --- | --- |
| main `9a4deaa2` | 1：docs/product-rules/agent-user-parity.md | 主干提问/代输入说明与本贡献新增章节邻接；现有实现不因这一处文档冲突就要重写 |
| #9666 | 1：同上 | 产品代码可自动合并，但上面的官方Skill语义问题仍须处理；未做组合编译 |
| #8576 | 5 | bots.ts、botCapabilityService.ts、mcp-providers.ts、agent-user-parity.md、create_teammate.ts；集中在创建/头像入口、类型与事务接线 |
| #9314 | 32，其中11个也是本贡献改动文件 | 包含两个分支基线差异，不能把32项都归因于本贡献；核心相交处是Profile/能力/权限/provider和MCP注册 |

共同修改文件数与合并冲突数不同；自动合并成功也不证明运行语义兼容。

## 建议的整合路径与维护者待决项

作者可以直接准备：保留原生对象/模型/媒体/回执底座，调整目标能力读取与实际写入位置、项目规则方法接入、共享事务守卫和上述类型/文档问题。保持一份可追溯候选；未合入V2只在隔离适配中检验，不把它543个文件并入#9433的差异。

需要维护者明确的只有项目级整合事项：

1. **合入顺序和最终基线**：#9433先对现行main交付，还是随V2调整后接收；#8576、#9666共用入口以谁的已合入实现为准。建议优先准备V2适配，但保留现行候选，不以无回复无限暂停可独立工作。
2. **两条在途能力规则的最终适用范围**：建议V2主人主聊天继续与普通项目一致，#9666的官方继承/个人选择规则应用于仍走隔离Profile策略的路径，并明确IM/群规则。需要在合入时形成一致产品说明，而不是作者添加一个新的伙伴专属覆盖开关来消除矛盾。

CI放行与产品/规则确认继续沿#9441既有流程。无需主人替作者管理文件、分支或测试；本轮仅完成A1，没有公开发送A2说明或实施A3。

## 证据入口

- [C1 创建、名册与目标接入](https://github.com/makecindy/cindy/blob/014b401e8a48eb685f9082931da2a09ffa5451c1/apps/desktop/src/main/maker-ipc/botCapabilityService.ts#L333)。
- [C2 V2项目规则模板与原生初始化](https://github.com/makecindy/cindy/blob/df0df9e6496eb9dbfc2d32804c260305b9908750/apps/desktop/src/main/maker-ipc/botProjectMode.ts#L44)；[Profile与项目规则边界](https://github.com/makecindy/cindy/blob/df0df9e6496eb9dbfc2d32804c260305b9908750/docs/product-rules/cindy-bots-runtime.md#L373)。现有list_projects返回真实项目路径，不提供botId映射；设计方法应通过已有主任务/项目信息核实关联，若不足再补最小查询，不按名称推断。
- [C3 目标模型选择与版本写入](https://github.com/makecindy/cindy/blob/014b401e8a48eb685f9082931da2a09ffa5451c1/apps/desktop/src/main/maker-ipc/botCapabilityService.ts#L632)；[V2保留候选链](https://github.com/makecindy/cindy/blob/df0df9e6496eb9dbfc2d32804c260305b9908750/docs/product-rules/cindy-bots-runtime.md#L456)。
- [C4 V2项目上下文与Skill解析](https://github.com/makecindy/cindy/blob/df0df9e6496eb9dbfc2d32804c260305b9908750/apps/desktop/src/main/maker-ipc/botProfileRuntime.ts#L613)；[引擎Skill策略](https://github.com/makecindy/cindy/blob/df0df9e6496eb9dbfc2d32804c260305b9908750/packages/maker-core/src/agents/base-agent.ts#L1775)；[#9666目录及自身选择](https://github.com/makecindy/cindy/blob/993aaa223befd8cad023201df4b8338228452d79/apps/desktop/src/main/maker-ipc/botCapabilityService.ts#L149)。
- [C5 V2工具集](https://github.com/makecindy/cindy/blob/df0df9e6496eb9dbfc2d32804c260305b9908750/apps/desktop/src/main/maker-ipc/botProfileRuntime.ts#L843)；MCP实际消费者：[Claude Code](https://github.com/makecindy/cindy/blob/df0df9e6496eb9dbfc2d32804c260305b9908750/packages/maker-core/src/agents/claude-code/index.ts#L1985)、[Codex](https://github.com/makecindy/cindy/blob/df0df9e6496eb9dbfc2d32804c260305b9908750/packages/maker-core/src/agents/codex/index.ts#L5582)、[Pi](https://github.com/makecindy/cindy/blob/df0df9e6496eb9dbfc2d32804c260305b9908750/packages/maker-core/src/agents/pi/index.ts#L3802)。
- [C6 目标图片读入与处理](https://github.com/makecindy/cindy/blob/014b401e8a48eb685f9082931da2a09ffa5451c1/apps/desktop/src/main/maker-ipc/botAvatarService.ts)；[#8576来源解析](https://github.com/makecindy/cindy/blob/8daf839544c1a896fbea1c8ae310a439a03b1c4a/apps/desktop/src/main/mcp-integrations/teammateAvatarInput.ts)；提交参数对照：[本贡献](https://github.com/makecindy/cindy/blob/014b401e8a48eb685f9082931da2a09ffa5451c1/apps/desktop/src/main/localDb/ipc/bots.ts#L1827)、[#8576](https://github.com/makecindy/cindy/blob/8daf839544c1a896fbea1c8ae310a439a03b1c4a/apps/desktop/src/main/localDb/ipc/bots.ts#L1821)。
- [C7 已保存与采用回执](https://github.com/makecindy/cindy/blob/014b401e8a48eb685f9082931da2a09ffa5451c1/apps/desktop/src/main/maker-ipc/botCapabilityService.ts#L632)；[真实刷新结果](https://github.com/makecindy/cindy/blob/014b401e8a48eb685f9082931da2a09ffa5451c1/apps/desktop/src/main/maker-ipc/botRuntimeEpochRefreshSignal.ts)。
- C8 权限合同：[现行main](https://github.com/makecindy/cindy/blob/9a4deaa2e9c24af6f8a0f8df6cb100184b1e8db0/docs/product-rules/teammate-authority.md)、[V2草稿](https://github.com/makecindy/cindy/blob/df0df9e6496eb9dbfc2d32804c260305b9908750/docs/product-rules/teammate-authority.md)；[V2实际接入](https://github.com/makecindy/cindy/blob/df0df9e6496eb9dbfc2d32804c260305b9908750/apps/desktop/src/main/maker-ipc/taskActionHost.ts#L120)。
- C9 类型投影：[目标配置](https://github.com/makecindy/cindy/blob/014b401e8a48eb685f9082931da2a09ffa5451c1/packages/lizi-mcps/src/xdt-helper/bot_capabilities.ts#L16)、[#8576自身Profile](https://github.com/makecindy/cindy/blob/8daf839544c1a896fbea1c8ae310a439a03b1c4a/packages/lizi-mcps/src/xdt-helper/bot_capabilities.ts#L75)。
- C10 未准备状态：[过期同权文档](https://github.com/makecindy/cindy/blob/014b401e8a48eb685f9082931da2a09ffa5451c1/docs/product-rules/agent-user-parity.md#L265)、[现行候选读取代码](https://github.com/makecindy/cindy/blob/014b401e8a48eb685f9082931da2a09ffa5451c1/apps/desktop/src/main/maker-ipc/botCapabilityService.ts#L580)、[已更新运行合同](https://github.com/makecindy/cindy/blob/014b401e8a48eb685f9082931da2a09ffa5451c1/docs/product-rules/cindy-bots-runtime.md#L1375)。

验证边界：已读上述原始源码/规则，已完成四组只写Git对象的合并模拟；未编译组合分支、未跑组合单测或真实模型验收，未验证跨设备。#9511与#9684仍分别由行动清单A4/A5承载，不因本对照变成已修复。

后续实施不改写本页固定提交的审计结论：2026-11-10 已整合 main `8d4afd2`，落实类型投影与过期文档修正，补充真实 CC/Pi 运行；最新结果和剩余事项见 [验收 README 的本地整合进展](README.md#本地整合进展2026-11-10尚未推送)。V2 / #9666 / #8576 的组合实现仍未验收。
