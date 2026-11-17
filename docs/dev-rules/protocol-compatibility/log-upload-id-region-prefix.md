# 日志上传编号的区域前缀

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Desktop 和 Mobile 的新 `uploadCode` 使用 `CN-XXXX-XXXX` / `GLOBAL-XXXX-XXXX`，
内部 Dev 构建使用 `DEV-XXXX-XXXX`；随机部分仍保留 8 位。SLS 的 tags、逐条记录和
客户端返回值都传完整编号，字段名、字符串类型、IPC 和 SLS web-tracking 结构不变。
格式校验继续接受历史无前缀 `XXXX-XXXX` 编号，历史日志不改写；新旧客户端的显示和
复制均按不透明字符串处理。回滚后恢复生成无前缀编号，不迁移数据。
外部检索工具若自行限制了编号长度或正则，需要接受带前缀格式；已有编号按原值查询。
前缀只隔离不同区域的新编号，不承诺同一区域随机编号唯一。不改变服务端、授权范围
或 Mobile 原生依赖与配置。实现与回归见 Desktop `log-upload/uploadCode.ts` /
`__tests__/crashTriggersAndCode.test.ts`、Mobile `debug/diagnosticUpload.ts` / 同名测试。
