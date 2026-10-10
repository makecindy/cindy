# Android 紧凑横卡：尺寸根因与原生验收（2026-10-02）

## 根因与证据边界

用户指出的比例问题成立。旧图不是 PNG 缩放导致：`dumpsys appwidget` 明确宿主为 `com.android.launcher3`，额度卡由 `org.cindy.quota.validation` 的生产 AppWidget 副本提供；不是 FixtureActivity 全屏预览。正式 Cindy 包为 `com.xd.cindy`，与隔离测试包区分。所有额度/计划/Extra resets截图均为fixture，未登录真实Android账号。

专用AVD仍为Pixel9 profile / Android16 API36 ARM64，1080×2424、420dpi，font_scale=1.0，无size/density override。没有更改用户设备全局密度、桌面网格、iOS确认稿或iOS登录。

旧配置虽写target5×2，但minResizeHeight=184dp把网格最小高度抬高，真实旧分配为382.095×439.238dp。根RemoteViews同时match_parent+center_vertical，背景填满1153px高度，演示标题额外占高，所以出现大片内部留白。

## 修复

- 默认5×2；本Launcher五列，实测4×2只有303.238dp宽，低于两列32sp主数值+14sp次级及原内边距所需356dp，不缩字伪装成双列。其他Launcher应以实际dp适配，不能把5×2当通用像素尺寸。
- minWidth=356dp、minHeight=164dp给旧API的初始内容尺寸；minResizeWidth=180dp、minResizeHeight=80dp按网格约束分开设置。API31+目标占格与legacy尺寸不是同一个概念。
- 卡片背景随内容wrap_content，不把Launcher额外分配空间画成巨大空白卡。卡片内top对齐；系统仍决定AppWidget在网格里的位置。**桌面占格与可见背景高度分别报告，不把透明的宿主占位说成已释放。**
- 32sp主百分比、14sp次级、12sp品牌/套餐、42dp环与4.5dp线宽、真实图标及语义色保留。品牌区共用46dp最小高度（随字体缩放），解决长套餐导致一列下移2px。三行信息共同基线。
- 布局容量统一计算，预留真实“Enlarge for all”提示空间。测试标签移至验收页及测试Activity，不再在生产卡内添加Demo标题。额度语义、时间小写和Extra resets不变。

Android官方依据：[弹性小组件布局与网格尺寸](https://developer.android.com/develop/ui/views/appwidgets/layouts)。targetCell决定新系统默认格数，minResize等约束及Launcher单元格实际尺寸仍影响最终分配；新添加和已有实例必须分别验证。

## 本机实际测量

| 情况 | Launcher分配／占格 | 可见卡片 |
|---|---|---|
| 旧版 | 382.095×439.238dp，旧实例三行 | 1003×1153px，即约382×439dp |
| 本轮默认新添加 | 系统确认5×2，382.095×288.762dp | 1003×428px，即约382×163dp |
| 拖窄至最小 | 系统回报width3 height2，约224.38×288.76dp | 589×482px，单列并提示放大 |
| 实际试加4×2 | 303.238×288.762dp | 单列；不足以保留当前字号并排两家 |

不裁PNG、不改屏幕密度：日夜图均为完整1080×2424桌面，底部系统图标作为比例参照。新卡可见高度由1153px降至428px（减少约63%）；网格占用由三行降为两行，仍由Launcher保留两行空间。

截图与UI树逐项核对：两列主行y456..556、次行y556..611、第三行y611..658一致；左列x81、右列x582固定，各自共享左边缘。100%+6d 23h、5h 4h 59m、SuperGrok Heavy、0及unknown在本次默认尺寸不裁切；长套餐和普通套餐卡片同高。Grok长套餐仅为布局fixture，不证明真实服务返回周窗口。

已实际从桌面默认添加、纵向三行缩至两行、横向5列缩至3列、尝试继续缩高受两行下限约束、再恢复5×2；不是只手工写options或仅检查XML。

## 构建与回归

```sh
source .build/widget-android-validation/android-env.sh
cd apps/mobile/android
./gradlew :app:assembleDebug :cindy-quota-widget:testDebugUnitTest \
  -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2
```

完整Cindy debug APK和原生模块构建成功并安装。通过系统Widgets → Cindy → Add实际添加正式包空态：系统显示5×2，`com.xd.cindy:id/quota_root`为1003×428px；非测试Activity，未给正式包写演示数据。Android JVM **9 tests / 0 failures**，新增紧凑容量/缩放边界回归。Mobile原生插件集成**10项通过**，Mobile typecheck通过。隔离APK重建，生产Kotlin/资源复制一致；设备instrumentation **38项通过**。本轮不把旧全量测试冒充新head全量结果。

额外执行的 `pnpm check:dev-docs` 为9/10通过：唯一失败是旧未跟踪研究素材 `docs/assets/quota-widget-art-study/references/widgets.md` 引用缺失的 `cost-reporting-periods.md`。该历史素材不在Git索引和本次提交中，未删除、改写或通过排除测试掩盖失败。本次文档及截图链接已核对。

[白天完整原生截图](Android-Compact-Day.png) · [深夜完整原生截图](Android-Compact-Night.png)。其余状态、尺寸测量、构建日志及自包含平铺HTML在本任务同名资产目录交付；界面图片为原生截图，HTML只是证据容器。

## 未验证与维护者门槛

本轮验证竖屏AOSP Launcher；横屏、其他Launcher/手机密度、大字体完整机型矩阵仍需补，不承诺所有网格都能双列。真实Android登录/账号切换/源同步/真实断网未验证，不把fixture当实测。无新授权或凭据读取。原生资源更改仍需冷更/设计把关，PR保持draft；未merge、发布或改生产签名。
