# 远程新建任务跟随被控电脑的引擎

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:get-new-maker-defaults` 的响应与 `maker:new-maker-draft:changed` 推送的每个引擎槽增量携带可选
`selectedAgentKind`（`claude-code` / `codex` / `pi`），取被控电脑新建任务当前选中的引擎
（`selectedRoute.harness`），与请求的是哪个引擎无关。

Desktop 控制端进入「到这台电脑新建任务」、拿到这台电脑的默认值后，按系统切换（不标记用户自定义）
切到同一引擎，模型与权限再按该引擎槽播种；缓存只供模型配置预览，引擎跟随等本次读取确认，
避免旧缓存提前结束跟随。拿到之前用户自己换过引擎则保持用户的选择。
回到本机草稿时，期间没手动换过引擎就切回原来的引擎；手动换走又换回来也视为手动选择。
自动跟随只改变当前窗口，引擎落盘与偏好镜像保留本机原值，重启不会把远程引擎带回本机。实现见
`apps/desktop/src/renderer/features/cc-agent/remoteDraftEngineFollow.ts`，回归见同目录
`__tests__/remoteDraftEngineFollow.test.ts`。

旧版被控电脑不带此字段：控制端保持当前引擎，即原行为。只增可选响应字段，不新增 channel、
不改请求参数；自建中转透明转发业务 payload，无需同步适配。Mobile 远程新建沿用原有逻辑，未改动。
