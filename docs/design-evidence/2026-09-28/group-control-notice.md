# 群聊连接提示证据索引

- PR：[makecindy/cindy#5174](https://github.com/makecindy/cindy/pull/5174)
- 验证代码提交：`45cde48fc1ee0904581e537e7012d1ceb9f5c625`
- 截图采集代码提交：`f0f8cc06d`（后续仅补测试，产品组件未变）
- 日期：2026-09-28
- 平台：macOS，headless Chromium，生产 BotGroupChatView / BotGroupComposer / ControlledBanner 与主题；IPC 数据和侧栏外壳为 fixture。
- 边界：非 Electron 实机，未操作真实设备、权限或消息。截图不是实机验收。

## 结果

普通聊天与伙伴使用同一 composer 提示；群聊现在复用其 X 收起和呼吸点恢复，撤权入口独立。群聊与伙伴没有 RunningStatusBar，呼吸点保留在输入框上方。

- 39 项定向组件测试通过；Desktop 类型检查通过。
- 24 场景：Light/Dark × 720/800/1280px × 侧栏 0/280px × 输入 1/8 行；800px 场景高度 600px 并使用长设备名。
- 所有场景：展开提示与收起呼吸点相对输入框中心偏差 <1px，位于输入框上方，无横向溢出；输入、发送、撤权和 X 的中心命中检查通过。
- 每个场景均执行鼠标点击及 Tab / Enter / Space 的展开→收起→恢复；无障碍名称与焦点环通过；撤权独立可达，收起/恢复不调用 fixture 写接口，也不弹出撤权确认框。
- 两种主题的长群聊在连接/断连及收起/恢复时保持贴底；已上翻阅读历史时保持位置。
- 既有普通任务/伙伴和全局兜底组件回归通过，共享组件未修改。

## 截图与复现

按 [治理合同 §6](../../design-rules/design-governance.md#6-证据合同)，栅格文件只保留在 Git 忽略的临时目录，不提交到仓库。本 PR 尚未上传公开图片附件；下列命令可重建四张供审阅的 PNG，均带 fixture 标记。上传附件后可将对应 PR 评论链接追加到本索引。

```sh
node apps/desktop/scripts/check-group-control-layout.mjs /path/to/chromium tmp/group-control-evidence/review-screenshots
```

已目检：Light 1280px 单行、Dark 720px 八行，侧栏均为 280px；展开和收起各一张。保留的截图 SHA-256 用于核对原始文件；重跑时呼吸动画可能使图片字节不同。

| 文件 | SHA-256 |
| --- | --- |
| `group-control-dark-narrow-collapsed.png` | `47250bfcb855b26d1fc63622208e850b2b46ac0d6ac66b9aa183e54533b11233` |
| `group-control-dark-narrow.png` | `4704ff973e578ba70603e4b34b1a3447b3d8e725495e051ffaacd66fd943fd62` |
| `group-control-light-wide-collapsed.png` | `ed63ca746af94d067483012ba9fffc9fcba3d064bbe6b6faf530bbc8e38e9048` |
| `group-control-light-wide.png` | `74fa0382ef23e3c76a321498b154c355a9f2eecbda06b64f3c04e8162b3539fe` |

[截图存放方式的审核记录](https://github.com/makecindy/cindy/pull/5174#discussion_r4119073079)。
