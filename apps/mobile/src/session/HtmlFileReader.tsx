/**
 * 全屏 HTML 阅读器(文件预览的「渲染态」)。
 *
 * agent 产出的 HTML 报告 / 设计稿属于跨端生成物:桌面端点开就进系统浏览器或侧边栏
 * 浏览器(shared/browserOpenableExts),手机端此前只能看源码 —— HTML 落在共享层的
 * SUPPORTED_TEXT_EXTS 里,预览页按文本分派成行号列表。这里补齐渲染态。
 *
 * **不走 OSS 导出,直接把已读到的文本喂 WebView**:
 *   - 取件复用文本预览那条通道(workdir 内 fileBrowser.readFile / workdir 外
 *     text-file:read-preview),一次读取同时服务渲染态与源码态 —— 不为渲染多传一遍
 *     字节、不留 OSS 临时对象、桌面离线时已读过的内容仍在页内;
 *   - 载体是 `source={{ html }}`,origin 为 about:blank(null origin),权限面比桌面
 *     用 `file://` 打开更小。
 *
 * 已知边界:单文件取件不带同目录资源,相对引用的 CSS / JS / 图片解析不到 —— 自包含
 * 页面(内联样式与脚本、`data:` 图)完整可读;多文件站点式产物会缺资源,退路是工具栏
 * 「分享」把文件送到电脑上看。桌面靠 `file://` 的同目录天然没有这个问题。
 * 公网 https 图片 / 字体同样不加载 —— 那是 CSP 关掉出网的代价(见 htmlPreviewCsp)。
 *
 * 导航一律拦下:只放行**同文档锚点**与**首份文档自身的加载**,其余一切明确拒绝、且不交给
 * Linking —— 包含用户主动点击的 http(s) 外链(理由见 interceptHtmlNavigation)。
 * 尤其**不放行替换文档的 `about:blank` 导航**:新文档不会再经过 withHtmlPreviewCsp,
 * 等于把加固过的文档换成一个没有 CSP、没有能力剥离的空文档(review P1)。
 * 出网由 htmlPreviewCsp 在引擎层封锁(导航回调管不到子资源请求)。
 * ⚠️ **不要把这套说成「零出网」**:WebRTC 不受 CSP 管辖,iOS 上仍是残留信道 ——
 * 准确边界与待裁决的取舍见 htmlPreviewCsp 头注的「残留信道」一节。
 * 不挂 onMessage:页面里的 postMessage 无人消费,不给任意生成物开一条通向 RN 侧的通道。
 * Android 另关多窗口:`window.open` / `target="_blank"` 走的是 onCreateWindow,不经过下面
 * 的导航回调,不关掉等于给策略留一个后门(见 setSupportMultipleWindows 处的说明)。
 *
 * ⚠️ `originWhitelist` 必须是 `['*']`,不能收窄成 `['about:blank']`(review P2 实捉):
 * RNW 的 originWhitelist 在 `onShouldStartLoadWithRequest` **之前**生效,被它拒掉的 URL
 * 会被 RNW 交给 RN `Linking` 试着让系统处理 —— 于是 `tel:` / `mailto:` / 自定义 scheme
 * 会拉起外部应用,把下面这段策略整个绕过去。放到 `['*']` 之后,回调是唯一决策点。
 */
import { useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

import { interceptHtmlNavigation } from '@/session/htmlNavigationPolicy';
import { withHtmlPreviewCsp } from '@/session/htmlPreviewCsp';

export function HtmlFileReader({ html, testID }: { html: string; testID?: string }) {
  // CSP 注入放在**渲染载体这一层**,而不是取件那一层:任何进到这个 WebView 的
  // HTML 都必须带策略,不管它有没有同目录资源(见 htmlPreviewCsp 的说明)。
  const guardedHtml = useMemo(() => withHtmlPreviewCsp(html), [html]);
  // 「首份文档已加载完」的闩 —— 之后任何**替换文档**的导航一律拒绝(见
  // interceptHtmlNavigation 的说明)。换 html 时重新开闩。
  const documentSettledRef = useRef(false);
  // 换文档要重新开闩。用「渲染期比对上一份 html」而不是给 WebView 一个 key:
  // key 用长度会在「不同内容同长度」时不重挂(弱判据),用整份 html 当 key 又会让
  // WebView 每次都重建。这里只重置闩,载体不动。
  const lastHtmlRef = useRef(guardedHtml);
  if (lastHtmlRef.current !== guardedHtml) {
    lastHtmlRef.current = guardedHtml;
    documentSettledRef.current = false;
  }
  const interceptNavigation = useCallback(
    (request: ShouldStartLoadRequest) => interceptHtmlNavigation(request, documentSettledRef.current),
    [],
  );
  return (
    <View style={styles.fill} testID={testID}>
      <WebView
        onShouldStartLoadWithRequest={interceptNavigation}
        // 首份文档加载完就上闩:此后 about:blank 这类替换文档的导航不再放行。
        onLoadEnd={() => { documentSettledRef.current = true; }}
        // 见头注:收窄会让 RNW 在回调前把非白名单 URL 交给 Linking,绕过下面的策略。
        originWhitelist={['*']}
        scrollEnabled
        // Android:关掉多窗口(review P1)。留着默认支持时,`window.open(...)` 与
        // `target="_blank"` 会走 onCreateWindow 而**不经过** onShouldStartLoadWithRequest,
        // 于是程序化打开 https 或自定义 scheme 能整个绕过上面的 click 门与 scheme 拒绝。
        // 与仓内其它本地 HTML WebView 一致(mathWebView / mermaidWebView /
        // AnnotationBurnInWebView / ComposerRichInput 都设了这一项)。
        setSupportMultipleWindows={false}
        // Android:关掉 WebView 的 file:// 读取能力(review)。页面是不可信内容,默认允许
        // 时它能用子资源 / iframe 去探测甚至读取 app 沙盒内的本地文件。与仓内
        // ComposerRichInput 一致。(allowFileAccessFromFileURLs /
        // allowUniversalAccessFromFileURLs 默认已为 false,不需显式声明。)
        allowFileAccess={false}
        // iOS:不可信页面不得弹摄像头 / 麦克风权限框,一律拒绝(review 相邻发现)。
        // ⚠️ 这**不是** WebRTC 外传的解 —— 纯数据通道与 STUN 候选收集都不需要媒体权限,
        // 见 htmlPreviewCsp 头注的「残留信道」一节。
        mediaCapturePermissionGrantType="deny"
        // baseUrl 显式给 about:blank,**不能省**:两端默认值不一致 —— iOS
        // (RNCWebViewImpl.m)缺省就是 about:blank,Android(RNCWebViewManagerImpl.kt)
        // 缺省传的是空串给 loadDataWithBaseURL。空串下页内锚点(`<a href="#toc">`)
        // 解析出的 URL 不以 `about:` 开头,会被下面的导航拦截当成外部跳转吞掉,
        // 于是目录锚点在 Android 上点了没反应。显式对齐后两端都解析成
        // `about:blank#toc`,锚点放行、origin 仍是 opaque(不放宽权限面)。
        source={{ baseUrl: 'about:blank', html: guardedHtml }}
        style={styles.fill}
      />
    </View>
  );
}


const styles = StyleSheet.create({
  fill: { flex: 1 },
});
