# 插件设置本机外观（开发中）

此接口尚未发布，先按目标 Cindy 构建确认 `cindy.ui?.appearance` 存在。
它只作用执行插件的 Desktop 本机，不增加手机或远端能力，不操作 OS 壁纸／字体。
不需要 SDK 或 helper。选择、预览、定时切换和配置页面由插件实现。
贡献的隔离页面也可使用同一 `cindy.ui.appearance` 接口；保存的消息／工具展示页面只读。

## 声明和调用

在 `ghost.json` 中声明允许读取和修改的字段；安装／更新沿用原批准入口。
包内资源必须声明安全相对路径，资源 ID 在本实例内唯一。

```json
{
  "ui": {
    "version": 1,
    "appearance": {
      "fields": ["wallpaper", "uiFont", "codeFont", "bodyFont", "theme", "reading", "contentStyle"],
      "resources": [
        {"id": "regular", "kind": "font", "path": "assets/regular.ttf"},
        {"id": "background", "kind": "image", "path": "assets/background.webp"},
      ]
    }
  }
}
```

```js
const appearance = cindy.ui?.appearance;
if (appearance) {
  const before = await appearance.read();
  const result = await appearance.set({
    wallpaper: { resource: 'asset:background', visibility: 0.7, blur: 2 },
    bodyFont: { resource: 'asset:regular', size: 16 },
    reading: { bodyLineHeight: 1.8, maxWidth: 760 }
  }, { ifRevision: before.revision });
  // applied 表示目标已应用：页面外观由查看窗口确认。
  // saved 是已保存但尚无应用确认，failed 是应用失败。
  console.log(result.application.status);
}
```

`read()` 只投影声明过的字段，不返回安装路径或其他插件的资源引用。
未显式配置的正文、内容样式、阅读和主题字段省略，继续沿用宿主默认值。
`set(patch, {ifRevision?})` 只修改给出的子字段。`ifRevision` 可防止异步准备资源时覆盖更新的设置；
冲突返回 `APPEARANCE_CHANGED`，插件自行决定是否重新读取，宿主不重放写入。
宿主最多同时处理两次外观写入，超出返回 `APPEARANCE_BUSY`，不排队；一次 patch 可合并多个字段。
`reset(['reading', ...], {ifRevision?})` 删除点名字段的 override，重新跟随当前默认值，保留其他设置。
读取外观不等于取得宿主页面 DOM 或任意 CSS 权限。

## 字段、单位与消费位置

| 字段 | 可写值 | 实际作用 |
| --- | --- | --- |
| uiFont | family 或 resource、size 12–24 px、weight 100–900、style normal／italic | 原 UI 字体和字号；原字形回退保留 |
| codeFont | 同上，size 10–24 px | 原代码字体／字号，登记消息区的代码字重与字形；不改终端 |
| bodyFont | 同上，size 12–28 px | 登记消息正文区域，保留标题和粗体等正文语义 |
| wallpaper | resource、fallbackResource、visibility 0–1、blur 0–20 px、motion static／dynamic | 原本机壁纸设置和背景画布；fallbackResource 与 resource 一起提供 |
| reading | bodyLineHeight 1.2–2.4、codeLineHeight 1.1–2.4、maxWidth 320–1400 px | 登记消息正文／代码的行距和最大阅读宽度；宽度不超过容器 |
| contentStyle | messageGap 0–48 px、messagePadding／messageRadius 0–32 px | 登记消息区域的间距、内边距和圆角 |
| theme | light／dark 中的 text、secondaryText、surface、border、userBubble、userText、assistantBubble | 登记消息区域的语义色和气泡；颜色只接受 #RRGGBB |

`family` 是字体名称；`resource` 是自有字体文件引用，二者不同时指定。
字体、壁纸设置沿 Desktop 原有 profile 设置所有者保存；不建立另一套可写偏好。
主题覆盖只作用登记的内容区域，不修改当前主题家族／明暗模式、登录、权限弹窗或宿主操作入口。
界面元素显隐通过下面的独立接口控制；不开放任意私有 Token、成品配置编辑器或跨设备同步接口。

## 资源与结果

资源引用支持 `asset:<声明ID>`、`library:<本插件相对路径>` 和本插件可读的 `cindy-media://blobs/...`。
Library 和媒体访问继续按原绑定及归属校验；裸路径、任意 URL、其他插件资源均不接受。
资源 kind 使用 font、image、video。字体只接受 TTF／OTF，单文件最多 10 MiB，先校验 SFNT 边界，再由浏览器字体解码器校验。
壁纸 PNG／JPEG／WebP 最多 20 MiB、40 百万像素，沿原图片准备入口生成受管 WebP；MP4 最多 100 MiB。
字体保留宿主缺字回退，加载失败保持可读。MP4 可带静态图片回退，隐藏窗口／减少动态效果沿原播放规则。

壁纸进入原 `client-wallpaper` 媒体作用域，原设置引用和回收同时保护静态回退。
停用／卸载／换源或账号边界使旧资源失效；用户后来手动替换的字体和壁纸不会被旧插件清理。
无查看窗口、应用未确认或被后续设置覆盖时返回 saved；不得将它显示为“已生效”。
set 跨资源准备和原设置入口，不承诺多份文件的业务事务；失败后通过 read 查看实际保存值，不自动重试。

## 界面元素显隐

在 `ui.appearance.fields` 中加入 `"visibility"` 后，逻辑页和贡献的隔离页面可以使用
`cindy.ui.visibility`；保存的消息／工具展示页面只可读取。它只操作当前 Desktop 窗口：
逻辑页使用当前活动的主窗口或完整会话窗口，隔离页面使用所在的这类窗口。工具独立窗口等未接入此接口；没有可用窗口时调用失败。

```js
const visibility = cindy.ui?.visibility;
if (visibility) {
  const before = await visibility.read();
  const result = await visibility.set({ workspace: false });
  // applied 表示查看窗口确认已应用；unconfirmed 表示未收到显示确认。
  console.log(before.workspace, result.application.status);
  // 插件自行决定何时恢复，例如在自己的命令或快捷键中调用。
  await visibility.set({ workspace: true });
}
```

`set` 接收一个或多个名称，值为 `true` 显示、`false` 隐藏：`sidebar` 应用左侧栏（包括设置页侧栏）、`header` 顶部栏、
`messages` 对话消息区、`composer` 输入框、`tools` 工具区、`windowControls` 窗口按钮，
`workspace` 整个工作区。整页隐藏时，已有壁纸作为背景；没有设置壁纸时显示原背景。
各区域受工作区总开关控制；插件原生入口已打开的弹层会关闭，恢复后可从原入口重新打开。
登录和现有权限交互继续显示。名称只控制对应的已有区域，不提供任意 DOM／CSS 操作。

`read()` 返回各项独立设置；`true` 表示插件未隐藏该区域，侧栏或工具区原有的折叠状态保持不变。整页隐藏时，各项值保留，重新显示工作区后继续生效。
同一元素以最后一次设置为准，显示该元素会移除之前的隐藏设置。显隐是窗口内的临时状态；
插件停止、被停用或窗口关闭时释放该插件留下的隐藏状态。插件需要记住配置时，自行保存并在运行时重新应用。
