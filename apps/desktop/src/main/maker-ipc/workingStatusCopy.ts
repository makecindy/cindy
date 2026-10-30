import { hasPublicWorkingSubject, type WorkingPhase } from '../../shared/workingStatus.js';
import { validateTitleOutput } from '../maker-host/title-output-validation.js';

const ACTIONS: Record<Exclude<WorkingPhase, 'compacting'>, string> = {
  thinking: 'Reasoning is active. The subject is unknown.',
  replying: 'Writing the reply. Its content is unknown.',
  processing: 'Work is still in progress. The specific action is unknown.',
  'reading-memory': 'Reading or searching saved long-term memory. Its content is unknown.',
  'saving-memory': 'Writing long-term memory. Its content is unknown; success is not yet confirmed.',
  'deleting-memory': 'Deleting long-term memory. Its content is unknown; success is not yet confirmed.',
  'organizing-memory': 'Consolidating long-term memory entries. Their contents are unknown; success is not yet confirmed.',
  'reading-file': 'Reading a file. Its name and content are unknown.',
  'saving-file': 'Writing or editing a file. Its name and content are unknown; success is not yet confirmed.',
  searching: 'Searching the web for information. The query and sources are unknown.',
  'reading-web': 'Reading a web page. Its address and content are unknown.',
  'searching-files': 'Searching or listing files. Names, paths and search terms are unknown.',
  testing: 'Running tests. Test names and results are unknown.',
  checking: 'Running code checks. Results are unknown.',
  'reviewing-memory': 'Checking long-term memory. Its content and the outcome of any preceding memory action are unknown.',
  'reviewing-files': 'A file operation has returned. Reviewing its feedback; file names, contents and success are unknown.',
  'reviewing-sources': 'A web lookup has returned. Reviewing its feedback; sources, contents and success are unknown.',
  'reviewing-checks': 'Tests or code checks have returned. Reviewing their feedback; pass or fail is unknown.',
};

export const WORKING_STATUS_COPY_INSTRUCTIONS = [
  'Write one short, natural activity caption for an assistant that is currently working.',
  'Use the requested UI language. Be brisk, warm and lightly playful, never cutesy.',
  'Use only the supplied execution fact. No private reasoning, results, progress estimates, promises or invented subjects.',
  'Describe an ongoing action, never completion or success. Do not imply that unknown contents are preferences, posts or any particular topic.',
  'Do not reveal tool names, model names, commands, paths or technical internals.',
  'Previous caption is wording context only, not evidence about the current action.',
  'Keep the specific public subject in the caption: memory, files, web pages, tests or code checks. Never replace it with generic busy copy such as Working through it now, Working on it, or 正在处理.',
  'Write like a fluent colleague, not a system log. Never mention an operation, feedback, something returning, or what came back. Describe the human activity: checking a memory entry, looking through files, checking web sources, or reviewing tests.',
  'Prefer a natural concrete action over filler words like now, currently, just, a bit or 一下. Do not randomly rotate synonyms.',
  'For example, saving memory can be “把这件事记下来…”; reading memory can be “翻翻之前记下的事…”.',
  'Keep Chinese/Japanese/Korean to about 16 characters, English to about 8 words. At most 64 characters in any language.',
  'Return only the caption, without quotes, markdown, emoji, explanation or multiple alternatives.',
].join('\n');

export function workingStatusPrompt(phase: WorkingPhase, locale: string, previous: string | null): string {
  return JSON.stringify({ language: locale, execution: phase === 'compacting' ? undefined : ACTIONS[phase], previousCaption: previous });
}

