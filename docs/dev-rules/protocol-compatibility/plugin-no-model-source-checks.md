# 无模型来源检查与自动化预填（2026-11-26，未发布）

插件新增可选 `agent.checks` / `agent.checkSources`，由独立批准事实
`checksCapabilityApproved` 控制；旧记录缺字段仍保持原功能，不自动获权。
沙箱新增 `cindy.checks.list/probe`，只交换 changed / unchanged / unknown，宿主按
发送者实例、owner 代次及安装批准 revision 校验；来源自己的网络授权不扩大。
内置本机 Cindy 历史也只返回有无新对话，不暴露正文或会话身份。具体边界见随包作者手册
`plugin-control-points.md`。新插件在旧宿主无 API 时回到原来的有预算增量整理。
已批准的 root Gmail / Google Calendar 通过宿主固定的 accounts/run 只读适配复用现有工具，
无需修改来源插件；只读一条索引或日程，不取正文，分页、账号变化或预算不足返回 unknown。
不支持检查的飞书等来源继续增量读取；不把「无法确认」当成「没有新内容」。

`schedule-request` 可追加 `preRunCheck:true`，只有本插件已批准的调度控制节点才可预填。
Desktop 推送与 Mobile `PluginNativeIntent` 的 schedule 分支新增可选
`preRunPlugin:{pluginId,onFailure:'allow'}`；手机可关闭检查后保存。仍走原生创建入口及
已有 `maker:schedule:create`，不新增 channel、allowlist、relay 帧、服务端或协议版本。
旧手机忽略新增字段，仍创建原行为的自动化；新手机接到旧宿主无字段时也保持原行为。
检查在自动化所属电脑运行，模型执行位置仍按原选择；旧任务的暂停、模型、执行位置不改。
未绑定旧任务不会靠名字自动迁移，用户在原任务的前置检查中选择插件后才启用。
