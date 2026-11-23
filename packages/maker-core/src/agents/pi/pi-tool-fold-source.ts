/**
 * cindy-tool-fold —— 写进 pi `internal-extensions/` 的扩展源码（字符串常量）。
 *
 * 把较老的「工具调用 + 结果」折成一行，只保留最近几次原文；巨型结果在入库前截断；
 * 折叠/截断的原文可经 cindy_toolfold_read 取回，取回过的钉住到本轮结束。
 *
 * 为什么：pi 每一步都把整段会话重发给模型；一条工具往返从产生到被压缩之前，每一步都重新
 * 计一次费。实测长会话里 87% 的注入内容就是工具往返（命令原文 + 输出），折叠后输入 token
 * 约 −27%（见 PR 实测数据）。
 *
 * 四条设计约束，改之前先读：
 *  1. 折叠一旦发生就必须持久（进程内 foldedIds），否则下一次请求投影又变回原文，前缀缓存
 *     每步都失效。pi 的 context 钩子是「按请求重算」的，状态只能自己留。
 *  2. 新折叠按批进行。每步多折一条 = 每步都在历史中段改一次前缀，后面的上下文全部变成
 *     非缓存输入（input 约为 cacheRead 的 19 倍），钱反而更贵。两次折叠之间投影逐字节不变。
 *  3. 取回用内存登记表而不是磁盘：pi 进程内本来就持有完整会话，context 钩子每次都把原始
 *     messages 交给本扩展，取回直接查最近一次快照即可。只有「入库截断」的巨型结果是
 *     transcript 里没有的，单独留在内存 giants 表（有上限）。
 *  4. 钉住防抖动：取回过的往返在投影里恢复原文，直到下一条 user 消息（轮次边界）或超出
 *     钉住预算（按最近取回时间戳 LRU 驱逐）。没有这两条，取回→再折→再取回会把缓存反复打穿。
 *  5. 记录行必须是**不可复述**的：每批只留一条、不带命令原文、不带单条统计。记录落在 assistant
 *     位置（唯一不破坏调用/结果配对的位置），而 assistant 位置是模型最会延续的语气；一旦记录里
 *     同时有「命令 + 结论 + 规模」，它就成了模型叙述工具调用的现成模板，被用来预告还没做的调用
 *     （实测 17 条，其中 2 条写成「ok」但命令从未执行）。批次 id 用 batch: 前缀，和真实调用 id
 *     分开，取回一次拿整批。
 *
 * 约束（与 cindy-bridge 同）：这段代码跑在 pi 子进程里，不能 import cindy 模块；模板里
 * 不得出现模板字符串，否则美元花括号会被外层 String.raw 插值 —— 一律用字符串拼接。
 *
 * 装载由宿主决定：实验开关「工具载荷折叠」默认关闭（设置 → 通用 → 实验功能），
 * 用户打开后，之后启动的 Pi 任务才加载这个扩展；扩展自身另认 CINDY_PI_TOOL_FOLD=off
 * （或 0）作进程内总闸。调参：CINDY_PI_TOOL_FOLD_KEEP（常驻条数，默认 4）、
 * CINDY_PI_TOOL_FOLD_MIN_PAIRS（攒够多少条折一次，默认 32）、
 * CINDY_PI_TOOL_FOLD_MIN_CHARS（攒够多少字符折一次，默认 36000）、
 * CINDY_PI_TOOL_FOLD_PIN_BUDGET（钉住预算字符数，默认 64000）、
 * CINDY_PI_TOOL_FOLD_INGEST_LIMIT / _INGEST_KEEP（入库截断阈值/保留，默认 20000/2000）、
 * CINDY_PI_TOOL_FOLD_GIANTS（保留的巨型结果条数，默认 64）、
 * CINDY_PI_TOOL_FOLD_GIANT_BUDGET（巨型结果总字符预算，默认 2000000）、
 * CINDY_PI_TOOL_FOLD_ARG_CHARS（参数超过多少字符才折，默认 200；0 = 只折结果不折参数）。
 *
 * 回放（两条重会话，keep=4/pairs=32/chars=36000，价格为实测 cacheRead 折扣）：
 * 参数≥200 才折 → 上下文 −25.5% / −22.6%，净 +$2.70 / +$0.49；只折结果 → −17.4% / −14.1%，
 * 净 +$1.32 / −$0.12；照折全部参数 → −25.2% / −22.4%，净 +$2.64 / +$0.47。
 * 小参数不折不是省钱，是省一次重建、并且不让历史里出现能被执行形状的参数对象。
 */

export const CINDY_TOOL_FOLD_EXTENSION_FILENAME = 'cindy-tool-fold.ts';

/** 远端 spawn env 不继承本机环境,这些配置键需要显式转发(值无凭证)。 */
export const CINDY_TOOL_FOLD_ENV_NAMES = [
  'CINDY_PI_TOOL_FOLD',
  'CINDY_PI_TOOL_FOLD_KEEP',
  'CINDY_PI_TOOL_FOLD_MIN_PAIRS',
  'CINDY_PI_TOOL_FOLD_MIN_CHARS',
  'CINDY_PI_TOOL_FOLD_PIN_BUDGET',
  'CINDY_PI_TOOL_FOLD_INGEST_LIMIT',
  'CINDY_PI_TOOL_FOLD_INGEST_KEEP',
  'CINDY_PI_TOOL_FOLD_GIANTS',
  'CINDY_PI_TOOL_FOLD_GIANT_BUDGET',
  'CINDY_PI_TOOL_FOLD_MAX_FOLDED',
  'CINDY_PI_TOOL_FOLD_ARG_CHARS',
  'CINDY_PI_TOOL_FOLD_RECOVERY_CHARS',
] as const;

