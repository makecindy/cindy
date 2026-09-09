# Nintendo Switch Pro Controller 键位表

文件结构与 XBOX 参考一致：`controller.svg`、`controller.png`、`controller-hit.png`、`controller.md`。

- 画板：`viewBox="0 0 1050 660"`
- `controller.png` 为普通图，不包含 `press` 图层。
- `controller-hit.png` 为带热区的调试图，包含蓝色半透明热区和深蓝功能标注，尺寸为 2100×2100。
- `controller.svg` 中的 `press-*` 图层与热图按键一一对应。

| 官方名称 | 内部 ID | SVG 热区 |
|---|---|---|
| ZL / ZR Buttons | `ZL` / `ZR` | `#press-ZL` / `#press-ZR` |
| L / R Buttons | `L` / `R` | `#press-L` / `#press-R` |
| SYNC Button | `sync` | `#press-sync` |
| − Button / ＋ Button | `minus` / `plus` | `#press-minus` / `#press-plus` |
| Capture Button / HOME Button | `capture` / `home` | `#press-capture` / `#press-home` |
| X / Y / A / B Buttons | `X` / `Y` / `A` / `B` | `#press-face` 下对应热区 |
| Left Stick Button / Right Stick Button | `left` / `right` | `#press-stick-left` / `#press-stick-right` |
| + Control Pad（Up/Down/Left/Right） | `dpadUp/Down/Left/Right` | `#press-dpad` 下对应热区 |

NFC 触碰点、USB Type-C 接口和 Recharge LED 是功能组件，不是游戏输入按键，因此没有独立 press 热区。
