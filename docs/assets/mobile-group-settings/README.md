# 移动端群设置验收截图

2026-10-12，Android AVD `Cindy_Teammate_PR5710 / emulator-5562`，Global Debug。
代码提交 `372602b4c`；对齐最新 main 后补拍，后续截图提交仅更新本目录，不修改应用代码。
工作区 `Cindy-feat-mobile-group-settings-management`，Metro 来自该工作区 `apps/mobile`、端口 8081。

- [已连接浅色](android-connected-light.png) / [已连接深色](android-connected-dark.png)：设备名、弱化状态文字与绿点；名称和添加入口 enabled。
- [已断开深色](android-disconnected-dark.png)：名称、两条实际成员行和添加入口 disabled，重连入口 enabled；恢复网络后重新 Connected，名称/添加可用。
- [开发构建标记](android-build-label.png)：实际运行页面显示该分支与 `372602b4c`。

原始截图由 `adb exec-out screencap -p` 采集，没有图像编辑。
安卓正常 Gradle Debug 构建和保留数据安装完成；APK 指纹 `bb9b4db1efe43a00f6214348e8b544c5b234d26a`，与 Expo 实际构建使用的 `createFingerprintForBuildAsync` 独立重算一致。
通用 fingerprint CLI 与实际构建入口对 Expo config 的读取结果不同，未以不一致的 CLI 哈希冒充安装包匹配。

本轮未修改群名称、成员或历史；未在最终代码执行真实保存、添加/移出或归档。iOS 最终复验未执行，保留其他应用的测试现场。
