# 外部系统接入（partner-bridge）

> **读取时机**：要用别的程序（自研服务、微信自动化脚本、ERP／工单系统）派活给 Cindy
> 伙伴并取回结果时；或修改这条链路的传输、鉴权、会话策略时。

## 它是什么

桌面端在本机起一个只监听 127.0.0.1 的 HTTP 服务，把调用方的请求变成一轮真实的伙伴
任务：找到（或新建）这个 key 的专属会话，投递指令，等这一轮跑完，把终稿文本与附件
路径交回调用方。会话落在侧边栏「对话」分组（source 为 bridge），用户能看见、能进对话
里停，不做隐身执行。

执行链与插件「AI 代办」、定时任务、IM 渠道同源：统一投递通路（maker-ipc 的
sendToSession）加同一套 turn 收口（hook-control 的 turnObserver）。区别只在身份：这里
没有渠道身份、没有插件身份，调用方是一个本机进程。

## 怎么找到入口

服务随应用启动（apps/desktop/src/main/partner-bridge/runtime.ts），端点写在：

    <userData>/partner-bridge/endpoint.json     目录 0700，文件 0600

macOS 上 userData 是 ~/Library/Application Support/Cindy。文件内容：

    {
      "port": 51234,
      "token": "…64 位十六进制…",
      "pid": 12345,
      "startedAt": 1760000000000,
      "protocol": "cindy-partner-bridge/1",
      "url": "http://127.0.0.1:51234"
    }

每次启动端口与 token 都会重新生成，退出时文件被删除。所有请求都要带
Authorization: Bearer 加 token。

## 接口

### 派一单

    POST /v1/tasks
    {
      "key": "wechat:user123",
      "prompt": "把这个月的订单整理成表格",
      "workingDir": "/Users/me/work",
      "permissionMode": "acceptEdits",
      "callbackUrl": "http://127.0.0.1:8080/cindy/hook"
    }

字段说明：

- key：必填，会话分间键，1 到 200 个可打印字符。同一个 key 复用同一间会话。
- prompt：必填，上限 32000 字符。
- workingDir：可选，绝对路径，必须存在且是目录；缺省用 app 托管的对话目录。
- permissionMode：可选，plan / acceptEdits / auto，缺省 plan（只读）。
- callbackUrl：可选，完成后 POST 结果到这个地址，只允许 http／https。
- agentKind：可选，cc / codex / pi；缺省跟随 New Maker 草稿默认。

返回 202：

    { "taskId": "ptask_…", "key": "wechat:user123", "sessionId": "…",
      "status": "running", "text": null, "attachments": [],
      "errorCode": null, "error": null, "createdAt": 0, "finishedAt": null }

一轮可能跑几分钟（兜底超时 25 分钟），所以提交立刻返回 taskId，结果走回调或轮询。

### 查结果

    GET /v1/tasks/<taskId>

终态是 succeeded / failed / cancelled。succeeded 时 text 是终稿正文（托管媒体引用已
替换成一句提示），attachments 是附件清单：

    { "name": "报表.xlsx", "absPath": "/…/报表.xlsx", "bytes": 20480, "kind": "file" }

附件只回本机绝对路径（调用方按定义与本机同侧，直接读即可），不做 base64 搬运。
xdt-file 引用必须落在该会话的工作目录内才收集，路径不在根内一律跳过。

### 取消

    POST /v1/tasks/<taskId>/cancel

中止该会话当前的这一轮，任务落 cancelled。

### 回调

给了 callbackUrl 时，任务进入终态后 POST 一次，body 与 GET 的返回同形。失败最多重试
3 次（1s／2s／4s 退避），之后放弃并留日志；结果仍可从 GET 取到。回调不跟随重定向。

### 健康检查

    GET /v1/health     → { "ok": true, "version": 1, "running": 0 }

## 语义与边界

- key 分间：同一个 key 复用同一间会话，上下文连续；不同 key 互不干扰。权限档或工作
  目录变了会换新会话，旧会话留在侧边栏。
- 不排队：同一个 key 已有一单在途时直接 409 BUSY；会话恰好被用户占用也回 BUSY。
  排队会让这一单的结果对不上正在跑的那轮，所以宁可让调用方重试。
- 权限档：只认 plan／acceptEdits／auto，缺省 plan。协议上不存在 bypassPermissions。
- 任务历史不落盘：任务档案活在进程内存里，应用重启后查不到旧任务（会话与 key 映射
  仍然持久）。需要长期留档的调用方自己存。
- 单机范围：服务只绑回环地址。跨机调用请自行开隧道（例如 ssh 的 -L），不要改成监听
  0.0.0.0。
- 进程必须在跑：伙伴运行在桌面端进程里，应用退出后没有任何东西在跑这一轮。

## 调用示例

    ENDPOINT="$HOME/Library/Application Support/Cindy/partner-bridge/endpoint.json"
    PORT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['port'])" "$ENDPOINT")
    TOKEN=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['token'])" "$ENDPOINT")

    curl -s -X POST "http://127.0.0.1:$PORT/v1/tasks" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"key":"wechat:user123","prompt":"把这周的订单汇总成一张表"}'

## 相关代码

| 关注点 | 位置 |
|---|---|
| 任务编排（提交／收口／取消／回调） | apps/desktop/src/main/partner-bridge/taskService.ts |
| 回环 HTTP 与鉴权 | apps/desktop/src/main/partner-bridge/server.ts |
| 端点文件 | apps/desktop/src/main/partner-bridge/endpointFile.ts |
| key 到会话的映射 | apps/desktop/src/main/partner-bridge/sessionStore.ts |
| 会话创建（source 为 bridge） | apps/desktop/src/main/partner-bridge/sessionFactory.ts |
| 附件解析 | apps/desktop/src/main/partner-bridge/attachments.ts |
| 宿主依赖接线 | apps/desktop/src/main/maker-ipc/register.ts（搜 setPartnerBridgeDeps） |
| 启停 | apps/desktop/src/main/partner-bridge/runtime.ts、bootstrap-electron.ts 的 before-quit |
