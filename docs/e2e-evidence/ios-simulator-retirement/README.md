# 内置 iOS 模拟器下线提示：Desktop DEV 实机截图

2026-10-03，macOS Electron DEV；`retire-ios-simulator`，基线 `d460df8c17` 加本 PR 改动。使用专属命名隔离沙箱和“跳过登录”，没有复用正式用户数据。

安装状态为人工构造的、已批准且原先启用的旧插件磁盘记录。旧插件入口文件为空，未运行旧代码或模拟器；实际 `GhostManager` 识别安装、投影下线状态，实际插件页面负责渲染。截图不是独立 HTML 原型，也未替换 Renderer 的桥接返回值。

1. [插件列表（深色）](01-plugin-list-dark.png)：旧卡片显示“已下线”和“查看说明”，卡片及左侧插件入口有未读点。
2. [下线详情（深色）](02-retirement-detail-dark.png)：点击“查看说明”进入详情，显示 Baguette 推荐、安装入口、暂不迁移及数据说明。实际安装记录回读 `eligible=true, unread=false, enabled=false`；打开详情清除提醒。
3. [下线详情（浅色）](03-retirement-detail-light.png)：通过现有主题偏好切换并重新加载；下线详情保持，未读标记仍为 false（`unread=false`），无重复提示。明暗模式目检未见遮挡或溢出。

没有进行真实市场下载安装、Baguette 设备操作、完整发布构建或 Windows 实机验证。未安装与已停用的资格规则由定向测试覆盖，不把此单一旧启用样例当作所有状态实测。
