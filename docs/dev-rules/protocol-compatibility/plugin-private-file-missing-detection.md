# 插件私有文件读取的缺失判定

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`fs-request` 的 `root:data / op:read` 在确认为 ENOENT 时，向既有
`{ok:false,message}` 回执增量添加 `errorCode:NOT_FOUND`。旧插件继续读取原字段；
新插件仅可据该错误码初始化缺失记录，不得把权限、路径或未知读取错误当成空数据。
旧宿主缺少错误码时保持未核实状态，不解析人类文案推断文件缺失。
实现及回归：`fsSlot.ts`、`fsSlot.test.ts`。
