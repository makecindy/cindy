/**
 * cindy-tool-fold —— 写进 pi `internal-extensions/` 的扩展源码（字符串常量）。
 *
 * 把较老的「工具调用 + 结果」折成一行，只保留最近几次原文；巨型结果在入库前截断；
 * 折叠/截断的原文可经 toolfold_read 取回，取回过的钉住到本轮结束。
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
 * CINDY_PI_TOOL_FOLD_GIANT_BUDGET（巨型结果总字符预算，默认 2000000）。
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

  // Sticky fold marks: toolCallId -> payload chars. Survives requests in this process;
  // a restart simply re-folds on the next batch.
  var foldedIds = Object.create(null);
  var foldedSize = 0;
  // Pins: callId -> { ts, chars }. ts is a monotonic recovery clock so the eviction
  // victim is the least-recently-recovered entry, not the earliest-pinned one.
  var pinned = new Map();
  var pinnedChars = 0;
  var recoverClock = 0;
  var userSeen = -1;
  // Raw conversation snapshot from the latest context pass. Recovery reads originals
  // here instead of persisting payloads: pi already holds the full transcript.
  var lastMessages = null;
  // Full text of ingestion-truncated giants (the only payloads absent from the transcript),
  // bounded by entry count AND aggregate chars: a few multi-megabyte outputs must not
  // retain hundreds of megabytes in a long-running process.
  var giants = new Map();
  var giantBytes = 0;

  function markFolded(id, chars) {
    var key = String(id);
    if (foldedIds[key] !== undefined) return;
    foldedIds[key] = chars;
    foldedSize += 1;
  }

  function oneLine(value) {
    if (typeof value !== 'string') return '';
    var text = value.replace(/\s+/g, ' ').trim();
    return text.length > LINE ? text.slice(0, LINE - 1) + '\u2026' : text;
  }

  function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      var block = content[i];
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
  }

  function firstLine(text) {
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = oneLine(lines[i]);
      if (line) return line;
    }
    return '';
  }

  function lastLine(text) {
    var lines = text.split('\n');
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = oneLine(lines[i]);
      if (line) return line;
    }
    return '';
  }

  function callSummary(block) {
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
    return (block.name ? String(block.name) + ' \u00b7 ' : '') + key;
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
      for (var c2 = 0; c2 < calls.length; c2++) {
        try { chars += JSON.stringify(calls[c2].arguments || {}).length; } catch (error) { /* ignore */ }
      }
      for (var r2 = 0; r2 < results.length; r2++) chars += textOf(results[r2].content).length;
      var sizes = Object.create(null);
      for (var c3 = 0; c3 < calls.length; c3++) {
        try { sizes[calls[c3].id] = JSON.stringify(calls[c3].arguments || {}).length; } catch (error) { sizes[calls[c3].id] = 0; }
      }
      for (var r3 = 0; r3 < results.length; r3++) {
        var rid = String(results[r3].toolCallId);
        sizes[rid] = (sizes[rid] || 0) + textOf(results[r3].content).length;
      }
      trips.push({ start: index, end: indexes[indexes.length - 1], calls: calls, callCount: calls.length, chars: chars, sizes: sizes, hasImage: hasImage, results: results, indexes: indexes });
    }
    return trips;
  }

  function foldedCall(block) {
    return {
      type: 'toolCall',
      id: block.id,
      name: block.name,
      arguments: { __folded: true, summary: callSummary(block) },
    };
  }

  function foldedResult(result, call) {
    var text = textOf(result.content);
    var lines = text ? text.split('\n').length : 0;
    var summary = '[folded] ' + (result.isError === true ? 'error' : 'ok');
    if (call && call.name) summary += ' \u00b7 ' + String(call.name);
    summary += ' \u00b7 ' + lines + ' lines/' + text.length + ' chars';
    var head = firstLine(text);
    if (head) summary += ' \u00b7 ' + head;
    if (result.isError === true) {
      var tail = lastLine(text);
      if (tail && tail !== head) summary += ' \u00b7 last: ' + tail;
    }
    if (typeof result.toolCallId === 'string' && result.toolCallId) {
      summary += ' \u00b7 full: toolfold_read("' + result.toolCallId + '")';
    }
    return { role: 'toolResult', toolCallId: result.toolCallId, toolName: result.toolName, isError: result.isError, content: [{ type: 'text', text: summary }] };
  }

  function allFolded(trip) {
    for (var i = 0; i < trip.calls.length; i++) if (foldedIds[String(trip.calls[i].id)] === undefined) return false;
    return true;
  }

  function textOnlyTurnActive() {
    try { return globalThis[Symbol.for('cindy.pi.textOnlyTurn')] === true; } catch (err) { return false; }
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
  pi.on('tool_result', function (event) {
    var content = event && event.content;
    if (event && event.toolName === 'toolfold_read') return undefined;
    if (typeof content === 'string') {
      if (content.length <= INGEST_LIMIT) return undefined;
      var sid = String((event && event.toolCallId) || '');
      if (!sid) return undefined;
      var sidRetained = admitGiant(sid, content);
      return { content: [{ type: 'text', text: content.slice(0, INGEST_KEEP)
        + '\n[truncated ' + (content.length - INGEST_KEEP) + ' of ' + content.length
        + ' chars; ' + (sidRetained
          ? 'toolfold_read("' + sid + '") returns the full text]'
          : 'full text not retained (call "' + sid + '"); re-run if needed]') }] };
    }
    if (!Array.isArray(content)) return undefined;
    var hasImage = false;
    var total = 0;
    for (var i = 0; i < content.length; i++) {
      var block = content[i];
      if (!block) continue;
      if (block.type === 'image') hasImage = true;
      if (block.type === 'text' && typeof block.text === 'string') total += block.text.length;
    }
    if (hasImage || total <= INGEST_LIMIT) return undefined;
    var id = String((event && event.toolCallId) || '');
    if (!id) return undefined;
    var fullText = textOf(content);
    admitGiant(id, fullText);
    var retained = giants.get(id) === fullText;
    var parts = [];
    var kept = 0;
    var truncated = 0;
    for (var j = 0; j < content.length; j++) {
      var b = content[j];
      if (!b || b.type !== 'text' || typeof b.text !== 'string') { parts.push(b); continue; }
      var room = INGEST_KEEP - kept;
      if (room <= 0) { truncated += b.text.length; continue; }
      if (b.text.length <= room) { kept += b.text.length; parts.push(b); }
      else { kept = INGEST_KEEP; truncated += b.text.length - room; parts.push({ type: 'text', text: b.text.slice(0, room) }); }
    }
    parts.push({ type: 'text', text: '[truncated ' + truncated + ' of ' + total
      + ' chars; ' + (retained
        ? 'toolfold_read("' + id + '") returns the full text]'
        : 'full text not retained (call "' + id + '"); re-run if needed]') });
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
              var named = 'toolfold_read("' + key + '") returns the full text';
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
    if (giant !== null) bits.push('result:\n' + giant);
    else if (resultMsg) bits.push('result (' + (resultMsg.isError === true ? 'error' : 'ok') + '):\n' + textOf(resultMsg.content));
    return { ok: true, text: bits.join('\n') };
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
    name: 'toolfold_read',
    label: 'Read a folded tool result',
    description: 'Return the full original text of one folded or truncated tool round-trip (call arguments plus the complete result). Pass the id shown inside the "[folded]" or "[truncated]" record. The folded original is also restored in the conversation until your next user message, so read once and continue instead of re-running the command.',
    parameters: {
      type: 'object',
      properties: {
        call_id: { type: 'string', minLength: 1, maxLength: 256, description: 'Tool call id from the folded or truncated record.' },
      },
      required: ['call_id'],
      additionalProperties: false,
    },
    execute: async function (_toolCallId, params) {
      var id = params && typeof params.call_id === 'string' ? params.call_id : '';
      if (!id) throw new Error('call_id is required');
      var original = findOriginal(id);
      if (!original || original.ok !== true) {
        var reason = original && original.reason === 'not-retained'
          ? 'its full text was not retained (payload over the retention budget); re-run the command instead.'
          : original && original.reason === 'evicted'
            ? 'its full text is no longer available (registry evicted or lost on resume); re-run the command instead.'
            : 'no folded or truncated round-trip with that id exists in this session.';
        return { content: [{ type: 'text', text: 'Cannot recover ' + id + ': ' + reason }], isError: true };
      }
      if (!giants.has(String(id))) pinOriginal(id);
      return { content: [{ type: 'text', text: original.text }] };
    },
  });

  pi.on('context', function (event) {
    var messages = event && Array.isArray(event.messages) ? event.messages : null;
    if (!messages || messages.length === 0) return undefined;
    // Host text-only turns block every tool, toolfold_read included. Leave the history
    // unfolded for that request so the model never sees a summary it cannot expand.
    if (textOnlyTurnActive()) return undefined;

    // Turn boundary: pins live until the next user message (a compaction resets the
    // count too, which is fine — compaction drops the pinned entries anyway).
    var users = 0;
    for (var u = 0; u < messages.length; u++) if (messages[u] && messages[u].role === 'user') users += 1;
    if (users !== userSeen) {
      pinned.clear();
      pinnedChars = 0;
      userSeen = users;
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
      if (probe.end >= boundary || probe.hasImage || probe.chars < 80) continue;
      if (allFolded(probe)) continue;
      var already = false;
      for (var pb = 0; pb < probe.calls.length; pb++) if (isFoldedCall(probe.calls[pb])) already = true;
      if (already) continue;
      candidates.push(probe);
      candidateChars += probe.chars;
      candidateCalls += probe.callCount;
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
      }
      for (var m = 0; m < candidates.length; m++) {
        for (var mi = 0; mi < candidates[m].calls.length; mi++) markFolded(candidates[m].calls[mi].id, candidates[m].sizes[candidates[m].calls[mi].id] || 0);
      }
    }

    var out = null;
    for (var g = 0; g < trips.length; g++) {
      var unit = trips[g];
      if (unit.hasImage || unit.chars < 80) continue;
      var assistant = messages[unit.start];
      var blocks = assistant.content;
      var nextContent = [];
      var callsById = Object.create(null);
      var foldedAny = false;
      for (var k = 0; k < blocks.length; k++) {
        var block = blocks[k];
        if (block && block.type === 'toolCall' && foldable(String(block.id))) {
          var replaced = foldedCall(block);
          callsById[String(block.id)] = replaced;
          nextContent.push(replaced);
          foldedAny = true;
        } else {
          nextContent.push(block);
        }
      }
      // Fold per call, not per trip: a pinned call keeps its own payload verbatim while
      // its parallel siblings stay folded.
      if (!foldedAny) continue;
      if (out === null) out = messages.slice();
      out[unit.start] = Object.assign({}, assistant, { content: nextContent });
      for (var r = 0; r < unit.results.length; r++) {
        var result = unit.results[r];
        var foldedCallNow = callsById[String(result.toolCallId)];
        if (foldedCallNow) out[unit.indexes[r]] = foldedResult(result, foldedCallNow);
      }
    }

    return out === null ? undefined : { messages: out };
  });
}
`;
