# 原配置页 QA fixture

仅供原 settingsHtml 桥的测试与隔离环境验收，不是产品设计稿，也不是可直接安装的插件包。
没有 manifest、自动安装器、外网地址或凭证。此轮验收不含文件导入；目录选择只验证目标
归属、取消与回传，不读取或导入所选目录内容。总控负责最终真机/模拟器闭环。

## 给原页面桥提供内容

- 将 `settings.html` 作为 `manifest.settingsHtml` 指向的原文件，原样供给 `settings.js`。
- 测试 `bundle` 返回这两个文件的实际字节数、MIME；`asset` 按现有 49,152-byte 分片协议供给。
- 使用现有物理实例、安装批准和设备身份；同 manifest id 的 root/org 两份分别运行。
- 不根据 QA 插件 ID 修改生产代码，不把 `responses.json` 注册到生产路由。
- `responses.json` 是固定的合成 Host 响应种子。页面不会读取它，Host 不可用时也不会偷换成
  这些数据。测试应在注入的原设置 executor/测试后端提供这些事实。
- OAuth 测试后端提供两个账号；真实 OAuth 回跳仍需专用测试 provider/账号，本 fixture
  本身不声称已完成授权。

## 原交互与后端合同

| 页面动作 | 原接口 / 可观察结果 |
| --- | --- |
| 初始读取、重新读取 | `GET /kv`、`GET /secrets`、`GET /oauth`；失败显示失败，不伪造 ready |
| 普通字段、底部长文本 | 读 `/kv` → 合并相关字段 → `PUT /kv` → 回读；保留无关键 |
| 敏感输入 | `PUT /secrets/key`，body `{value}`；回读仅状态；成功或失败后清空输入 |
| 增加测试账号 | `POST /oauth/login/connect`，body `{}`；随后回读账号 |
| 切默认账号 | `POST /oauth/login/default`，body `{accountId}`；随后回读账号 |
| 目录与频道 | 既有 `BroadcastChannel('qa-settings')`，见下表；不发明宿主 HTTP 端点 |

测试端根据实际声明提供 `key`（user Secret）、`login`（OAuth）以及 `qa-settings` 频道。
fixture 只操作这些声明；不含秘密初值，也不把 Secret 写到 `/kv`、页面状态、日志或本地存储。
原页面里的短暂输入仍须由正在验收的加密设置桥承接；直接从浏览器访问不能证明秘密通道安全。

| 频道请求 | 测试/插件执行端回复 |
| --- | --- |
| `{kind:'probe', requestId}` | `{kind:'probe-result', requestId, targetLabel:'QA target B'}` |
| `{kind:'choose-directory', requestId}` | `{kind:'directory-result', requestId, name:'QA directory'}` 或 `{kind:'directory-result', requestId, cancelled:true}` |

目录请求是这个 QA 插件自己的频道消息，不是 Cindy 公共 API。测试可以让执行端调用现有
`MobilePluginPages.chooseDirectory` 来触发目标目录选择与回传；不要为了 fixture 新增
`/__bridge__/pick-directory` 一类生产路由。真实插件使用既有目录选择能力时仍按其原声明和
执行路径运行。迟到的旧 requestId 回复必须忽略。

## 最小人工验收顺序

1. 在总控集成预览分支的隔离 B 打开原页；确认标题与 QA 标记，两个账号来自 B。
2. 修改 label、开关、语言，保存并重读；从另一控制端读取 B 核对；C 哨兵保持不同。
3. 输入明显无效的 QA key，保存；输入被清空，页面只返回 saved 状态。
4. 切换两账号默认值；取消/完成专用 OAuth 测试授权；回读事实。
5. 发频道 probe；目录分别取消和选择；只显示匹配 requestId 的结果。
6. 滚动至第 16 个输入和 Last field；输入后切主题、开关键盘，检查焦点、草稿和保存可达。
7. 分别在 320px、常见手机、平板与 Light/Dark 检查；生产主题 token 由宿主提供。
8. 等待/保存期间断线、切设备/账号/安装代次，回前台只对账，不能重放写入。

本页 `/kv` 是原插件的整体覆盖接口，读后合并不提供原子并发控制；不以此 fixture 声称解决
了插件的并发保存冲突。16 个 scrollProbe 字段仅是页内未保存草稿，只有 Last field 会持久化。

## 验证边界

合成响应和 DOM smoke 只证明原页交互可运行；Host 单元测试证明回执/时序合同；真实加密桥、
钥匙串、OAuth 系统浏览器、键盘/滚动、安全区及网络恢复须由总控在隔离 Host 与原生客户端验收。
不要用 Expo Go/mock-host 结果替代当前 native 包与真实 Host 的完整闭环。
