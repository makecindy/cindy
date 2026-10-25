/**
 * 一次性 PDF utility process 的请求/响应协议。
 *
 * 两个消费方共用同一条进程链路(同一个 forge entry,pdfjs 只打包一份):
 *  - 'extract' : Reviewer 读 PDF 交付物的正文(有字符上限)。
 *  - 'inspect' : cindy_docs 的 inspect_pdf —— 出完 PDF 后回读结构做产出自检。
 */

export interface ReviewPdfTextProcessResult {
  sections: string[];
  pagesInspected: number;
  numPages: number;
  clipped: boolean;
}

/** 单页结构快照。宽高单位是 PDF point(1/72 英寸)。 */
export interface ReviewPdfPageInspection {
  page: number;
  width: number;
  height: number;
  rotation: number;
  /** 该页可提取文本的字符数。 */
  textChars: number;
  /** 文本开头片段,供模型判断"这页装的是不是它以为的内容"。 */
  textPreview: string;
  /**
   * 绘图算子数量。null = 该页算子表读取失败(文件损坏 / 超内存预算),此时不参与
   * 空白判定 —— 读不出来不等于「这页是空的」。
   */
  drawOps: number | null;
  /** 图像绘制算子数量。null 含义同 drawOps。 */
  imageOps: number | null;
  /** 无文本且无任何绘图/图像算子。算子读不出来时恒为 false(不猜)。 */
  blank: boolean;
  /** true = 算子读取不完整,结构检查未完成;false = 算子已成功读取。 */
  visibilityUnverified: boolean;
}

export interface ReviewPdfInspectProcessResult {
  numPages: number;
  pagesInspected: number;
  pages: ReviewPdfPageInspection[];
}

export interface ReviewPdfExtractUtilityRequest {
  kind: 'extract';
  id: string;
  data: Uint8Array;
  maxInputBytes: number;
  maxChars: number;
  maxPages: number;
}

export interface ReviewPdfInspectUtilityRequest {
  kind: 'inspect';
  id: string;
  data: Uint8Array;
  maxInputBytes: number;
  /** 要检查的页码(1 起)。空数组 = 从第 1 页顺序取 maxPages 页。 */
  pages: number[];
  maxPages: number;
  /** 每页 textPreview 的字符上限。 */
  previewChars: number;
}

export type ReviewPdfUtilityRequest =
  | ReviewPdfExtractUtilityRequest
  | ReviewPdfInspectUtilityRequest;

export type ReviewPdfUtilityResponse =
  | {
      kind: 'result';
      id: string;
      ok: true;
      result: ReviewPdfTextProcessResult | ReviewPdfInspectProcessResult;
    }
  | { kind: 'result'; id: string; ok: false; error: string };
