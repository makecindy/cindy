# Android AppWidget 隔离验证包

使用生产 Kotlin / RemoteViews / 生成资源；独立 applicationId `org.cindy.quota.validation`，不含登录入口、网络权限或真实账号。**不能代替完整 Cindy App 或真实额度同步验收**。修改生产文件后重新 prepare。

需已经安装且获用户许可的 Android SDK 36、build-tools 36.0.0、JDK17、Gradle9.3.1，以及一个已授权测试设备。工具不安装 SDK、不接受许可、不启动/重置设备。

```sh
node tools/quota-widget-android-fixture/prepare.mjs
gradle -p .build/quota-widget-android-fixture assembleDebug --no-daemon --max-workers=2
adb -s <测试设备序列号> install -r .build/quota-widget-android-fixture/build/outputs/apk/debug/QuotaWidgetValidation-debug.apk
adb -s <测试设备序列号> shell am instrument -w org.cindy.quota.validation/expo.modules.cindyquotawidget.ContractInstrumentation
adb -s <测试设备序列号> shell am start -W -S -n org.cindy.quota.validation/expo.modules.cindyquotawidget.FixtureActivity --es state long
```

在测试 App 点击 Add test widget，在系统 Launcher 确认添加。验收页、图注与文件说明必须标明 **Android 模拟器／fixture**；测试 Activity 保留 DEMO DATA 标识，但生产卡片不额外插入测试标题改变实际高度。状态：`partial / long / zero / unknown / stale / offline / unauthorized / missing-plan / missing-window / long-plan / clear`。`long-plan` 仅验证 Grok 图标与长文本，不证明 Grok 真实服务返回周额度。

`-S` 只重启本隔离包以执行新状态，不应对已登录的真实 Cindy App 使用。`clear` 调用生产清空函数；不是实际用户登出测试。仪器测试检查 38 条数据/图标/存储边界并清空本包缓存，之后重新打开所需 fixture。

可在**专用测试设备**的系统设置改日夜和字体缩放，再重开 fixture；验证完成恢复默认。Launcher 长按小组件的缩放手柄验证横向/纵向切换。尺寸太小或大字体容不下全部供应商时明确提示放大，不缩小文字伪装通过。

`--es state inspect` 只读展示本隔离包的真实 AppWidget ids、target cells 和 Launcher options（dp），不写额度、不修改尺寸。默认/拖拽验收需同时记录 host 占格与可见卡片边界；包升级不会自动缩小 Launcher 已分配的旧格子，须实测重新添加。
