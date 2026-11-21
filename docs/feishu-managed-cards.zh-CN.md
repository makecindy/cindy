# 飞书业务卡片与异步回调

关联 #10050。适用于 Desktop 管理的个人飞书/Lark 连接及伙伴自有连接。
这是业务卡片入口，系统提问与权限确认继续使用已有工具。

## 发送与更新

在 cindy_feishu_bot 的 list_tools 中发现 send_card 和 update_card，经 call_tool 调用：

```json
{
  "name": "send_card",
  "args": {
    "requestId": "example-choice-1",
    "card": {
      "schema": "2.0",
      "body": {
        "elements": [
          {
            "tag": "button",
            "text": { "tag": "plain_text", "content": "选择此项" },
            "behaviors": [
              { "type": "callback", "value": { "mode": "example" } }
            ]
          }
        ]
      }
    }
  }
}
```

发送结果包含 messageId、registered 和 expiresAt。相同 lane、requestId 与内容的重试复用回执，
不得为重试更换 requestId。registered=false 表示远端已发送、本地登记未完成，不能当作发送失败重发。
CARD_DELIVERY_UNKNOWN_DO_NOT_RESEND 表示已记录过发送意图但没有完整回执，需核查渠道实际消息。
已登记卡片可以通过 update_card({messageId, card}) 替换内容，包括显示「已选」或更新勾选状态。

群轮次固定发到本群或话题；没有飞书入站轮次时，使用宿主解析出的同一连接向其主人私聊发送。
工具不接受模型填写 chatId、操作者或主人身份，也不放开 call_api 的逐轮作用域限制。

## 点击回流

宿主给 callback behavior 的 value 加内部命名空间。组件原始 value 可以是对象、字符串或缺省。
点击以新 IMMessageEvent 进入正常消息队列，不等待发卡轮次，也不使用 pendingInteractions：

```json
{
  "type": "feishu_card_action",
  "requestId": "example-choice-1",
  "eventId": "<回调 token 的 SHA-256>",
  "messageId": "<原卡消息 ID>",
  "operatorId": "<真实操作者 open_id>",
  "isOwner": false,
  "action": { "tag": "button", "value": { "mode": "example" } }
}
```

action 保留组件的 name、checked（包括 false）、form_value、option 与原始 value。
群和话题恢复到登记的 lane，私聊回到主人的正常渠道任务；伙伴连接由现有路由进入伙伴主任务。
非主人群成员只在原本允许 guests 的连接上进入业务轮次，speaker.isOwner 来自本连接主人校验，
不取自按钮数据。卡片点击和组件数据均不直接批准系统工具执行。

## 存储、容量与失败边界

登记按 Cindy 数据账号及飞书连接隔离，包含 App、主人、lane、请求/消息 ID、内容摘要、期限及回调哈希。
文件在账号 userData 的 feishu-managed-cards 下原子写入，单连接最多 256 张未过期卡，期限 30 天；
每张卡最多保留 1024 个近期回调哈希，后续点击时清理超过 24 小时的记录。
文件不保存卡片正文、表单内容、App Secret 或明文回调 token。解绑与清除主人会作废登记。
旧宿主未提供存储端口时不启用受管卡片，原有系统卡继续工作。

发送回执和登记可跨重启恢复；**业务执行仍使用已有 IM 消息队列，没有新增跨进程的点击执行日志**。
因此回调 ACK、排队和实际业务提交之间发生崩溃时，不承诺业务恰好执行一次。业务侧应使用 eventId
对写入去重。状态由伙伴调用 update_card 更新，宿主不根据任意业务字段自动生成「已完成」。
飞书应用仍需既有的机器人发消息权限与 card.action.trigger 事件配置；本功能不自动修改应用权限或发布版本。

## 验证范围

自动测试覆盖发送登记、重建实例后的 topic 回流、真实操作者边界、组件字段保留、重复回调、
过期/跨群拒绝、发送后登记失败、连接换代、系统卡兼容，以及无入站租约的宿主/MCP 入口。
真实飞书送达、手机/桌面点击、应用重启后的实际回流需在安装修复版本后单独验收。
