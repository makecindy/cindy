# 图片标注区域说明

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:input:enqueue` / `maker:input:steer` / `maker:input:update-content` 的队列附件
（`AgentInputSerializedFile`）追加可选 `annotationRegions: { x0, y0, x1, y1 }[]`：标注图
（`annotated: true`）烧录时由笔迹归纳的外接框，归一化坐标（0..1，原点左上，两位小数，
每张图至多 6 处）。只经既有 device-link 隧道与 IPC 透传，不新增 channel、relay 类型或
持久化 schema。消费端 `buildMakerUserMessage` 一律经 `sanitizeAnnotationRegions` 校验，
有合法区域时在原标注说明后另起一行按本条消息内图片顺序描述区域；仍然每条消息至多一条说明。
旧主机忽略该字段，只注入原固定说明；新主机收到旧控制端（不带该字段）的消息时，说明与
旧版逐字节相同。remote 会话剥离 `annotationSourceUrl` / `annotationStrokes` 时保留区域字段。
Mobile 以同一归纳算法在上传后的附件（含持久发件箱 `DurableUpload`，可选字段、旧记录缺省）
上携带该字段；底图本身已是烧录图、旧红线位置不可知时不带区域。服务端无需改动。
