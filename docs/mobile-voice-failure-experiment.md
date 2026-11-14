# 手机空识别诊断录音（个人实验，不准备正式发布）

此分支仅供 Dash 自己排查手机语音整段为空。保持 Draft；不合并到正式发布、不发布公共
安装包或 OTA。它收集证据，不是识别根因修复，也不改变重试次数、握手、发包节奏或原生采集。

## 开启与关闭

此个人实验分支在个人构建和 Debug JS 中默认开启。个人 iOS 构建器
`scripts/personal-build/mobile.mjs` 自动注入 `EXPO_PUBLIC_CINDY_PERSONAL_BUILD=1`，
因此采用 Release 优化、development 或 Ad Hoc 签名的个人包也会保存失败录音；
`__DEV__` 只表示 JS 开发模式，不是个人版身份。公共 Release 无个人标记，保持关闭，
旧的 `EXPO_PUBLIC_VOICE_FAILURE_DIAGNOSTICS=1` 不能单独开启公共包录音。
公共 Release/OTA 共用构建环境入口会剥除继承的个人标记，个人构建器随后重新注入。
仅登录账号后生效，显式 `EXPO_PUBLIC_VOICE_FAILURE_DIAGNOSTICS=0` 在个人版和 Debug 中
都优先关闭。标记只进入 JS，不写 Expo extra 或原生配置。

个人包需使用包含本改动的构建器重新构建、安装；仅把 PR 合入源码、继续使用旧构建器或
旧安装包都不能证明生效。安装后核实源码组合包含本 PR；复现一次失败，确认普通日志出现
`local failure recording saved` 且沙盒实际有 WAV/manifest，才算交付录音验证完成。

普通开发入口默认开启；临时停用需设置 `EXPO_PUBLIC_VOICE_FAILURE_DIAGNOSTICS=0`，
重新启动 Metro 并重新加载/构建 JS（个人 Release 则重新构建安装）（Expo 在打包时替换此变量，不能只改父进程环境）：

```sh
# 默认开启失败录音
pnpm --filter mobile start
# 显式关闭
EXPO_PUBLIC_VOICE_FAILURE_DIAGNOSTICS=0 pnpm --filter mobile start
```

使用既有个人真机开发包连接该 Metro。此 PR 不安装/覆盖手机应用，不修改原生模块、依赖、
app.config 或 runtime fingerprint；包和 Metro 版本须在真机复现时另行确认。

## 保存什么

- 录音期间仅存内存。成功提交、主动取消不保存；识别/启动/采集失败时保存。停止后全静音
  或零采样的空录音也保存为 `silent_empty`，以便发现麦克风没有实际采到声音的情况。
- `capture.wav`：原生采集已经转换为 PCM16、送到 JavaScript 后，声纹过滤之前的单声道
  音频。**不是**原生 48kHz 原始音轨；不能单凭它区分硬件采集与原生重采样问题。
- `sent-1.wav`、`sent-2.wav`…：SAUC 每次 WebSocket 连接中，`socket.send` 成功返回的 PCM
  （包含重放和 300ms 最后静音包），按真实发送顺序写成 WAV。WAV 不包含墙钟间隔；间隔看 manifest。
  **不代表服务器完整收到**。OpenAI/Qwen fallback 目前仅有采集和流程记录，无发送音轨。
- `manifest.json`：完整 runId、时间、服务端 sessionId（仅 UUID）、连接编号、发包序号和
  字节数、响应类型/flags/序号、解析是否有 payload、文字长度、数字错误码与结束原因。
  响应只存摘要，不存听写文字、原始响应正文、URL、ticket、鉴权头或语音内容到普通日志。
- 单次所有音轨合计最多 8 MiB PCM；超出部分不保留，metadata 明确标记 `truncated`。
  最多 8 个 SAUC 连接，事件仅保留最后 512 条并记录丢弃数，长录音不能当作完整证据。

## 本地位置与清理

保存到手机应用沙盒的 `Library/Caches/voice-failure-diagnostics/`（Expo cacheDirectory；
Android 为对应应用缓存目录），与普通调试日志、日志上传和媒体附件分离。此本地缓存副本是
用户明确授权的个人诊断实验，不是新增正式媒体存储；不接桌面媒体仓、不自动同步或上传。
缓存可能被系统提前清除，不保证恢复。退出/切换账号时清理；写入中账号变更也清除部分产物。

最多保留最近 3 个包。创建诊断器/保存失败包时，自动清除超过 24 小时的包；**应用不运行
或未再次使用语音时，不保证到点删除**。停用前可手动删除此专用目录，勿删除其它应用数据。
写入失败仅产生固定提示，不阻断听写；写入完成前应用被杀可能留下部分包，下次按同一保留策略清理。

普通手机调试日志的 `local failure recording saved` 含 runId 和本机目录，便于取证。iPhone
连接 Mac 后按实际设备与测试应用标识取出（勿把整包提交到 Git 或公开 PR）：

```sh
xcrun devicectl device copy from --device '<UDID>' --domain-type appDataContainer \
  --domain-identifier '<实际测试应用 bundle id>' \
  --source Library/Caches/voice-failure-diagnostics --destination '<仓库外诊断目录>'
```

先听 capture 与 sent 是否正常，再以 sessionId 对齐服务器日志。capture 已静音/失真指向
采集或转换；capture 正常但 sent 缺失指向过滤/客户端发送；两者正常仍需核对服务器收到的
字节与上游实际响应，不能直接把问题归给模型。重试音轨必须按连接分别比较。

## 验证边界

单元测试用假 WebSocket 和内存文件系统验证实际生产函数：WAV 字节、首次/重试/末帧、
响应摘要、预热继承、失败保存、成功/取消丢弃、容量/保留、账号切换和磁盘错误。
尚未安装真机测试包，未完成真机听音、后台中断和文件导出的实测；不能宣称已修复线上问题。
