# 自建 Mobile 原生 OTA 恢复

本功能只在显式启用的自建整包中装配。它不是已上线 JS bridge 的直接 OTA 替代品；
原生能力改变后必须发布新整包，旧 runtime 的 bridge 和下载指针需要继续保留。
商业发布配置与实际更新地址仍由维护者的私有构建环境管理。

## 构建契约

- 自建构建设置 `EXPO_PUBLIC_XDT_OTA_SELFHOST=1`、`CINDY_MOBILE_OTA_NATIVE=1`，并注入
  `CINDY_MOBILE_UPDATES_URL`。地址必须使用 HTTPS，不允许凭据、query 或 fragment。
  地址成为原生 runtime 输入，不能再随运行期端点清单任意切换。
- 未设置原生开关或设置为 `0` 时保留原来的 bridge 原生配置。非自建构建不装配适配器，
  也不因这些变量改变其 Expo 配置。开关是内部构建控制，不是用户设置。
- 原生默认与每次通道切换均使用同一共享 `EAS-Client-ID`，release 的通道值固定为空字符串，
  不允许在缺 key、空值、`null` reset 三种下载身份之间混用。
- 保持 `checkAutomatically=NEVER`，开启 anti-bricking。OTA 检查仍由现有 JS 入口调度；
  TapDB/隐私选择及账号资格不由本功能修改。
- `with-selfhost-ota` 仅在生成的 Android/iOS 工程内复制并适配 `expo-updates@57.0.18`。
  不修改共享 `node_modules`、不引入全局 autolinking 模块。上游版本或任何挂点不匹配时
  构建失败；原生源码摘要进入 resolved plugin options，防止原生变化漏进 fingerprint。
- Android 使用生成的 Expo 子工程；iOS 使用生成的 EXUpdates pod，并强制从源码编译，
  不能由未适配的预编译 framework 覆盖。

## 持久状态与恢复边界

原生私有状态包含 schema 版本、runtime、原生 URL、安装包 embedded ID、最后成功版本、
下载候选及其时间、在途请求、被拒绝的候选 ID。没有账号、consent、用户 Beta 偏好或凭证。
状态不进入设备备份。

| 阶段 | 持久动作 | 进程中断后的行为 |
| --- | --- | --- |
| 新原生代际或 runtime | 创建本代际状态，重建完整 Expo override | 使用新包 embedded，不沿用旧 runtime OTA |
| 同 runtime 覆盖安装 | 按真实 embedded ID 识别新包，仅移除旧 embedded 或更旧 OTA receipt | 不让旧 OTA 遮住更新的整包；同时间或更晚 OTA 仍保留 |
| 开始检查/下载 | 先原子写 journal，再改 header | 未完成下载时恢复原成功版本 |
| 原生下载完成 | 在通知 JS 前记录 pending | 允许下载候选启动，不依赖 JS finally |
| 即将启动候选 | 原生记录启动尝试 | 最多两次未确认尝试，之后恢复成功版本 |
| Expo content appeared | pending 成为 good | 不再因后续业务错误任意自动回滚 |
| 首次内容出现前失败/资源损坏 | 拒绝 pending，恢复持久与内存配置 | 同进程也能选回 good；不可恢复时保留 Expo 整包兜底 |

启动选择继续使用 Expo 的 runtime、scope、数据库 launchable 状态和资产校验。只有原生
事务确认的 pending/good 可跨通道及 manifest-filter 边界匹配，不能启动任意历史缓存。
Reaper 保留这两个 ID 及其关联资源；服务端 rollback 指令在原生已接受时清除对应 pin。
本功能不另加服务端发布、回滚入口或新的下载器。

覆盖安装时在 Expo 读取配置前恢复状态：旧 override 的空 header 或只有 channel 的形态也
会被处理，不能只移除 URL。恢复同 runtime 时不重复清除有效 OTA。辅助文件写入失败时
禁用新的 OTA 操作，不能因为 journal 写入失败让账号、业务数据或整个应用被清理。
无可用 journal 时选择器只允许当前安装包的 embedded，不能回退到任意 release 缓存。

