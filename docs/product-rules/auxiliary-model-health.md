# 辅助模型不可用时的提示

辅助模型负责任务自动命名、置顶任务摘要、Help、输入框推荐指令、IM 标题、定时任务脚本、
插件自己的任务（如 Cindy Chrome 的字幕翻译）等轻量工作，设置见「个性化 → 辅助模型」。
候选链全部用不了时，这些功能会悄悄失效或变慢，用户无从得知原因。2026-11-23 用户决定：
这种情况要提示用户。

## 起因

2026-11-18 起本机停用了 Cindy AI 供应商，自动推荐链的三个候选（都在 Cindy AI 上）全部失效。
标题与摘要只记了日志；字幕翻译退回新建任务默认模型并沿用它的推理强度（xhigh），每段从
3–6 秒变成 9–18 秒，用户只觉得「翻译很慢」，过了几天才查到原因。

## 什么时候提示

- **配置问题，发现即提示**：一次辅助请求找不到任何可用候选（供应商或模型已停用、需要登录
  Cindy、套餐或余额不支持、缺少登录信息或密钥、模型已不可用）。原因按候选逐个列出，与设置里
  模型选择器标「当前不可用」用同一套判断（`textOneshotPinOptions` 与 Cindy AI 付费门）。
- **运行时故障，连续失败才提示**：候选可用但请求都失败（超时、出错），连续 3 次才提示，偶尔一次
  网络抖动不打扰用户。
- 只有真实请求证明链跑不动才进入不可用状态。界面读取状态时只刷新原因或在问题修好后清除，
  不会凭读取本身报出新问题：启动时模型目录可能还没加载完，凭读取判断会误报。
- 任何一次辅助请求成功即恢复正常；切换账号时状态清零。被取消、被新请求取代、或请求中途
  设置/账号变化的请求不计入。
- 状态只在本次运行的内存里，不落盘。

## 怎么提示

- **设置页常驻**：「辅助模型」区显示提示卡片，说明受影响的功能、每个候选不可用的原因，以及
  插件任务临时改用的模型；操作为「打开模型供应商」（配置问题时）与「自定义辅助模型」（尚未
  自定义时）。问题消失后卡片随之消失。
- **弹一次**：问题第一次出现时在主窗口弹一次警告提示，带「去设置」按钮直达该设置区。同一个
  问题、同样的原因不再重复弹；原因变化或恢复后再次出问题才会再弹。
- 手机、IM 渠道与 Node Host 暂不提示；Host 的共用请求主体留了可选上报端口，没有接。

## 插件任务的退回

插件自己的任务（没有发起会话、插件也没有指定模型）先按辅助模型链、用最轻的推理强度选路；
全部用不了时退回新建任务默认模型，但改用该模型接受的最低一档轻量强度（`low`，其次
`medium`），都不接受才用其默认强度。不用 `minimal`：未声明档位的自定义模型会把显式档位原样
交给引擎，`minimal` 可能在运行时才报错。退回所用的模型写进上面的提示里。实现见
`apps/desktop/src/main/maker-ipc/pluginTaskDefaultRoute.ts`（`resolveLightestPluginTaskFallback`）。

## 实现入口

- 状态与判断：`apps/desktop/src/main/utility-model/auxiliaryModelHealth.ts`、
  `auxiliaryChainAvailability.ts`、`auxiliaryModelHealthService.ts`（IPC
  `maker:auxiliary-model-health:get`，变化经现有 app-settings 推送的
  `auxiliary-model-health` 分区通知）。
- 请求结果上报：`oneShotCandidatesCore.ts` 的 `reportAuxiliaryChainOutcome` 端口。
- 界面：`renderer/hooks/useAuxiliaryModelHealth.ts`（含一次性提示，挂在 `MainLayout`）、
  `renderer/components/settings/AuxiliaryModelHealthNotice.tsx`。
