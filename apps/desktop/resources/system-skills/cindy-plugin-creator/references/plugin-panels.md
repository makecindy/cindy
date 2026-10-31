## 5. 面板(panel.html/css/js)

- 显示形态由 `panel.position` 决定:`left`(缺省)/ `right` / `top` / `bottom` =
  **右侧栏常驻面板**——插件启用后自动成为聊天区对应边页签组里一个不跟对话的全局页签,
  切任务时留在原位,用户可以把它拖到任何一边、最大化、弹成独立 OS 窗口或关闭(关闭后
  在右侧栏「+」菜单或插件详情页可重新打开;用户放置过后主机记住用户的位置,声明只是
  首次出现时的默认);`"tab"` = **插件页内的独占面板**——由插件页
  自己承载(不进右侧栏页签容器):用户在插件页点你这张卡的「使用」按钮打开,
  同一时刻至多一个,**用户离开插件页即关闭卸载**(面板收束,2026-08-02 定案:
  插件面板不再常驻右侧栏干扰其它会话)。从插件页导入 tab 型插件后，宿主会
  直接启用并打开它的面板；从拖入或双击等其它入口安装后，用户可再从
  插件页点「使用」打开。
  停用/卸载插件同样立即关闭面板。页签形态没有拖缝宽度语义,声明 `minWidth` /
  `defaultFraction` 会被拒装。两种形态的面板代码完全一样(同一 panel.html,
  供片/主题/媒体规则不变),只是宿主容器不同;此形态请把界面做成自适应宽度,
  并且**不要假设自己会在后台长期存活**——每次打开都可能是全新加载,状态要
  自己持久化(见 §4.6 的偏好存储);
- 右侧栏常驻形态的**页签与标题由主机绘制**:页签标题取 `panel.title`,关闭 /
  最大化 / 弹出窗口等控件由右侧栏统一提供,面板代码全程零感知。你的 panel.html
  只画内容区,**不要自己再画一条标题栏**。历史字段 `systemButtons` 仍可声明
  (兼容旧包,当前不生效;`position:"tab"` 由插件页自绘头,声明本字段拒装);
  面板宽度随页签组,请把界面做成自适应宽度;
- 与电子脑同源,用 `BroadcastChannel('<自定名>')` 通信(电子脑发,面板收);
- 取自己的媒体:`cindy-ghost://<id>/media/<指纹><后缀>`(主机查账验归属,别人的图 404);
- 重启回放:`fetch('cindy-ghost://<id>/gallery')` 返回本插件作品清单 `[{src, caption}]`;
- 唤醒电子脑:`fetch('cindy-ghost://<id>/wake')`(幂等,已在跑立即返回,回
  `{state}`)。电子脑是按需拉起的,面板刚打开时它多半没在跑、广播没人听;
  面板交互要经电子脑干活(BroadcastChannel 递活再转 cindy-request)时,先
  fetch 一次 /wake 叫醒,再广播请求,并按 reqId 每几百毫秒重发直到收到电子脑
  回执(电子脑侧记得按 reqId 去重)。只能叫醒自己;沉睡/熔断态叫不醒;
- 点开看大图/播放:把 `<img>` 或视频缩略(`<video muted>` 记得配
  `style="pointer-events:none"` 让点击落在链接上)包进
  `<a href="cindy-ghost://<id>/preview/<指纹><后缀>">`(即把 /media/ 换成
  /preview/),用户点击时主机按媒体类型弹统一 lightbox:图片(缩放/标注/另存)
  或视频播放器。主机查账验归属;需用户真点击(面板持焦点)才弹,脚本自动跳转
  会被静默忽略,不要用它做任何"主动弹窗"。按此写法的媒体 cell 主机还免费送
  右键菜单(复制文件 / 打开所在目录,与聊天里的媒体右键同款),面板零改动。
- 拖进聊天:面板图片和视频都可被用户拖进聊天输入框落为附件(主机查账验归属;
  图片落图片附件给模型看,视频落文件附件、发送时以文件路径交给 AI 处理)。
  给可拖元素挂 dragstart 把自己的 /media/ 地址塞进 uri-list 即可:
  `el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/uri-list', src))`
  (直接拖上面那个 /preview/ 链接也认)。落进的只是附件托盘,发不发由用户决定。
  建议同时 `e.dataTransfer.setDragImage(imgEl, offsetX, offsetY)` 用缩略图当拖影
  ——不设的话拖链接的默认拖影是一条 URL 文字,很丑。视频缩略的拖影把首帧画进
  canvas(`<video>` 元素直接当拖影常拍成黑块)。
- 主题:直接用主机注入的 CSS 变量并给回退值,如 `var(--panel-bg, #f7f7f5)`、
  `var(--surface, #f7f7f5)`、`var(--text-primary, #1a1a1a)`、
  `var(--border-default, #e4e4e0)`;面板/侧边栏背景用 `--panel-bg`(已注册,
  alias 到 --surface,与宿主面板同源);
- **明暗档主机已代你声明**:注入块里带了 `color-scheme: light|dark`(跟宿主主题
  实时切),所以你不写一行样式,原生控件(滚动条、`<input>`/`<select>`/复选框、
  日期选择器)也会落在正确的明暗档上。别自己写死 `color-scheme`,否则暗色主题下
  这些控件会反档;真要覆盖就跟着主机主题一起换;
- 滚动条统一规范:12px 槽 + 6px 圆角 thumb,滚动时加 `.is-scrolling` 显形
  (颜色用 `var(--msg-scrollbar)` / `var(--msg-scrollbar-hover)`),2 秒无活动移除。

### 可选的 Mac 原生双指输入

需要真实双触点的平面画面（例如设备模拟器）可在顶层页面声明
`<meta name="cindy-native-trackpad" content="touch">`，并在实际交互元素上加
`data-cindy-trackpad`。支持此能力的 Mac 宿主只在页面聚焦、鼠标位于该元素时，将
AppKit 的两指位置投递为标准 Touch/Pointer 事件，嵌套 iframe 同样适用。
元素应设 `touch-action:none` 并处理结束、取消和失焦；不需要 preload、消息桥或新权限。
落指中心取鼠标位置，触控板宽度对应元素长边，两轴按触控板物理比例等比映射，超出元素边缘的触点裁剪。
边缘不累计越界位移，反向移动立即生效。
第三指交回系统；原生序列不重复投递 wheel/magnify。旧宿主、非 Mac、原生模块不可用
或页面正在被其他调试会话占用时不启用；保留原有 wheel 兼容逻辑，不能假定所有宿主都有。

对连续输入可使用 `data-cindy-trackpad="contacts"`：处理元素上的 `cindy-trackpad`
事件，`detail` 为 `{phase,touches:[{id,x,y}]}`，坐标相对元素所属 frame 的 viewport。
`begin/change/end/cancel` 对应落指、移动、结束、取消；touches 是全部仍按下的手指。
一次事件必须同时更新所有触点再发送，避免先产生单指手势；结束/取消必须释放输入。
标准 Touch/Pointer 处理仍需保留，供不支持整帧投递的宿主使用。


### 插件官方视频嵌入（#8128，尚未发布）

显式 videoPlayers 声明与独立批准后，仅 Host 播放器文档可嵌入官方播放器。
普通插件页与主 Renderer CSP 不变。作者接口、精确资源域、安全与存量兼容边界见
[官方视频嵌入契约](plugin-video-player.md)。