embedded 的识别依据真实安装包 ID 和原生 URL/headers，不能假设 Expo 57 的 embedded
没有 URL/headers。双端 embedded-only loader 每次注册当前内置版本，避免旧通道的
manifest filters 阻止它入库；通用远端下载策略没有放宽。跨通道返回同 updateId、命中
缓存时，下载 receipt 从实际数据库对象建立，不把新响应 headers 错当成旧缓存的身份。

每次更换 React launcher 先退役旧错误恢复实例，再为新首屏建立恢复状态。旧队列中的
content-appeared、延迟移除错误监听器及 relaunch 回调不再修改新一轮状态；不能只重置
journal 而沿用已被裁剪的 Expo 错误恢复流程。

JS 只负责串行调度、超时与同 ID 去重。发现新版原生方法后必须校验原生 ABI/runtime；
异常时禁止回退到需要关闭 anti-bricking 的完整 URL override。旧二进制没有该方法，
继续使用已上线 bridge；不能用可被 OTA manifest 改写的 extras 判断原生能力。

## 验证与发布前门槛

常规定向测试：`nativeAppConfig.test.ts`、`selfhostOtaPlugin.test.ts`、
`nativeOtaRequestCoordinator.test.ts`、`nativeOtaRouting.test.ts` 和现有 OTA 入口/bridge 测试。

原生状态测试使用生产 journal 源码和窄范围 Expo/平台边界替身，临时文件只写测试目录：

- Swift：`node apps/mobile/scripts/test-selfhost-ota-native.mjs`，需要 Swift 编译器；
  同时对被适配的 Expo Swift 文件做语法检查。
- Kotlin：`node apps/mobile/scripts/test-selfhost-ota-android.mjs`，显式提供
  `CINDY_OTA_TEST_KOTLINC`、`CINDY_OTA_TEST_JDK_HOME`、`CINDY_OTA_TEST_JSON_JAR`。
  测试工具不自动安装系统软件，也不读用户设备的数据。

这些测试不替代完整原生工程编译或设备验证。出包前必须再验证：

1. Android/iOS 自建冷包和新 runtime OTA 使用相同构建输入；分别核对两区域指纹。
2. 非自建 Android/iOS 指纹与同依赖、同环境基线一致。
3. 旧包覆盖安装、干净 SSO、普通账号切 SSO 后开 Beta、无新版、断网及超时。
4. 在改 header、完成下载、启动候选前后强杀，核对真实 updateId 和运行来源。
5. 候选首次启动失败、资源缺失、磁盘写入失败及缓存回收后的离线回退。
6. 不覆盖旧 runtime 的 bridge/通道指针；是否持续维护旧 runtime 需另有发布机制。

本改动属于冷更及更新器原生适配，指定把关人明确确认前不得合并或发布。确认要求见
`docs/dev-rules/mobile-development.md`。

## 本地验证记录（2026-09-07）

- Mobile 全量单测：376 个文件、4,698 项通过；typecheck、scope、smoke 及根目录
  `pnpm test:unit:related` 均通过。
- Swift 与 Kotlin 生产 journal 均已编译并运行边界替身测试，覆盖强杀窗口、启动确认、
  跨通道缓存身份、同 runtime 覆盖安装及 I/O 不可用。适配后的 Expo Swift 文件通过语法检查。
- 隔离临时项目的 Android/iOS `expo prebuild --no-install` 通过；生成工程含专属原生
  适配依赖、固定测试 URL 和完整共享 headers。没有修改工作区的生成工程或共享依赖源码。
- 用同一依赖环境、虚拟构建配置对比基线与本分支，CN/Global × Android/iOS 四组均符合：
  非自建不变、旧 bridge 模式不变、启用原生模式改变指纹。这里验证变化范围，具体发版
  runtime 仍由私有流水线用真实构建输入计算，不能拿测试环境 hash 发布。
- 尚未做完整 Android/iOS 原生工程编译和设备验收，尤其新一轮首屏错误恢复的真实 React
  生命周期、磁盘故障、强杀及离线资产恢复；以上替身测试和 prebuild 不代表这些项目通过。
- 本轮未修改私有构建流水线、启用生产开关或发布任何产物。接入流水线时，新整包及后续
  同 runtime OTA 必须同时使用上述原生构建变量；旧 runtime bridge 指针另行保留。
