# iOS 应用图标切换验收（2026-11-15）

环境：iOS 27.2 模拟器（Maker RND Acceptance），CN 构建 `com.xd.cindycn`，系统语言中文。

操作路径：

1. 设置 → 应用图标，选择图标；
2. 回到主屏，长按空白处 → 编辑 → 自定义，依次切换「默认 / 深色 / 透明 / 色调」。

## 结果

| 文件 | 内容 |
| --- | --- |
| `settings.jpg` | 设置页四个图标选项：默认 / 黑猫 / Cindy 字标 / Cindy 符号 |
| `system-alert.jpg` | 切换后的系统提示「你已更改“Cindy”的图标。」 |
| `cat-light.jpg` / `cat-dark.jpg` / `cat-clear.jpg` / `cat-tinted.jpg` | 黑猫在四种外观下的主屏图标 |
| `mark-light.jpg` / `mark-dark.jpg` / `mark-clear.jpg` / `mark-tinted.jpg` | Cindy 符号在四种外观下的主屏图标 |
| `wordmark-light.jpg` / `wordmark-dark.jpg` / `wordmark-clear.jpg` / `wordmark-tinted.jpg` | Cindy 字标在四种外观下的主屏图标 |

说明：

- 深色外观下 wordmark / mark 使用各自提供的 dark 素材；cat 只提供一张素材，由系统按同一张图处理。
- 透明 / 色调外观由系统从默认素材派生，三个备选图标都没有单独提供 clear / tinted 素材；
  色调截图统一使用系统 tint 的浅青色（light cyan），以便与透明外观区分。
- 系统提示由 iOS 固定文案，应用无法定制；切换成功与失败都会经过系统提示。
- 四个图标都能切回默认，App 重启后选择保持。
