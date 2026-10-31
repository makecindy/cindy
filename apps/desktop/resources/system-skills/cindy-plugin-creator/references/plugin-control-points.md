## 4.6.2 控制节点:在 Cindy 的流程关键点先问你(subscribe.hooks)

控制节点是 Cindy 预先埋在自动化流程里的 `will-` 拦截点。用户在某个自动化或例行任务的
「前置检查」里选了你的插件,到了节点主机就停下来问你"这次要不要继续",**不经过 Agent、
不花模型回合**。插件不会自动管所有任务:只问选了它的那些任务。你可以在插件里调自己的规则、外部决策
接口(例如 OpenAI Decisions、Jev)或任何服务,再回一个裁决。节点由 Cindy 统一维护,
新写插件不需要 Cindy 发新版。

### 当前节点

| 节点 | 什么时候问 | 能回的裁决 | 时限 |
| --- | --- | --- | --- |
| `will-schedule-run` | 每次自动化(定时任务,含脚本模式)运行前;恢复中断的续跑不再问 | allow / skip / block | 30 秒 |
| `will-routine-run` | 伙伴例行任务每次被触发、建任务和调用模型之前 | allow / skip / block | 30 秒 |

运行时用 `host-request` 查当前 Cindy 实际提供哪些节点,别靠版本号猜:

```js
const r = await cindy.request({ kind: 'control-points' });
// r.points = [{ id, actions, timeoutMs, declared, active }]
// active=false:声明了但用户还没在安装/更新确认里批准,用户还不能在任务里选你。
// 旧版 Cindy 不认识该请求会报错 —— 当作"没有控制节点",保留其它功能。
```

### 声明

```json
"slots": ["subscribe", "network"],
"subscribe": { "hooks": ["will-routine-run"] },
"network": { "hosts": ["api.openai.com"], "secrets": [ ... ] }
```

- 控制节点**不要求** `launch: "resident"`:不在跑时主机会按需拉起,唤醒耗时计入同一时限。
- 每个节点在安装确认里是独立一行权限;只有用户确认看到过的节点,用户才能在任务的「前置检查」
  里选你。插件更新时新增节点会再次请用户确认。
- 写上当前 Cindy 还不认识的节点名可以装,但不会生效,也不会在 Cindy 升级后自动生效。

### 收到询问、回裁决

```js
cindy.onHostMessage(async (msg) => {
  if (msg.type !== 'event' || msg.name !== 'will-routine-run') return;
  // msg.data:见下表;msg.deadline:本次截止时间(ms),外部请求的超时要留出余量。
  let action = 'allow', reason;
  try {
    const verdict = await decide(msg.data, msg.deadline - Date.now() - 2000);
    if (verdict === 'nothing-to-do') { action = 'skip'; reason = '没有新情况'; }
  } catch {
    // 出错时什么都不回也行:主机按用户在该任务里设置的出错处理执行。
    return;
  }
  cindy.send({ type: 'event-verdict', hookId: msg.hookId, action, reason });
});
```

| 裁决 | 效果 |
| --- | --- |
| `allow` | 不反对,照常执行(之后还有脚本前置检查的,再跑脚本) |
| `skip` | 这次不执行,记为"跳过"(不计费、不通知);下次照常触发 |
| `block` | 这次不执行,记为"失败",`reason` 会显示在运行记录里 |

规则(主机强制):

- **只能收紧**:`allow` 只表示不反对,不能替用户放行原本需要确认的事;插件不能改写任务内容。
- **出错处理归用户**:超时、崩溃、连续 3 次失败(熔断),或插件被停用、卸载时,主机按用户在
  该任务里选的处理执行(照常运行 / 跳过本次 / 停止并记为失败,默认停止并记为失败,与脚本前置
  检查一致)。插件读不到也改不了这个设置。
- 每个任务只选一个插件。`reason` 最长 200 字符。
- 只投给当前登录账号自己电脑上的流程;手机或另一台电脑触发的运行,在执行的那台电脑上询问。

### 询问数据

`will-schedule-run`:

| 字段 | 说明 |
| --- | --- |
| `scheduleId` / `runId` | 自动化与本次运行 |
| `name` / `prompt` | 名称与指令(脚本模式 prompt 为空串) |
| `executionMode` | `agent` 或 `script` |
| `trigger` | `manual` / `cron` / `interval` / `once` |
| `firedAt` | 触发时间(ms) |

`will-routine-run`:

| 字段 | 说明 |
| --- | --- |
| `routineId` / `runId` / `botId` | 例行任务、本次运行、所属伙伴 |
| `name` / `prompt` | 名称与指令 |
| `builtin` | 内置例行任务种类(如 `follow-up`),用户自建为 `null` |
| `triggerIds` | 本批触发来源 |
| `events` | 本批事件 `{ id, type, sourceId?, occurredAt, subject?, data }`,时间触发为空数组 |

不包含工作目录等本机路径。数据只用于判断,不要原样转发给不需要它的服务。
