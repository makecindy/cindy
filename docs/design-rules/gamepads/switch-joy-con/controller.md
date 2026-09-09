# Nintendo Switch Joy-Con 按键位表

基于 `controller.svg` 的 `press-*` 图层生成。`press = hit`；普通图 `controller.png` 不包含 press 图层，调试热图区 `controller-hit.png` 包含全部热区。两张 PNG 均为 2100×2100，SVG viewBox 为 `0 0 1050 660`。

| id | 功能 | press 图层 |
|---|---|---|
| `plus-button` | + 按钮 | `#press-plus-button` |
| `minus-button` | − 按钮 | `#press-minus-button` |
| `capture-button` | Capture 按钮 | `#press-capture-button` |
| `home-button` | HOME 按钮 | `#press-home-button` |
| `l-button` / `zl-button` | L 按钮 / ZL 按钮 | `#press-l-button` / `#press-zl-button` |
| `r-button` / `zr-button` | R 按钮 / ZR 按钮 | `#press-r-button` / `#press-zr-button` |
| `x-button` / `y-button` / `a-button` / `b-button` | A/B/X/Y 按钮 | `#press-face-buttons/press-*-button` |
| `left-stick` / `right-stick` | 左摇杆按钮 / 右摇杆按钮 | `#press-left-stick` / `#press-right-stick` |
| `directional-buttons/*` | 方向按钮（上、右、下、左） | `#press-directional-buttons/press-directional-*` |

热区使用 SVG 中与按键轮廓对应的 path、ellipse、rect 和 polygon。调试图按最新要求不为右侧 A/B/X/Y 按钮添加额外文字标注；按钮本身和热区均保留。

## 官方布局核对

- 左 Joy-Con：− 按钮、左摇杆、方向按钮、Capture 按钮、L 按钮、ZL 按钮。
- 右 Joy-Con：+ 按钮、A/B/X/Y 按钮、右摇杆、HOME 按钮、R 按钮、ZR 按钮。
- A/B/X/Y 位置为：X 上、B 下、Y 左、A 右。
- 右摇杆同时是 NFC 触碰点；它不是额外按键，因此不另建热区。
- SL、SR、SYNC 按钮和玩家指示灯位于 Joy-Con 侧面/导轨。本图为合拢正视图，这些部件不可见，因此未创建虚构图层或热区。
