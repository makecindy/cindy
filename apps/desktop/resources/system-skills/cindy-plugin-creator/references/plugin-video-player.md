# 插件官方视频嵌入（#8128，新增接口，尚未发布）

插件可在详情内容中内嵌官方视频播放器。身份卡声明 `videoPlayers: ["bilibili"]`，
用户在安装／更新时确认后，通过 Host 文档加载：

```html
<iframe title="B 站视频"
  src="/__video_player__/bilibili?bvid=BV1xx411c7mD&page=1"
  style="width:100%;aspect-ratio:16/9;border:0"></iframe>
```

`bvid` 与 `aid` 二选一；`page` 为 1–999，省略为 1。重复、未知或不合法参数返回 400，
未声明或未获批准返回 403。旧 Host 没有这个接口，应明确提示更新，不绕过沙箱、自动
打开另一页面或下载视频。尚未发布，不能宣称已有发布版本支持。

首次只显示播放按钮，点击后才连接 B 站；官方播放器固定 `autoplay=0`，再由用户开始播放。
切分 P 时重新设置外层 iframe 的 src，旧播放器销毁，新分 P 重新等待点击。关闭详情必须
remove 外层 iframe，不能只用 CSS 隐藏。使用 100% 宽与 16:9 比例适应窄屏。

## 声明与存量批准

`videoPlayers` 为最多 8 项的唯一 provider 标识数组；标识为小写字母开头的 1–32 位
小写字母／数字／连字符。首批识别 `bilibili`，未知标识只保留，不授权。Host-only receipt
的 `videoPlayerApprovals` 只保存实际展示并确认过的 provider。旧记录缺字段仍启用原插件，
只拒绝新播放器；旧清单曾含同名未知字段也不能推断授权。同来源更新只保留仍声明部分，
移除后重新声明须重新确认，换来源不继承。

## 安全边界

普通插件页与主 Renderer CSP 不变；仅 Host wrapper 放行精确官方 frame origin。
远程响应强制 sandbox（allow-scripts、allow-same-origin）与 Permissions-Policy。网络闸
依据真实 frame 祖先和当前安装批准版本，仅放行 UI webview 内对应 wrapper 的播放器。
拒绝远程子帧访问 cindy-ghost、localhost、file 或其它宿主接口，不信任 Referrer。
插件逻辑页没有播放器网络能力。按钮的 isTrusted 用于默认交互，不构成批准边界：
插件与 wrapper 同源；最终边界是 Main 的批准、网络与响应策略。

- 入口仅 `https://player.bilibili.com/player.html`，参数由 Host 从视频编号生成。
- 脚本／样式／图片：player 本身与 `s1`–`s3`、`i0`–`i2.hdslb.com`。
- XHR 另允许 `api.bilibili.com`、`*.bilivideo.com`、`*.bilivideo.cn`；媒体只允许上述 bilivideo 子域。
- 全部限 HTTPS、无 URL 凭证、默认端口。拒绝弹窗、下载、全屏、摄像头、麦克风、定位、
  WebSocket、嵌套远程页面及未知来源请求。

播放器沿用插件独立内存分区，不复制浏览器 Cookie，不提供登录流程，不改 Referer、代理
媒体或下载视频作替代。地区、账号、版权与服务状态限制仍由官方播放器决定；插件可保留
原视频链接供用户自行选择。Mobile／远程页面 relay 尚不支持此入口，不承诺同等可用。

## 验证入口

`node apps/desktop/scripts/plugin-video.verify.mjs <证据文件绝对路径>` 启动临时独立 Electron，
使用生产播放器文档与请求判据，连接官方站点。不会启动、替换或重启 Cindy。
它与 adapter 单测共同验证策略，不等同完整 Cindy UI 安装流程验收。
