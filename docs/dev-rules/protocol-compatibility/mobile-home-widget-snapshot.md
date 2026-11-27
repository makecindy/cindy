# iPhone / Android 桌面小组件快照（新增接口，尚未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

新增只读 invoke `device-link:usage-widget:snapshot:v1`（无参数），列入 Desktop
`REMOTE_INVOKE_ALLOWLIST` 与 Mobile `MOBILE_REMOTE_INVOKE_CHANNELS`，由被控端 dispatch 在三道门之后拦截。
返回 `{ ok: true, snapshot }` 或 `{ ok: false, reason: 'unavailable' }`；快照是 Desktop 余量与用量汇总
（`apps/desktop/src/main/quota-overview/`，macOS 菜单栏面板也用它）最近一次构建的投影
（`MobileUsageWidgetSnapshot`：有液面的来源、按面板设置范围的近 30 天每日用量、面板文案），已按「隐藏个人信息」
打码，不含凭证。任何平台、面板开关与否都能答：请求会让汇总运行 30 分钟，首次最多等 10 秒构建；
未登录或暂时汇总不出时为 unavailable，不进入「旧被控端」判断。
旧被控端回 `CHANNEL_NOT_ALLOWED`：手机只在所有可达电脑都如此时让「自动」组件提示更新电脑，其他失败保留上次快照。
其他电脑离线或单个账号读取失败时，该账号保留最后读数最多 3 天，单元格带可选 `stale` 且 `when` 写成「x 小时前」。
单元格的可选 `resetsAtMs`、`stale` 只进 Desktop 内部视图模型与快照，菜单栏 helper 忽略未知字段。无服务端、relay
或数据库变更；手机侧组件扩展需要原生新包，见 [Mobile 冷更边界](../mobile-development.md#原生配置与-runtime-fingerprint冷更边界)。