export function validateWorkingStatusCopy(raw: string, phase?: WorkingPhase): string | null {
  const text = validateTitleOutput(raw, 64);
  if (!text || /[<>`/\\\n\r\p{Cc}\p{Cf}]|https?:|mcp__|\b(?:tool|function|API)\b/iu.test(text)) return null;
  // Definite completion/progress claims are never appropriate in busy chrome.
  if (/\d|已(?:经|完成|保存|找到|写入|記|记)|完成了|记住了|記住了|保存好了|搞定|成功|马上就好|\b(?:done|completed|finished|saved|stored|remembered|found|updated|successfully|percent)\b/iu.test(text)) return null;
  if (/已(?:删除|刪除|合并|合併|整理)|删除了|刪除了|合并了|合併了|整理好了|\b(?:deleted|removed|consolidated|organized|organised)\b/iu.test(text)) return null;
  if (phase && !hasPublicWorkingSubject(phase)) return null;
  const subject = phase && SUBJECTS[phase];
  if (subject && !subject.test(text)) return null;
  if (/\b(?:feedback|operation|came back)\b|操作反馈|操作回饋/iu.test(text)) return null;
  return text;
}

const SUBJECTS: Partial<Record<WorkingPhase, RegExp>> = {
  'reading-memory': /memor|remember|记|記|憶|覚|기억/iu,
  'saving-memory': /memor|remember|记|記|憶|覚|기억/iu,
  'deleting-memory': /memor|remember|记|記|憶|覚|기억/iu,
  'organizing-memory': /memor|remember|记|記|憶|覚|기억/iu,
  'reviewing-memory': /memor|remember|记|記|憶|覚|기억/iu,
  'reading-file': /file|code|文件|档案|檔案|代码|代碼|ファイル|コード|파일|코드/iu,
  'saving-file': /file|code|文件|档案|檔案|代码|代碼|ファイル|コード|파일|코드/iu,
  'searching-files': /file|code|文件|档案|檔案|代码|代碼|ファイル|コード|파일|코드/iu,
  'reviewing-files': /file|code|文件|档案|檔案|代码|代碼|ファイル|コード|파일|코드/iu,
  searching: /web|page|source|search|网页|網頁|资料|資料|搜索|搜尋|ウェブ|ページ|検索|웹|페이지|검색/iu,
  'reading-web': /web|page|source|网页|網頁|资料|資料|ウェブ|ページ|웹|페이지/iu,
  'reviewing-sources': /web|page|source|网页|網頁|资料|資料|ウェブ|ページ|웹|페이지/iu,
  testing: /test|测试|測試|テスト|테스트/iu,
  checking: /check|code|检查|檢查|代码|代碼|チェック|コード|검사|코드/iu,
  'reviewing-checks': /test|check|测试|測試|检查|檢查|テスト|チェック|테스트|검사/iu,
};

type Generate = (phase: WorkingPhase, previous: string | null, signal: AbortSignal) => Promise<string | null>;

/** One attempt per semantic phase per product turn, independent of tool count.
 * Event changes abort obsolete work. Cached captions never cross a turn boundary.
 */
export class WorkingStatusCopy {
  private phase: WorkingPhase | null = null;
  private controller: AbortController | null = null;
  private previous: string | null = null;
  private cache = new Map<WorkingPhase, Promise<string | null>>();
  private revision = 0;

  constructor(private readonly generate: Generate) {}

  observe(phase: WorkingPhase | null): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.revision += 1;
    this.controller?.abort();
    this.controller = null;
  }

  request(phase: WorkingPhase): Promise<string | null> {
    this.observe(phase);
    let promise = this.cache.get(phase);
    if (!promise) {
      const controller = new AbortController();
      this.controller = controller;
      promise = Promise.resolve().then(() => controller.signal.aborted ? null
        : this.generate(phase, this.previous, controller.signal))
        .then((text) => controller.signal.aborted ? null : text)
        .catch(() => null);
      this.cache.set(phase, promise);
    }
    const revision = this.revision;
    return promise.then((text) => {
      if (revision !== this.revision || this.phase !== phase) return null;
      if (text) this.previous = text;
      return text;
    });
  }

  dispose(): void {
    this.observe(null);
    this.cache.clear();
    this.previous = null;
  }
}
