# GitLab MR 关联状态

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

PR/MR 状态结果新增可选 `conflicts: boolean | null`（2026-11-05）：GitHub 复用 REST `mergeable`，GitLab 在既有 GraphQL 查询读取 `conflicts`；`pr-status` / `mr-status` 原样透传。旧主机缺失字段按未知处理，旧客户端忽略；不新增请求、通道或 relay 适配，60 秒缓存与 90 秒刷新不变。

关联与状态结果追加可选 `provider`（github / gitlab）和 `host`；缺省仍为公共 GitHub。
新 Desktop / Mobile 的 GitLab 查询带完整 namespace / repo / number / provider / host，
走同账号 `git-context:mr-status`；GitHub 继续使用原 `git-context:pr-status` 和旧参数形状。
新通道复用原任务关联过滤与只读权限，不授予共享任务访客任意查询权限。
旧 host 不认识新通道时，GitLab 显示不支持/未知，绝不回退为 GitHub 查询。
新 host 可继续处理旧控制端的 GitHub 查询。新控制端正确显示并打开 GitLab MR，
旧控制端对新增 GitLab 关联没有展示保证，使用 GitLab 需要更新控制端。

Desktop 的本机查询、同账号远端查询、任务摘要及 Mobile 共用带 host 的状态身份。
GitLab 的 glab 安装/登录原因仅本机可见，远端结果统一为无状态；凭证不进入协议。
子路径部署的链接会被识别为多级分组，部署前缀进入项目路径，因路径不正确而查不到状态。
Agent 的 GitHub 工具和脚本入口仍不支持 GitLab，不复用其 GitHub token。

共享客户端 allowlist / invokePolicy 与 Mobile 低优先级读取表同步加入新通道。
自建中转透传既有加密 invoke 帧，不解析 channel 的业务参数，因此不改 relay 内核、
帧格式、认证、版本或部署程序。验证入口为 `pnpm --filter @cindy/device-link test`、
`pnpm --filter @cindy/device-link-relay test` 与
`pnpm --filter @cindy/device-link-relay run interop`；结果以本次交付的执行日志为准。

MR 卡片用完整 HTTPS MR 链接标记状态、开放态操作和归档按钮，以实例和完整项目路径区分同号 MR。GitHub 卡片仍使用已有的 `owner/repo#N`。桌面和手机复用任务关联与实时状态判断归档资格；旧宿主保留卡片快照，无法识别新标记。

GitLab 状态优先使用对应实例的 glab 登录态，缺少登录态时读取当前账号已批准、已启用的公开 GitLab 插件的同域连接。REST 提供基础状态，GraphQL 补充同一提交的 CI 和讨论。定时跟进复用 `prTrigger` 与宿主状态观察器，GitLab MR 必须保留重复定时检查（recurring=true、manual=false），即使任务页关闭，宿主仍按配置周期读取状态。普通检查不启动模型，已有待处理事项或匹配的变化才唤醒任务；GitLab 地址不进入 GitHub App 订阅清单。旧宿主可能拒绝 GitLab 触发器，卡片以调度器回执核实跟进状态。
