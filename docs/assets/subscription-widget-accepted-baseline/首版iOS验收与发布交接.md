# 首版 iOS 小组件验收与发布交接

## 当前结论

2026-10-02 用户确认 Extra resets UI。版式锁定，只修 bug；PR #5252 继续 draft，不合并、不上传、不发布。核对代码head为 `779bf7134d8e94d2574721bc3178309c29dbd0a6`。本报告不将用户确认替代指定维护者冷更/设计批准。

## CI 与验证范围

本轮一次性读取该head：Linux两片、Windows两片与汇总、verify-checks、verify、Desktop Git integration及DCO全部成功；设计依据检查因draft跳过。PR可合并、REVIEW_REQUIRED，尚无review或审批评论。上轮190项定向测试精确对应此head，未因无源码变化重复运行。完整App新构建与运行结果见下方证据追加。

## 剩余责任

| 项目 | 状态 / 后续 | 负责人 |
|---|---|---|
| UI方案 | 用户已确认，后续只修bug | 当前实现者维护基线 |
| unknown套餐 / Extra resets | unknown隐藏；正式availableCount；未知—、真0为0；不猜价格档、不消费reset | 当前实现者，维护者review |
| 代码/设计/冷更 | 尚无指定把关人的显式确认；新增AppGroup与WidgetKit扩展使冷更不可避免，旧包不能仅OTA获得能力 | CODEOWNERS为@makecindy/maintainers；由其指派内部设计/冷更放行人 |
| 第二个真实账号切换 | 未有第二个已授权测试账号；单测覆盖迟到响应与清理不等于真实多账号E2E | 实现者在有合法测试账号后补，验收负责人确认范围 |
| 真实断网恢复 | 未做设备/应用范围的实际断网恢复；fixture/调试重载不替代；不影响Mac网络 | 实现者使用正式隔离网络能力后补 |
| Duo | 仅iOS27.0，缺27.1/Duo runtime；不声称已适配真实Duo | 测试环境负责人提供正式runtime/必要许可后实现者补测 |
| Android | 当前文本兼容层，未SDK编译/原生验收，不纳入首版iOS完成声明 | Android后续工作负责人 |
| Grok真实账号 | 无真实账号，fixture与已核验契约不等于端到端 | 后续有已授权账号时补测 |
| 物理设备 / 分发签名 | 当前为模拟器Debug，不是可装实物的已签名IPA；尚未验证archive/export | 维护者发布负责人，与实现者共同验收 |

## 真实仓库入口与分发前缺口

- 本地模拟器入口：根`package.json`的`pnpm mobile:sim:rebuild -- --build-only`，只构建模拟器包。本轮强制构建并核对App/扩展与fingerprint，不是TestFlight包。
- Store配置：`apps/mobile/eas.json`的`testflight-global`继承`store-global-base`，store distribution、production环境、production-global channel。未限定区域默认Global，不误用cn的`testflight`。存在profile不代表已签名/已上传；没有为本任务执行任何付费云构建或上传。
- 本地签名IPA入口：根`pnpm mobile:build:ios`→`apps/mobile/scripts/build-ios.mjs`，显式region，`--execute`才archive/export；脚本本身不上传。签名配置在仓外维护，未读取钥匙串或私密配置。
- **实际代码缺口**：`with-quota-widget.js`生成extension target与AppGroup，但未像`with-communication-notifications.js`一样注册EAS `extra.eas.build.experimental.ios.appExtensions`；EAS预构建签名发现不能视作已就绪。需实现者与发布负责人在选定分发通道后补足并测试此元数据，不擅改生产签名。
- **本地导出缺口**：`scripts/lib/ios-local.mjs:buildExportOptionsPlist`当前只映射主bundle provisioning profile，未为quota extension提供映射；`build-ios.mjs`还向archive传主profile。含扩展的真实签名archive/export需单独适配/验证，不能直接宣称现有脚本会成功。
- 当前Global原生身份是`com.xd.cindy`，widget为`com.xd.cindy.quota-widget`，共享组`group.com.xd.cindy.quota`；发布负责人需在所选Apple团队为App及扩展配置对应capability和profiles，不在本任务中读取、修改或自动申请凭据。

建议顺序：维护者先review草稿并明确设计/冷更批准与iOS首版范围 → 实现者补真实断网与可得账号边界、分发构建适配 → 发布负责人完成签名与物理设备/内测安装验证 → 获明确分发授权后走实际发布通道。冷更宜随维护者计划的新原生版本一起发布；不能通过本次用户视觉确认直接进Ready或自动合并，也不能只推OTA。

## 合主干后完整构建与运行实证

- 2026-10-02 16:20至16:31 CST，针对代码head `779bf7134`，仓库正式 `mobile:sim:rebuild -- --build-only --force-build` 完整prebuild/Pods/App/扩展构建退出0。原生fingerprint `5f8904917a99d0b4daf9a4c301dc18f35982e309` 用与构建相同的Global本地配置独立复算匹配；产物SHA见 `Current-Build-Verification.json`。首次手工复算漏了仓库本地配置导致不同hash，纠正为正式同源环境后匹配，没有伪造指纹或改源码。
- 正式Baguette 0.2.0安装同一完整App到任务原Air和18 Pro，iOS27.0/Xcode27.0 27A266a。未新建设备、未重新登录、未动凭据。
- 18 Pro保持既有登录，Widget点击深链进入配额页，立即同步后源时间更新，Claude/Codex真实额度到small/medium；16:38深夜与16:42白天逐图目检。真实截图仅本地交付，未公开上传。
- Air没有已授权账号：完整App起初恢复黑屏，正常应用切换器关闭该App再启动后进入真实登录页，无重装运行库或重新授权。small/medium空态正确显示Open Cindy、Extra resets: —，不编造0或计划。16:41/16:46昼夜检查；点击medium进入真实Cindy登录页，未执行认证。SpringBoard仍缓存旧fixture显示名“Quota Fixtures”，完整App图标已是Cindy；因此Air图片仅证明新包覆盖安装后的空态/深链，不当作Air真实账号同步或全新安装命名验收。
- 本轮没有修改SwiftUI或数据源码，无需重跑同head190项已通过定向测试；该head完整CI已成功。本轮补的是上轮缺失的完整App重建和安装运行证据，不重复声称全量实际账号/网络用例。

**Ready判断：暂不转Ready。** 可审阅代码、CI、确认UI与两机型模拟器证据齐备；指定维护者设计/冷更批准、真实隔离断网恢复与签名分发链路仍未满足。第二真实账号/Duo/Grok/Android是明确未验收范围，需首版范围负责人接受排除或安排补测。用户无需代跑构建命令或查找模拟器。
