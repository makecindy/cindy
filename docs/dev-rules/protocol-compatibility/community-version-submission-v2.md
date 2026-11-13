# 社区版本提审 v2（2026-10-16）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

manifest 可选字符串 `releaseNotes`；旧包缺字段仍可安装。首次上架可不填写，曾上架插件的后续提审须提供完整非空更新说明。
个人只读 preflight 查询版本、待审与提交权限；SubmissionView 追加真实时间及允许取消动作。
审核状态增加 cancelled；Main/preload 新增精确 cancelReview，AI 对应 ghost_cancel_plugin_review。
旧 journal 字段可选只为读取/原操作恢复，不允许新客户端静默绕过新版预检。
个人投稿复用原审核请求及上架流程，不增加启用开关、审核令牌或历史比较包门槛。取消仅针对本人仍有提交授权的精确待审修订，已通过或驳回时按真实状态返回。