export const CINDY_TOOL_FOLD_EXTENSION_SOURCE = String.raw`/**
 * cindy-tool-fold: fold old tool round-trips into one-line records, truncate giant
 * results at ingestion, and let the model recover any folded/truncated original.
 *
 * Every model request replays the whole transcript. A tool round-trip (call arguments +
 * result) is re-sent on every later step until compaction drops it, so it is the
 * dominant token source in long sessions.
 *
 * Four rules keep this cheap and cache-friendly:
 *  1. Folding is sticky (foldedIds). The context hook recomputes every request; without
 *     state the projection would flip back to full text and invalidate the prefix cache.
 *  2. New folds only happen in batches (MIN_PAIRS / MIN_CHARS). Folding one more pair
 *     per step rewrites the middle of the transcript every step, turning the whole tail
 *     into uncached input. Between batches the projection is byte-identical.
 *  3. Recovery reads from the last raw message snapshot (pi keeps the full transcript
 *     in-process), so payloads are not duplicated to disk. Only ingestion-truncated
 *     giants are kept separately in memory (bounded).
 *  4. Recovered round-trips are pinned as originals until the next user message or the
 *     pin budget (LRU by last recovery timestamp), preventing fold/recover thrashing.
 *  5. Arguments are folded only past ARG_FOLD_CHARS: the pointer plus the record that
 *     repeats its subject costs ~115 chars, so folding a 100-char read call is a net
 *     loss, and a call block whose arguments read like a command is the one shape models
 *     replay as if it were runnable (measured: 202 such replays in local sessions). What
 *     a folded argument said moves into the result record instead. Replaying two heavy
 *     sessions: folding only arguments >= 200 chars keeps the full context saving
 *     (-25.5% / -22.6%) with the lowest rebuild; folding every argument gives
 *     -25.2% / -22.4%; folding none drops to -17.4% / -14.1% and turns the net negative
 *     on one session.
 *
 * Batch size is expressed in characters (call arguments + result text) because a
 * round-trip ranges from ~20 chars (git status) to ~8k (a file read). Measured on two
 * long sessions: mean 1.7k chars, median 1.2k, p90 3.5k. The chars gate (36k) sits in
 * the money-optimum plateau (36k-80k) found by replaying a real 2.67B-token session and
 * usually fires first; the pairs gate (32) only catches backlogs of many tiny results,
 * keeping batches from firing below the chars target. Smaller batches trade cache
 * rebuild for raw token count and lose on cost (see the PR for the sweep).
 */
export default function (pi) {
  var disabled = process.env.CINDY_PI_TOOL_FOLD;
  if (disabled === 'off' || disabled === '0') return;

  // 单次恢复读取上限：整段回灌巨型载荷会顶穿下一次请求的上下文窗口，而原文不在
  // transcript 里，模型无法靠重读自救。超限就切片，并在尾部告诉它怎么续读。
  var RECOVERY_READ_MAX_CHARS = intEnv('CINDY_PI_TOOL_FOLD_RECOVERY_CHARS', 120000, 1000, 4000000);

  function intEnv(name, fallback, min, max) {
    var raw = Number(process.env[name]);
    if (!Number.isFinite(raw)) return fallback;
    var value = Math.floor(raw);
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  var KEEP = intEnv('CINDY_PI_TOOL_FOLD_KEEP', 4, 1, 64);
  var MIN_PAIRS = intEnv('CINDY_PI_TOOL_FOLD_MIN_PAIRS', 32, 1, 512);
  var MIN_CHARS = intEnv('CINDY_PI_TOOL_FOLD_MIN_CHARS', 36000, 1, 1000000000);
  var PIN_BUDGET_CHARS = intEnv('CINDY_PI_TOOL_FOLD_PIN_BUDGET', 64000, 2000, 100000000);
  var INGEST_LIMIT = intEnv('CINDY_PI_TOOL_FOLD_INGEST_LIMIT', 20000, 4000, 100000000);
  var INGEST_KEEP = intEnv('CINDY_PI_TOOL_FOLD_INGEST_KEEP', 2000, 500, 32000);
  var GIANT_KEEP = intEnv('CINDY_PI_TOOL_FOLD_GIANTS', 64, 8, 512);
  var GIANT_BUDGET_CHARS = intEnv('CINDY_PI_TOOL_FOLD_GIANT_BUDGET', 2000000, 100000, 1000000000);
  var LINE = 160;
  var MAX_FOLDED = intEnv('CINDY_PI_TOOL_FOLD_MAX_FOLDED', 4000, 100, 1000000);
  var ARG_FOLD_CHARS = intEnv('CINDY_PI_TOOL_FOLD_ARG_CHARS', 200, 0, 1000000);
  // A record line (name, counters, head, pointer) is roughly this long. A result shorter
  // than it would grow the context when folded, so the gate and the projection both
  // count only payload that actually disappears.
  var RECORD_ESTIMATE_CHARS = 160;

  // 权限门按名字给 cindy_toolfold_read 免审批；立一个进程内标记，让桥只对「本轮真的加载了
  // 折叠扩展」的会话豁免。折叠关闭时同名工具只能是外部注册的，必须照常走审批。
  try { globalThis[Symbol.for('cindy.pi.toolFold')] = true; } catch (markerError) { /* ignore */ }

  // Sticky fold marks: toolCallId -> payload chars. Survives requests in this process;
  // a restart simply re-folds on the next batch.
  var foldedIds = Object.create(null);
  var foldedSize = 0;
  // Which admitted batch a call belongs to, and each batch's member ids in transcript
  // order. One batch renders one record line; the ids let cindy_toolfold_read open it.
  var foldedBatch = Object.create(null);
  var batchCalls = Object.create(null);
  // Pins: callId -> { ts, chars }. ts is a monotonic recovery clock so the eviction
  // victim is the least-recently-recovered entry, not the earliest-pinned one.
  var pinned = new Map();
  var pinnedChars = 0;
  var recoverClock = 0;
  var userSeen = '';

  // user 消息身份：时间戳 + 长度 + 开头片段。压缩保留尾部消息，所以同一回合内它稳定；
  // 会话被编辑或换回合时必变。
  function turnKey(message) {
    if (!message) return '';
    var text = textOf(message.content);
    return String(message.timestamp || '') + '|' + text.length + '|' + text.slice(0, 24);
  }
  // Raw conversation snapshot from the latest context pass. Recovery reads originals
  // here instead of persisting payloads: pi already holds the full transcript.
  var lastMessages = null;
  // Full text of ingestion-truncated giants (the only payloads absent from the transcript),
  // bounded by entry count AND aggregate chars: a few multi-megabyte outputs must not
  // retain hundreds of megabytes in a long-running process.
  var giants = new Map();
  var giantBytes = 0;

  function markFolded(id, chars, batch) {
    var key = String(id);
    if (foldedIds[key] !== undefined) return;
    foldedIds[key] = chars;
    if (batch) foldedBatch[key] = String(batch);
    foldedSize += 1;
  }

  function batchOf(id) {
    return foldedBatch[String(id)] || String(id);
  }

  function oneLine(value) {
    if (typeof value !== 'string') return '';
    var text = value.replace(/\s+/g, ' ').trim();
    return text.length > LINE ? text.slice(0, LINE - 1) + '\u2026' : text;
  }

  function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    if (content.length === 1 && content[0] && content[0].type === 'text' && typeof content[0].text === 'string') return content[0].text;
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      var block = content[i];
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
  }

  // 投影体积只算文本（图片按块计，不按字节），只用来卡「输出不得大于输入」。
  function contentChars(list) {
    var total = 0;
    for (var i = 0; i < list.length; i++) {
      var content = list[i] && list[i].content;
      if (typeof content === 'string') { total += content.length; continue; }
      if (!Array.isArray(content)) continue;
      for (var j = 0; j < content.length; j++) {
        var block = content[j];
        if (block && typeof block.text === 'string') total += block.text.length;
        else if (block && block.type === 'toolCall' && block.arguments) total += JSON.stringify(block.arguments).length;
      }
    }
    return total;
  }

  // Scan lines in place: a multi-megabyte payload split into an array of lines per folded
  // result per turn costs more than everything else in this hook put together.
  function countLines(text) {
    var count = 1;
    for (var at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count += 1;
    return count;
  }

  function firstLine(text) {
    var start = 0;
    while (start <= text.length) {
      var end = text.indexOf('\n', start);
      if (end === -1) end = text.length;
      var line = oneLine(text.slice(start, end));
      if (line) return line;
      start = end + 1;
    }
    return '';
  }

  function lastLine(text) {
    var end = text.length;
    while (end > 0) {
      var start = text.lastIndexOf('\n', end - 1) + 1;
      var line = oneLine(text.slice(start, end));
      if (line) return line;
      end = start - 1;
    }
    return '';
  }

  function callSubject(block) {
    var args = block.arguments && typeof block.arguments === 'object' ? block.arguments : {};
    var key = '';
    if (typeof args.command === 'string') key = oneLine(args.command);
    else if (typeof args.path === 'string') key = oneLine(args.path);
    else if (typeof args.file_path === 'string') key = oneLine(args.file_path);
    else if (typeof args.filePath === 'string') key = oneLine(args.filePath);
    else if (typeof args.pattern === 'string') key = oneLine(args.pattern);
    else if (typeof args.query === 'string') key = oneLine(args.query);
    else {
      try { key = oneLine(JSON.stringify(args)); } catch (error) { key = ''; }
    }
    return key;
  }

  function callSummary(block) {
    return (block.name ? String(block.name) + ' \u00b7 ' : '') + callSubject(block);
  }

  function argChars(block) {
    try { return JSON.stringify(block.arguments || {}).length; } catch (error) { return 0; }
  }

  function isFoldedCall(block) {
    var args = block.arguments;
    return Boolean(args && typeof args === 'object' && args.__folded === true);
  }

  /** Complete tool round-trips: assistant call block(s) plus the result message(s) that answer them. */
  function roundTrips(messages) {
    var trips = [];
    for (var index = 0; index < messages.length; index++) {
      var message = messages[index];
      if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      var calls = [];
      for (var b = 0; b < message.content.length; b++) {
        var block = message.content[b];
        if (block && block.type === 'toolCall' && typeof block.id === 'string') calls.push(block);
      }
      if (calls.length === 0) continue;
      var ids = Object.create(null);
      for (var c = 0; c < calls.length; c++) ids[calls[c].id] = false;
      var results = [];
      var indexes = [];
      var hasImage = false;
      for (var next = index + 1; next < messages.length; next++) {
        var candidate = messages[next];
        if (!candidate || candidate.role !== 'toolResult' || !(candidate.toolCallId in ids)) break;
        ids[candidate.toolCallId] = true;
        results.push(candidate);
        indexes.push(next);
        if (Array.isArray(candidate.content)) {
          for (var r = 0; r < candidate.content.length; r++) {
            if (candidate.content[r] && candidate.content[r].type === 'image') hasImage = true;
          }
        }
      }
      var complete = true;
      for (var id in ids) if (ids[id] !== true) complete = false;
      if (!complete) continue;
      var chars = 0;
      var folds = Object.create(null);
      for (var c2 = 0; c2 < calls.length; c2++) {
        var argSize = 0;
        try { argSize = argChars(calls[c2]); } catch (error) { argSize = 0; }
        chars += argSize;
        folds[calls[c2].id] = { args: argSize, result: 0 };
      }
      for (var r2 = 0; r2 < results.length; r2++) {
        var textSize = textOf(results[r2].content).length;
        chars += textSize;
        var sized = folds[String(results[r2].toolCallId)];
        if (sized) sized.result = textSize;
      }
      var removable = 0;
      var removableCalls = 0;
      // Route 2 replaces the whole trip with one record text: arguments disappear too, so
      // a trip whose arguments are cheap can still be worth dropping.
      var dropChars = chars - calls.length * RECORD_ESTIMATE_CHARS;
      for (var c4 = 0; c4 < calls.length; c4++) {
        var plan = folds[calls[c4].id];
        plan.foldArgs = ARG_FOLD_CHARS > 0 && plan.args > ARG_FOLD_CHARS && callPointerShorter(calls[c4]);
        plan.foldResult = plan.result > RECORD_ESTIMATE_CHARS;
        removable += (plan.foldArgs ? plan.args : 0) + (plan.foldResult ? plan.result : 0);
        if (plan.foldArgs || plan.foldResult) removableCalls += 1;
      }
      if (dropChars > removable) removable = dropChars;
      if (dropChars >= 80) removableCalls = calls.length;
      var sizes = Object.create(null);
      for (var c3 = 0; c3 < calls.length; c3++) {
        try { sizes[calls[c3].id] = JSON.stringify(calls[c3].arguments || {}).length; } catch (error) { sizes[calls[c3].id] = 0; }
      }
      for (var r3 = 0; r3 < results.length; r3++) {
        var rid = String(results[r3].toolCallId);
        sizes[rid] = (sizes[rid] || 0) + textOf(results[r3].content).length;
      }
      trips.push({ start: index, end: indexes[indexes.length - 1], calls: calls, callCount: calls.length, chars: chars, removable: removable, removableCalls: removableCalls, folds: folds, sizes: sizes, hasImage: hasImage, results: results, indexes: indexes });
    }
    return trips;
  }

  // Fallback for trips that cannot be dropped whole (a pinned sibling, an image): the
  // pointer must not look runnable. It carries the id and nothing that reads like an
  // argument, because the model replays the nearest call-shaped example it sees.
  function foldedCall(block) {
    return {
      type: 'toolCall',
      id: block.id,
      name: block.name,
      arguments: { __folded: true, call: String(block.id) },
    };
  }

  /**
   * The pointer repeats the call id, so a provider whose ids are nearly as long as the
   * arguments would end up with a larger block. Same rule as foldedResult: compare
   * exactly, never trade payload for a longer marker.
   */
  function callPointerShorter(block) {
    try { return JSON.stringify(foldedCall(block)).length < JSON.stringify(block).length; } catch (error) { return false; }
  }

  /** Summary record, or null when the record would not be shorter than the payload. */
  function foldedResult(result, call, argsFolded) {
    var text = textOf(result.content);
    var lines = text ? countLines(text) : 0;
    var status = result.isError === true ? 'error' : 'ok';
    // Name first, status later: a line that opens with "ok" reads like a result the model
    // can go on writing, and one model did exactly that (fake "ok" records, no call behind
    // them). Same byte length as the old prefix, so fold decisions and savings do not move.
    var summary = '[folded] ' + String((call && call.name) || '?');
    if (argsFolded && call) {
      var subject = callSubject(call);
      if (subject) summary += ' \u00b7 ' + subject;
    }
    summary += ' \u00b7 ' + status + ' \u00b7 ' + lines + ' lines/' + text.length + ' chars';
    var head = firstLine(text);
    if (head) summary += ' \u00b7 ' + head;
    if (result.isError === true) {
      var tail = lastLine(text);
      if (tail && tail !== head) summary += ' \u00b7 last: ' + tail;
    }
    if (typeof result.toolCallId === 'string' && result.toolCallId) {
      summary += ' \u00b7 full: cindy_toolfold_read("' + result.toolCallId + '")';
    }
    // Never trade content for a longer summary. Estimating this was wrong once already
    // (a batch of "ok" results grew); the text is in hand here, so compare exactly.
    if (summary.length >= text.length) return null;
    return { role: 'toolResult', toolCallId: result.toolCallId, toolName: result.toolName, isError: result.isError, content: [{ type: 'text', text: summary }] };
  }

  /**
   * Route 2: the whole round-trip becomes one assistant text record — no call block and no
   * result message. Nothing in the history then reads like a callable example, which is
   * what the model kept re-sending (795 validation failures, 121 of them in one day).
   * Returns null when this trip must keep its pair.
   */
  /**
   * One record line per folded batch. Never per round-trip: a line carrying "command → ok →
   * size → pointer" is a complete summary in the assistant's own voice, so a model that is
   * about to run a batch of queries writes those lines first as if they had already run
   * (observed: four invented records with fabricated ids ahead of the real run). One
   * aggregate line cannot describe any single action, so copying it buys nothing.
   */
  function batchRecordText(batch) {
    var names = [];
    for (var name in batch.names) names.push(name);
    names.sort();
    var tally = [];
    for (var n = 0; n < names.length; n++) tally.push(names[n] + ' ' + batch.names[names[n]]);
    return '[folded] ' + batch.dropped + (batch.dropped === 1 ? ' round-trip, ' : ' round-trips, ') + tally.join(', ') + ', ' + batch.chars +
      ' chars, read with cindy_toolfold_read("' + batch.first + '")';
  }

  function allFolded(trip) {
    for (var i = 0; i < trip.calls.length; i++) if (foldedIds[String(trip.calls[i].id)] === undefined) return false;
    return true;
  }

  // A trip can disappear only when every call in it is marked and belongs to the same
  // admitted batch, and every call has its result. Anything else keeps the per-call
  // pointer plus per-result record fallback.
  function droppableBatch(unit) {
    if (unit.results.length < unit.calls.length) return null;
    var batchId = null;
    for (var i = 0; i < unit.calls.length; i++) {
      var id = String(unit.calls[i].id);
      if (!foldable(id)) return null;
      var of = batchOf(id);
      if (batchId === null) batchId = of;
      else if (batchId !== of) return null;
    }
    return batchId;
  }

  function textOnlyTurnActive() {
    try { return globalThis[Symbol.for('cindy.pi.textOnlyTurn')] === true; } catch (err) { return false; }
  }

  // 文本回合禁用了所有工具：被 ingest 截断、原文还留在 giants 里的结果，模型既看不到
  // 全文也调不了取回，只能瞎猜。把仍在预算内的原文放回去，超预算的保持预览。
  function expandRetained(messages) {
    var out = null;
    var left = PIN_BUDGET_CHARS;
    for (var i = 0; i < messages.length; i++) {
      var message = messages[i];
      if (!message || message.role !== 'toolResult') continue;
      if (!Array.isArray(message.content) || message.content.length === 0) continue;
      var onlyText = true;
      for (var b = 0; b < message.content.length; b++) {
        var part = message.content[b];
        if (!part || part.type !== 'text' || typeof part.text !== 'string') { onlyText = false; break; }
      }
      if (!onlyText) continue;
      var block = { text: textOf(message.content) };
      var full = giants.get(String(message.toolCallId));
      if (full === undefined || full.length <= block.text.length) continue;
      if (full.length - block.text.length > left) continue;
      left -= full.length - block.text.length;
      if (out === null) out = messages.slice();
      out[i] = Object.assign({}, message, { content: [{ type: 'text', text: full }] });
    }
    return out === null ? undefined : out;
  }

  // 取回工具的 call_id 有 4096 字符上限；provider 的超长 id 再加前缀就越界，别名只留
  // 尾部（批内映射按别名登记，取回照常）。
  var MAX_CALL_ID_CHARS = 4096;
  function batchAlias(firstId) {
    var raw = 'batch:' + String(firstId);
    if (raw.length <= MAX_CALL_ID_CHARS) return raw;
    var head = 'batch:';
    return head + raw.slice(raw.length - (MAX_CALL_ID_CHARS - head.length));
  }

  function foldable(id) {
    return foldedIds[id] !== undefined && !pinned.has(id);
  }

  /** Admit a giant payload; evict oldest entries until the aggregate bound holds. */
  function admitGiant(id, text) {
    if (text.length > GIANT_BUDGET_CHARS) return false; // a single payload over budget is never retained
    if (giants.has(id)) {
      giantBytes -= giants.get(id).length;
      giants.delete(id);
    }
    giants.set(id, text);
    giantBytes += text.length;
    while (giants.size > 1 && (giants.size > GIANT_KEEP || giantBytes > GIANT_BUDGET_CHARS)) {
      var oldest = giants.keys().next().value;
      giantBytes -= giants.get(oldest).length;
      giants.delete(oldest);
    }
    return giants.get(id) === text;
  }

  // -----------------------------------------------------------------------
  // Ingestion truncation: a giant result never enters the transcript in full, so it
  // is never cached and never folded — truncating before the first send is free.
  // -----------------------------------------------------------------------
  // 结果限长只在这一处判定：字符串与多块内容走同一条路，门槛（INGEST_LIMIT）与保留
  // 额度（INGEST_KEEP）只在这里比较。调用点不再各自比长度——「一个地方放行、另一个地方
  // 截断」正是漏限的温床。图片块原样保留：带图往返本来不折，文本再不限就没人能压它。
  function clipContent(content, id) {
    var isString = typeof content === 'string';
    var blocks = isString ? [{ type: 'text', text: content }] : content;
    if (!Array.isArray(blocks)) return null;
    var total = 0;
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block && block.type === 'text' && typeof block.text === 'string') total += block.text.length;
    }
    if (total <= INGEST_LIMIT) return null;
    var full = textOf(blocks);
    admitGiant(id, full);
    var retained = giants.get(id) === full;
    var kept = 0;
    var truncated = 0;
    var parts = [];
    for (var j = 0; j < blocks.length; j++) {
      var b = blocks[j];
      if (!b || b.type !== 'text' || typeof b.text !== 'string') { parts.push(b); continue; }
      var room = INGEST_KEEP - kept;
      if (room <= 0) { truncated += b.text.length; continue; }
      if (b.text.length <= room) { kept += b.text.length; parts.push(b); }
      else { truncated += b.text.length - room; parts.push({ type: 'text', text: b.text.slice(0, room) }); kept = INGEST_KEEP; }
    }
    parts.push({ type: 'text', text: '[truncated ' + truncated + ' of ' + total
      + ' chars; ' + (retained
        ? 'cindy_toolfold_read("' + id + '") returns the full text]'
        : 'full text not retained (call "' + id + '"); re-run if needed]') });
    return isString ? [{ type: 'text', text: textOf(parts) }] : parts;
  }

  pi.on('tool_result', function (event) {
    if (event && event.toolName === 'cindy_toolfold_read') return undefined;
    var id = String((event && event.toolCallId) || '');
    if (!id) return undefined;
    var parts = clipContent(event && event.content, id);
    if (parts === null) return undefined;
    var out = { content: parts };
    if (Object.prototype.hasOwnProperty.call(event, 'structuredContent')) out.structuredContent = event.structuredContent;
    return out;
  });

  // -----------------------------------------------------------------------
  // Recovery: return the original text for a folded or truncated round-trip and pin
  // the folded one so the projection keeps the original for the rest of the turn.
  // -----------------------------------------------------------------------
  function findOriginal(callId) {
    var key = String(callId);
    var messages = lastMessages;
    var callBlock = null;
    var resultMsg = null;
    var truncatedPreview = null;
    if (messages) {
      for (var i = 0; i < messages.length; i++) {
        var message = messages[i];
        if (!message) continue;
        if (message.role === 'assistant' && Array.isArray(message.content)) {
          for (var b = 0; b < message.content.length; b++) {
            var block = message.content[b];
            if (block && block.type === 'toolCall' && String(block.id) === key) callBlock = block;
          }
        } else if (message.role === 'toolResult' && String(message.toolCallId) === key) {
          resultMsg = message;
          var resultText = textOf(message.content);
          // Ingestion truncation appends exactly one marker and it is the last thing in
          // the result. Only that full shape, naming this call id, counts as a preview: a
          // result that merely quotes the wording stays recoverable.
          var marker = '[truncated ';
          var shape = /^\[truncated \d+ of \d+ chars; (.+)\]$/;
          var markerAt = resultText.indexOf(marker);
          while (markerAt !== -1) {
            var markerEnd = resultText.indexOf(']', markerAt);
            if (markerEnd !== -1) {
              var markerBody = resultText.slice(markerAt, markerEnd + 1);
              var endsText = resultText.slice(markerEnd + 1).trim().length === 0;
              var tail = shape.exec(markerBody);
              var tailText = tail ? tail[1] : '';
              var named = 'cindy_toolfold_read("' + key + '") returns the full text';
              var evictedNow = 'full text not retained (call "' + key + '"); re-run if needed';
              if (endsText && (tailText === named || tailText === evictedNow)) truncatedPreview = markerBody;
            }
            markerAt = resultText.indexOf(marker, markerAt + 1);
          }
        }
      }
    }
    // The registry holds the FULL text of an ingestion-truncated payload (the transcript
    // only has the preview). Prefer it, and combine it with the call block so recovery
    // returns arguments + result as the tool promises.
    var giant = giants.has(key) ? giants.get(key) : null;
    // Evicted/lost giant with only the truncation preview in context (the marker ends
    // the text): refuse rather than serve the preview as the original.
    if (giant === null && truncatedPreview) {
      return { ok: false, reason: truncatedPreview.indexOf('not retained') !== -1 ? 'not-retained' : 'evicted' };
    }
    if (!callBlock && !resultMsg && giant === null) return { ok: false, reason: 'missing' };
    var bits = [];
    if (callBlock) {
      bits.push('call: ' + callSummary(callBlock));
      try { bits.push('arguments: ' + JSON.stringify(callBlock.arguments || {})); } catch (error) { /* ignore */ }
    }
    // Two halves kept apart: the caller may re-admit only the result (the half that can be
    // absent from the transcript) while still returning call + arguments above.
    var resultText = '';
    if (giant !== null) {
      resultText = giant;
      bits.push('result:\n' + giant);
    } else if (resultMsg) {
      resultText = textOf(resultMsg.content);
      bits.push('result:\n' + resultText);
    }
    return { ok: true, text: bits.join('\n'), result: resultText };
  }

  function readSlice(id, raw, params) {    var offset = typeof params.offset === 'number' && params.offset > 0 ? Math.floor(params.offset) : 0;
    if (offset >= raw.length && raw.length > 0) {
      return { content: [{ type: 'text', text: 'Offset ' + offset + ' is past the end of ' + id + ' (' + raw.length + ' chars).' }], isError: true };
    }
    var rest = raw.slice(offset);
    if (rest.length <= RECOVERY_READ_MAX_CHARS) return { content: [{ type: 'text', text: rest }] };
    var next = offset + RECOVERY_READ_MAX_CHARS;
    return {
      content: [{
        type: 'text',
        text: rest.slice(0, RECOVERY_READ_MAX_CHARS) + '\n\n[truncated: ' + raw.length + ' chars total, ' + (raw.length - next) + ' remaining. Call cindy_toolfold_read again with offset: ' + next + ' to continue.]',
      }],
    };
  }

  // 整批取回：按批内顺序把每条往返的原文拼起来，交给同一条分页逻辑。
  // shortcut: 一次拼完整批；批总量到几 MB 时会有几十毫秒开销，需要再优化时改成分段拼。
  function batchOriginal(batchId) {
    var ids = batchCalls[batchId] || [];
    var parts = [];
    var missing = [];
    for (var i = 0; i < ids.length; i++) {
      var memberId = String(ids[i]);
      var original = findOriginal(memberId);
      if (original && original.ok === true) { parts.push(original.text); continue; }
      // 缺项必须点名：静默跳过会让模型把半批内容当成整批原文。
      var why = original && original.reason === 'evicted' ? 'full text evicted'
        : original && original.reason === 'not-retained' ? 'full text not retained'
          : 'not in this session';
      missing.push(memberId + ' (' + why + ')');
    }
    var text = parts.join('\n\n');
    if (missing.length > 0) {
      var note = '[missing ' + missing.length + ' of ' + ids.length + ' round-trips in this batch: '
        + missing.join(', ') + ' — read a single id or re-run that command]';
      text = text ? text + '\n\n' + note : note;
    }
    return { text: text, recovered: parts.length };
  }

  function pinOriginal(callId) {
    var key = String(callId);
    var chars = foldedIds[key];
    if (chars === undefined) {
      var original = findOriginal(key);
      chars = original && original.ok === true ? original.text.length : 0;
    }
    var existing = pinned.get(key);
    if (existing) {
      // Re-recovery refreshes recency so the eviction victim is the least-recently
      // recovered entry, not the earliest-pinned one.
      existing.ts = ++recoverClock;
      return;
    }
    pinned.set(key, { ts: ++recoverClock, chars: chars });
    pinnedChars += chars;
    while (pinnedChars > PIN_BUDGET_CHARS && pinned.size > 1) {
      var oldest = null;
      pinned.forEach(function (entry, id) {
        if (oldest === null || entry.ts < pinned.get(oldest).ts) oldest = id;
      });
      pinnedChars -= pinned.get(oldest).chars;
      pinned.delete(oldest);
    }
  }

  pi.registerTool({
    name: 'cindy_toolfold_read',
    label: 'Read a folded tool result',
    description: 'Return the full original text of one folded or truncated tool round-trip (call arguments plus the complete result). Pass the id shown inside the "[folded]" record: a batch id returns every round-trip in that batch, a single call id returns just that one. The folded original is also restored in the conversation until your next user message, so read once and continue instead of re-running the command.',
    parameters: {
      type: 'object',
      properties: {
        // 上限按 Pi 可能发出的最长调用 id 定：Gemini 历史里出现过 2,000+ 字符的 id，
        // 折叠/截断提示写的是完整 id，约束必须容得下它，否则提示要求的值取不回原文。
        call_id: { type: 'string', minLength: 1, maxLength: 4096, description: 'Batch or tool call id from the folded or truncated record.' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset to continue from when the previous read stopped at the per-read limit.' },
      },
      required: ['call_id'],
      additionalProperties: false,
    },
    execute: async function (_toolCallId, params) {
      var id = params && typeof params.call_id === 'string' ? params.call_id : '';
      if (!id) throw new Error('call_id is required');
      if (batchCalls[id] && foldedIds[id] === undefined) {
        var batch = batchOriginal(id);
        if (batch.recovered === 0) return { content: [{ type: 'text', text: 'Cannot recover ' + id + ': ' + batch.text }], isError: true };
        return readSlice(id, batch.text, params);
      }
      var original = findOriginal(id);
      if (!original || original.ok !== true) {
        var reason = original && original.reason === 'not-retained'
          ? 'its full text was not retained (payload over the retention budget); re-run the command instead.'
          : original && original.reason === 'evicted'
            ? 'its full text is no longer available (registry evicted or lost on resume); re-run the command instead.'
            : 'no folded or truncated round-trip with that id exists in this session.';
        return { content: [{ type: 'text', text: 'Cannot recover ' + id + ': ' + reason }], isError: true };
      }
      var raw = String(original.text || '');
      if (!giants.has(String(id))) {
        // 只有「这次真的把整段返回」才钉住：读上限比 pin 预算小时，钉住等于把整段
        // 塞回下一次请求，把读上限直接作废（上下文快满时尤其危险）。部分读取只转存
        // 结果到 giant 注册表，投影里那条往返继续留在折叠态。
        // 只存结果那半：giants 是「结果」的注册表，存整段会在下次 findOriginal 里
        // 再拼一次调用说明与参数（续读的 offset 随之失真）。
        if (raw.length <= PIN_BUDGET_CHARS && raw.length <= RECOVERY_READ_MAX_CHARS) {
          pinOriginal(id);
        } else if (!admitGiant(String(id), String(original.result || ''))) {
          // 转存被拒（超出内存预算）时不能退回钉住：那等于让一次取回把整段原文塞回
          // 上下文，把读上限和 pin 预算一起作废。这里 fail-closed，保持折叠并说明原因。
          return { content: [{ type: 'text', text: 'Cannot recover ' + id + ': the payload is over the retention budget, so it was not retained; re-run the command instead.' }], isError: true };
        }
      }
      return readSlice(String(id), raw, params);
    },
  });

  pi.on('context', function (event) {
    var messages = event && Array.isArray(event.messages) ? event.messages : null;
    if (!messages || messages.length === 0) return undefined;
    // Host text-only turns block every tool, cindy_toolfold_read included. Leave the history
    // unfolded for that request so the model never sees a summary it cannot expand.
    if (textOnlyTurnActive()) {
      var retained = expandRetained(messages);
      return retained === undefined ? undefined : { messages: retained };
    }

    // Turn boundary: pins live until the next user message. 判定用「最后一条 user 消息的
    // 身份」而不是条数：压缩会减少保留的 user 消息，条数可能被新回合刚好补平，边界就
    // 漏判，陈旧的 pin 会跟到新回合里继续占上下文。
    var lastUser = null;
    for (var u = messages.length - 1; u >= 0; u--) {
      if (messages[u] && messages[u].role === 'user') { lastUser = messages[u]; break; }
    }
    var userKey = turnKey(lastUser);
    if (userKey !== userSeen) {
      pinned.clear();
      pinnedChars = 0;
      userSeen = userKey;
    }
    lastMessages = messages;

    var trips = roundTrips(messages);
    if (trips.length === 0) return undefined;

    // Newest KEEP tool calls stay verbatim; anything older is a fold candidate.
    var kept = 0;
    var boundary = messages.length;
    for (var t = trips.length - 1; t >= 0; t--) {
      if (kept >= KEEP) break;
      kept += trips[t].callCount;
      boundary = trips[t].start;
    }

    var candidates = [];
    var candidateChars = 0;
    var candidateCalls = 0;
    for (var f = 0; f < trips.length; f++) {
      var probe = trips[f];
      if (probe.end >= boundary || probe.hasImage || probe.removable < 80) continue;
      if (allFolded(probe)) continue;
      var already = false;
      for (var pb = 0; pb < probe.calls.length; pb++) if (isFoldedCall(probe.calls[pb])) already = true;
      if (already) continue;
      candidates.push(probe);
      candidateChars += probe.removable;
      candidateCalls += probe.removableCalls;
    }
    if (candidateCalls >= MIN_PAIRS || candidateChars >= MIN_CHARS) {
      if (foldedSize > MAX_FOLDED) {
        // Prune instead of wipe: keep marks for trips still in the context (their
        // full text must not come back — that would be a wide prefix-cache miss) and
        // drop marks for ids already removed by compaction or edits.
        var liveIds = Object.create(null);
        for (var lt = 0; lt < trips.length; lt++) {
          for (var lc = 0; lc < trips[lt].calls.length; lc++) liveIds[String(trips[lt].calls[lc].id)] = true;
        }
        var pruned = Object.create(null);
        var prunedSize = 0;
        for (var key in foldedIds) {
          if (liveIds[key]) {
            pruned[key] = foldedIds[key];
            prunedSize += 1;
          }
        }
        foldedIds = pruned;
        foldedSize = prunedSize;
        var prunedBatch = Object.create(null);
        for (var pb2 in pruned) if (foldedBatch[pb2] !== undefined) prunedBatch[pb2] = foldedBatch[pb2];
        foldedBatch = prunedBatch;
        var liveBatches = Object.create(null);
        for (var pb3 in prunedBatch) liveBatches[prunedBatch[pb3]] = true;
        for (var pb4 in batchCalls) if (!liveBatches[pb4]) delete batchCalls[pb4];
      }
      // One batch, one id: the batch is named after its first call, prefixed so it can never
      // collide with a real call id (the same string is also a call the reader may open).
      var batchId = batchAlias(candidates[0].calls[0].id);
      var batchIds = [];
      for (var m = 0; m < candidates.length; m++) {
        for (var mi = 0; mi < candidates[m].calls.length; mi++) {
          var bc = String(candidates[m].calls[mi].id);
          markFolded(bc, candidates[m].sizes[bc] || 0, batchId);
          batchIds.push(bc);
        }
      }
      batchCalls[batchId] = batchIds;
    }

    var replaced = Object.create(null);
    var dropped = Object.create(null);
    var groups = Object.create(null);
    var synthetic = new Set();
    var dirty = false;
    for (var g = 0; g < trips.length; g++) {
      var unit = trips[g];
      if (unit.hasImage || unit.removable < 80) continue;
      var assistant = messages[unit.start];
      if (!assistant || !Array.isArray(assistant.content)) continue;
      var groupId = droppableBatch(unit);
      if (groupId !== null) {
        var group = groups[groupId];
        if (!group) group = groups[groupId] = { first: groupId, dropped: 0, chars: 0, names: Object.create(null), slot: -1 };
        group.slot = Math.max(group.slot, unit.end);
        group.dropped += 1;
        group.chars += unit.chars;
        for (var nc = 0; nc < unit.calls.length; nc++) {
          var cname = String(unit.calls[nc].name || '?');
          group.names[cname] = (group.names[cname] || 0) + 1;
        }
        // 同一条 assistant 消息里除调用还有正文时，正文要留着：那是模型自己的计划与
        // 结论，findOriginal 只还原调用参数与结果，取不回这些内容。
        var keepBlocks = null;
        for (var kb = 0; kb < assistant.content.length; kb++) {
          var keptBlock = assistant.content[kb];
          if (keptBlock && keptBlock.type === 'toolCall') continue;
          if (keepBlocks === null) keepBlocks = [];
          keepBlocks.push(keptBlock);
        }
        if (keepBlocks === null) {
          dropped[unit.start] = true;
        } else {
          replaced[unit.start] = Object.assign({}, assistant, { content: keepBlocks });
        }
        for (var d2 = 0; d2 < unit.indexes.length; d2++) dropped[unit.indexes[d2]] = true;
        dirty = true;
        continue;
      }
      var blocks = assistant.content;
      var nextContent = [];
      var callsById = Object.create(null);
      var argsReplaced = false;
      for (var k = 0; k < blocks.length; k++) {
        var block = blocks[k];
        if (block && block.type === 'toolCall' && foldable(String(block.id))) {
          // Fold arguments only past the budget; below it the pointer is larger than the
          // payload and the call block is the shape the model re-sends by accident.
          var plan = unit.folds[String(block.id)];
          var foldArgs = Boolean(plan && plan.foldArgs === true);
          callsById[String(block.id)] = { call: block, argsFolded: foldArgs, foldResult: Boolean(plan && plan.foldResult === true) };
          if (foldArgs) {
            nextContent.push(foldedCall(block));
            argsReplaced = true;
          } else {
            nextContent.push(block);
          }
        } else {
          nextContent.push(block);
        }
      }
      // Fold per call, not per trip: a pinned call keeps its own payload verbatim while
      // its parallel siblings stay folded.
      if (argsReplaced) {
        replaced[unit.start] = Object.assign({}, assistant, { content: nextContent });
        dirty = true;
      }
      for (var r = 0; r < unit.results.length; r++) {
        var result = unit.results[r];
        var entry = callsById[String(result.toolCallId)];
        if (!entry || !entry.foldResult) continue;
        var record = foldedResult(result, entry.call, entry.argsFolded);
        if (!record) continue;
        replaced[unit.indexes[r]] = record;
        dirty = true;
      }
    }

    if (!dirty) return undefined;
    // One marker per batch, at the last slot it replaced: earlier markers keep their bytes,
    // so folding a new batch never rewrites an old one.
    var markers = Object.create(null);
    for (var batchKey in groups) {
      var batchGroup = groups[batchKey];
      var marker = { role: 'assistant', content: [{ type: 'text', text: batchRecordText(batchGroup) }] };
      markers[batchGroup.slot] = marker;
      synthetic.add(marker);
    }
    var final = [];
    for (var fi = 0; fi < messages.length; fi++) {
      if (markers[fi]) final.push(markers[fi]);
      if (dropped[fi]) continue;
      final.push(replaced[fi] || messages[fi]);
    }
    // Dropping a trip removes the messages between two assistant turns, so two assistant
    // messages can land next to each other. Providers reject that: fold the older record
    // into the newer message instead of keeping both.
    var merged = [];
    for (var mj = 0; mj < final.length; mj++) {
      var current = final[mj];
      var previous = merged.length > 0 ? merged[merged.length - 1] : null;
      if (previous && previous.role === 'assistant' && current.role === 'assistant' && (synthetic.has(previous) || synthetic.has(current))) {
        var joined = Object.assign({}, current, { content: (previous.content || []).concat(current.content || []) });
        merged[merged.length - 1] = joined;
        synthetic.add(joined);
        continue;
      }
      merged.push(current);
    }
    // 只允许变小：任何入口将来漏了限额（新内容类型、新的折叠分支、异常回退），都在
    // 这里退回原样，而不是把上下文撑大。这是投影层的最后一道闸。
    if (contentChars(merged) > contentChars(messages)) return undefined;
    return { messages: merged };
  });
}
`;
