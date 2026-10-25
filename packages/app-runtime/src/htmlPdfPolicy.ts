import type {DocsPdfRenderInput,DocsPdfRenderOutput,RenderHtmlToPdfFn} from '@cindy/mcps';


/**
 * 渲染窗视口。只影响 CSS 视口宽度(媒体查询、百分比布局),不影响最终纸张尺寸
 * —— 纸张由 printToPDF 的 pageSize 决定。给一个接近 A4 96dpi 的宽度,让没写
 * 打印样式的普通网页也能排出正常的行长。
 */
export const RENDER_VIEWPORT = { width: 1024, height: 1440 };


/**
 * PDF 排版窗只允许读取 data/blob URL 与 about:blank;本地 file:// 子资源也拒绝。
 * 外部网络请求一律取消:即便不读取响应,图片/字体/iframe 也能借用户网络身份探测
 * localhost/内网或触发第三方跟踪副作用。需要远程资源时由模型先转成 data URI。
 */
export async function isAllowedResourceUrl(
  requestUrl: string,
  entryUrl: string,
  resourceType?: string,
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:') {
    return true;
  }
  // loadFile() itself is a trusted top-level entry prepared by this renderer.
  // Only that exact main-frame URL is exempted; page-initiated file: subresources
  // remain blocked and cannot reopen a path after the security check.
  if (resourceType === 'mainFrame' && requestUrl === entryUrl) return true;
  // Never let Chromium reopen a user-controlled file path after this check.
  // Task-directory resources are converted to data: snapshots by the MCP tool
  // before this host receives the HTML bytes.
  if (parsed.protocol === 'file:') return false;
  return false;
}
export function createHtmlPdfRenderer(renderOnce:(input:DocsPdfRenderInput)=>Promise<DocsPdfRenderOutput>){


/**
 * 同刻并发上限 1。printToPDF 走的是完整 Chromium 排版 + 光栅化,并发开多个隐藏
 * 窗口在低配机器上会把主进程拖到卡顿;文档生成本来就不是高频操作,排队即可。
 */
let renderChain: Promise<unknown> = Promise.resolve();


/** 供测试断言排队行为:当前是否有渲染在跑。 */
let activeRenders = 0;


function __getActiveRenderCount(): number {
  return activeRenders;
}


/**
 * HTML → PDF。串行执行(同刻 1 个渲染窗),失败抛错由 MCP 工具层翻成
 * RENDER_TIMEOUT / RENDER_FAILED。
 */
const renderHtmlToPdf: RenderHtmlToPdfFn = (input) => {
  const start = async (): Promise<DocsPdfRenderOutput> => {
    activeRenders += 1;
    try {
      return await renderOnce(input);
    } finally {
      activeRenders -= 1;
    }
  };
  // 成功与失败都接同一个 start:前一次渲染失败不该拖垮排在它后面的这次。
  const run = renderChain.then(start, start);
  // 链上只保留「已结束」这一个信号,错误由各自的调用方 await 拿到 —— 不 catch 的话
  // 这条内部链会变成一个没人处理的 rejection。
  renderChain = run.catch(() => undefined);
  return run;
};
return {renderHtmlToPdf,__getActiveRenderCount};
}
