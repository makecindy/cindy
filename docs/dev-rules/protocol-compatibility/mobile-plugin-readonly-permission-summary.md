# 移动插件只读权限摘要

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

plugin-capabilities.data 可选追加 permissions（title/description 字符串数组），仅由 Host 从
PC 同源 ghostPermissionItems 声明摘要投影并排除 tool，以请求 locale 使用 PC 文案插值。
包含作者声明的 OAuth scope，不包含凭证、已存配置值或本机路径；不表示已授予运行权限。
旧控制端忽略该字段，新手机遇到旧 Host 缺字段或格式不完整时明确未提供，不推断无权限。
空数组仅表示 Host 明确投影的声明为空。工具、about 和 version 使用原字段。
不增加 channel、allowlist、relay 帧、授权或协议版本，服务端无改动，Mobile 指纹不变。
