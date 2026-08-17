export interface ReviewPdfTextProcessResult {
  sections: string[];
  pagesInspected: number;
  numPages: number;
  clipped: boolean;
}

export interface ReviewPdfUtilityRequest {
  kind: 'extract';
  id: string;
  data: Uint8Array;
  maxInputBytes: number;
  maxChars: number;
  maxPages: number;
}

export type ReviewPdfUtilityResponse =
  | { kind: 'result'; id: string; ok: true; result: ReviewPdfTextProcessResult }
  | { kind: 'result'; id: string; ok: false; error: string };
