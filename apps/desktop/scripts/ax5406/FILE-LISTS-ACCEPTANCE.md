# #5406 文件清单补充验收（2026-10-04）

基线与 P1-ACCEPTANCE.md 相同；本次不修改产品代码。Windows 隔离 dev，OpenAI GPT-6-Luna 真实工具输出。
证据目录：`C:/Users/User/AppData/Local/Temp/cindy-5406-files-_bszklqs/`。

| 范围 | 结果 |
|---|---|
| 定向自动化 | GeneratedFilesCard / projection / generatedFiles / remote：4 文件 76 项通过；Review fileTree / lastTurnFilter / reviewSource：3 文件 26 项通过，共 102 项 |
| 流式清单到变更卡片 | 工作目录内真实创建 7 个文件；生成过程中展示独立清单，完成后由同轮变更卡片去重承接，7 项齐全且物理文件存在。360 次采样无可见占位空白，`transition.json` |
| 独立文件清单 | 在临时工作目录外、独立临时目录真实创建 7 个文件，无对应变更卡片；完成后清单保留。100 次采样无可见占位空白，`standalone.json` |
| 文件清单滚动 | Light/Dark × 1280×800、960×640、1600×900；6→7 展开、离屏仍挂载、返回保留展开、无横向溢出；96 次定向滚动采样无可见占位空白。切换任务、刷新后唯一清单及 7 项内容正确，`list-ui.json` |
| 文件预览 | Markdown / TXT 弹层内容与文件标记一致；HTML 在真实侧栏 WebContents 打开并目检标题，`preview.log` 与 `preview-*.png` |
| 本轮已修改文件树 | 7 项完整、筛选单项和无结果后恢复、逐项选择；Light/Dark × 三种窗口尺寸；历史轮 5 个 note 文件与新一轮 7 个 file-list 文件各自独立，切换任务后范围正确，`sidebar.json` / `sidebar-regression.json` |

测试脚本修正：首次等待错误地要求生成完成后仍保留重复清单；根据既有去重行为修正为验证最终卡片的完整性，没有重复发送创建请求。另修正脚本的展开按钮文案、末尾位置阈值、历史轮次先滚动加载、日志 UTF-16 解码。HTML 内嵌 WebContents 在重新连接 CDP 后不作为普通 page 枚举，故其标题以真实截图目检记录。未修改或放宽产品测试断言。

本次未发现文件列表相关回归。截图与 HTML 报告留在临时证据目录，不纳入工程。本结论仅限上述 Windows dev 场景，窗口变化通过 CDP 设置视口；未验证远端手机文件取回、macOS 或正式安装包。原始崩溃转储仍缺失，先前 50k 性能波动也不因本次补测而变为全绿。
