/** Runs inside unmodified Pi, after every extension payload hook. */
export const PI_CACHE_RECOVERY_SOURCE = String.raw`
function installCindyCacheRecovery(pi) {
  const supported = (api) => api === 'openai-completions' || api === 'openai-responses';
  const fields = ['prompt_cache_key', 'prompt_cache_retention'];
  const ownedRegistries = new WeakSet();
  const nativeRegistry = ctx => ownedRegistries.has(ctx?.modelRegistry);
  const day = 24 * 60 * 60 * 1000;
  const home = process.env.CINDY_PI_CACHE_COMPAT_FILE;
  const file = home && home.replace(/^\$HOME(?=\/)/, () => homedir());
  let turn;
  let pendingInput;
  let directInput = false;
  let memory = Object.create(null);
  const pendingReleases = new Map();
  let routeRules = new Map();
  function rules() {
    try {
      const name = path.join(process.env.PI_CODING_AGENT_DIR || '', 'pi-cache-compatibility.json');
      if (statSync(name).size > 256 * 1024) return [];
      const value = JSON.parse(readFileSync(name, 'utf8'));
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  }
  function readRules() {
    return new Map(rules().flatMap(rule => {
      if (!rule || typeof rule !== 'object' || typeof rule.providerId !== 'string'
        || !/^[a-f0-9]{64}$/.test(rule.routeKey)) return [];
      return [[JSON.stringify([rule.provider, rule.id, rule.baseUrl, rule.api]),
        JSON.stringify([rule.providerId, rule.id, rule.routeKey])]];
    }));
  }
  function refreshRules() { routeRules = readRules(); }
  refreshRules();
  function route(model) {
    if (!supported(model?.api)) return;
    return routeRules.get(JSON.stringify([model.provider, model.id, model.baseUrl, model.api]));
  }
  function load() {
    if (!file) return { routes: Object.create(null) };
    try {
      const info = statSync(file);
      if (info.size > 256 * 1024) return;
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || !value.routes || typeof value.routes !== 'object' || Array.isArray(value.routes)) return;
      // Stable legacy grace, not a fresh lifetime on every app launch.
      for (const record of Object.values(value.routes)) {
        if (record && record.supportsLongCacheRetention === false && record.expiresAt === undefined
          && record.learnedAt === undefined && record.evidence === undefined) {
          record.learnedAt = info.mtimeMs;
          record.expiresAt = info.mtimeMs + 7 * day;
          record.evidence = 'explicit';
        }
      }
      return value;
    } catch (error) { return error?.code === 'ENOENT' ? { routes: Object.create(null) } : undefined; }
  }
  function active(record, now) {
    return record?.supportsLongCacheRetention === false && Number.isFinite(record.learnedAt) && record.learnedAt <= now
      && Number.isFinite(record.expiresAt) && record.expiresAt > record.learnedAt
      && ['explicit', 'opaque'].includes(record.evidence)
      && record.expiresAt <= record.learnedAt + (record.evidence === 'explicit' ? 7 : 1) * day && record.expiresAt > now;
  }
  // Participate in Desktop's ordinary advisory protocol, not its security lock.
  // Only acquisition waits; the held read/merge/rename/release has no await.
  function lockSnapshot(name) {
    try {
      const info = lstatSync(name);
      if (!info.isFile() || info.size > 4096) return;
      const text = readFileSync(name, 'utf8');
      let record;
      try { record = JSON.parse(text); } catch {}
      return { info, text, record };
    } catch { return; }
  }
  function dead(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
  }
  function stale(snapshot) {
    return snapshot && Date.now() - snapshot.info.mtimeMs > 10000
      && (!Number.isInteger(snapshot.record?.pid) || snapshot.record.pid <= 0 || dead(snapshot.record.pid));
  }
  function sameLock(left, right) {
    return left && right && ['dev', 'ino', 'size', 'mtimeMs'].every(key => left.info[key] === right.info[key])
      && left.text === right.text;
  }
  function gateReleased(name, nonce) {
    // Desktop's existing .released credential is bound to both the unique
    // gate filename and its UUID nonce. Read only a bounded, stable regular
    // file through one handle, with the same no-follow/root checks as Desktop.
    let fd;
    try {
      const marker = name + '.released';
      const normalize = value => process.platform === 'win32' ? value.replace(/^([A-Z]):/, (_, drive) => drive.toLowerCase() + ':') : value;
      const directory = normalize(realpathSync(path.dirname(name)));
      fd = openSync(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size > 4096n) return false;
      const matchesPath = () => {
        const link = lstatSync(marker, { bigint: true });
        const current = statSync(marker, { bigint: true });
        return !link.isSymbolicLink() && current.dev !== 0n && current.ino !== 0n
          && current.dev === before.dev && current.ino === before.ino
          && link.dev === before.dev && link.ino === before.ino
          && normalize(path.dirname(realpathSync(marker))) === directory;
      };
      if (!matchesPath()) return false;
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) return false;
        offset += count;
      }
      const after = fstatSync(fd, { bigint: true });
      if (!after.isFile() || !['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key])
        || !matchesPath()) return false;
      const value = JSON.parse(bytes.toString('utf8'));
      return value && typeof value === 'object' && !Array.isArray(value)
        && value.gateFile === path.basename(name) && typeof value.nonce === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.nonce)
        && (nonce === undefined || value.nonce === nonce);
    } catch { return false; }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
  }
  function gateBusy(lock, ownGate) {
    // Legacy gates are still observed by released Desktop versions.
    try {
      lstatSync(lock + '.reclaim');
      if (!stale(lockSnapshot(lock + '.reclaim'))) return true;
    } catch (error) { if (error?.code !== 'ENOENT') return true; }
    let entries;
    try { entries = readdirSync(lock + '.reclaim.d'); }
    catch (error) { return error?.code !== 'ENOENT'; }
    const active = [];
    for (const entry of entries) {
      if (!entry.startsWith('gate-') || !entry.endsWith('.json')) continue;
      const name = path.join(lock + '.reclaim.d', entry);
      const snapshot = lockSnapshot(name);
      if (!snapshot) return true;
      const record = snapshot.record;
      if (record?.state === 'released' || gateReleased(name, record?.nonce ?? undefined)) continue;
      if (stale(snapshot)) {
        const pid = Number(/^gate-(\d+)-/.exec(entry)?.[1]);
        if (record?.pid || dead(pid)) continue;
      }
      if (!Number.isFinite(record?.startedAt) || typeof record?.nonce !== 'string') return true;
      active.push({ name, record });
    }
    active.sort((a, b) => a.record.startedAt - b.record.startedAt || a.record.nonce.localeCompare(b.record.nonce)
      || a.name.localeCompare(b.name));
    return active.length > 0 && active[0].name !== ownGate;
  }
  async function releaseOwned(name, nonce) {
    pendingReleases.set(name, nonce);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const snapshot = lockSnapshot(name);
        if (!snapshot) {
          // An unreadable record is not proof that our lock disappeared.
          try { lstatSync(name); } catch (error) {
            if (error?.code === 'ENOENT' && pendingReleases.get(name) === nonce) pendingReleases.delete(name);
          }
          return;
        }
        if (snapshot.record?.nonce !== nonce) {
          if (pendingReleases.get(name) === nonce) pendingReleases.delete(name);
          return;
        }
        // The ownership check and removal stay synchronous. A delayed retry
        // must never remove a successor belonging to this same live PID.
        if (name !== file + '.lock' || !gateBusy(name)) {
          rmSync(name);
          if (pendingReleases.get(name) === nonce) pendingReleases.delete(name);
          return;
        }
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) return;
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
    }
    // Keep only the nonce we can prove we own, for the next input/write.
  }
  function recoverReleases() {
    for (const [name, nonce] of pendingReleases) void releaseOwned(name, nonce);
  }
  function reclaim(lock) {
    const candidate = lockSnapshot(lock);
    if (!stale(candidate)) return;
    const nonce = randomUUID();
    const directory = lock + '.reclaim.d';
    mkdirSync(directory, { recursive: true });
    const gate = path.join(directory, 'gate-' + process.pid + '-' + nonce + '.json');
    const record = { pid: process.pid, startedAt: Date.now(), nonce, state: 'held',
      processStartIdentity: 'start-ms:' + Math.round(Date.now() - process.uptime() * 1000) };
    writeFileSync(gate, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    const isolated = lock + '.stale-' + nonce;
    try {
      if (gateBusy(lock, gate) || !sameLock(lockSnapshot(lock), candidate)) return;
      renameSync(lock, isolated);
      if (sameLock(lockSnapshot(isolated), candidate)) rmSync(isolated);
      else { try { linkSync(isolated, lock); rmSync(isolated); } catch {} }
    } finally {
      // Unique gate names are never reused; retry cleanup without leaving a
      // live-owner gate behind or removing a different owner's gate.
      void releaseOwned(gate, nonce);
      try { rmdirSync(directory); } catch {}
    }
  }
  async function persist(key, record) {
    if (!file) return;
    const lock = file + '.lock';
    const nonce = randomUUID();
    const deadline = Date.now() + 1000;
    let held = false;
    let temporary;
    try {
      recoverReleases();
      mkdirSync(path.dirname(file), { recursive: true });
      do {
        try {
          if (!gateBusy(lock)) {
            const fd = openSync(lock, 'wx', 0o600);
            held = true;
            try { writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce })); }
            catch (error) { rmSync(lock); held = false; throw error; }
            finally { closeSync(fd); }
            if (!gateBusy(lock)) break;
            rmSync(lock); held = false;
          }
        } catch (error) {
          if (!['EEXIST', 'EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
          reclaim(lock);
        }
        if (Date.now() >= deadline) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      } while (true);
      const current = load();
      if (!current || (current.routes[key]?.learnedAt ?? 0) > record.learnedAt) return;
      for (const [otherKey, otherRecord] of Object.entries(current.routes)) {
        if (Number.isFinite(otherRecord?.expiresAt) && otherRecord.expiresAt <= record.learnedAt) delete current.routes[otherKey];
      }
      current.routes[key] = record;
      const data = JSON.stringify(current);
      if (Buffer.byteLength(data) > 256 * 1024) return;
      temporary = file + '.' + randomUUID() + '.tmp';
      writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
      if (memory[key] === record) delete memory[key];
    } catch { /* Storage failure must never undo a successful response. */ }
    finally {
      if (temporary) { try { rmSync(temporary, { force: true }); } catch {} }
      if (held) void releaseOwned(lock, nonce);
    }
  }
  function remember(key, evidence, startedAt) {
    const record = { supportsLongCacheRetention: false, evidence, learnedAt: startedAt,
      expiresAt: startedAt + (evidence === 'explicit' ? 7 : 1) * day };
    if ((memory[key]?.learnedAt ?? 0) > startedAt) return;
    memory[key] = record;
    void persist(key, record);
    return record;
  }
  function withoutCache(payload) {
    const next = { ...payload };
    for (const field of fields) delete next[field];
    return next;
  }
  function fingerprint(payload) {
    return createHash('sha256').update(JSON.stringify(withoutCache(payload), (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest('hex');
  }
  function requestIdentity(model, options) {
    // Request-only digest stays in memory, including any credential/header state.
    return fingerprint({ api: model?.api, provider: model?.provider, id: model?.id, baseUrl: model?.baseUrl,
      modelHeaders: model?.headers, headers: options?.headers, apiKey: options?.apiKey });
  }
  function rejectedFieldList(text) {
    let rest = text.trimStart().replace(/^\[\s*/, '');
    const result = [];
    while (rest) {
      const match = /^(?:(['"\x60])([a-z_][\w.-]*)\1|([a-z_][\w.-]*))/i.exec(rest);
      if (!match) break;
      const tail = rest.slice(match[0].length);
      // A comma may introduce prose ("use another option instead"). Bare
      // continuation fields must end at a list/sentence boundary; quoted fields
      // are explicit. This parses the list without naming vendors or options.
      if (result.length && !match[1] && !/^\s*(?:[,，;\].!?]|$)/.test(tail)) break;
      result.push((match[2] ?? match[3]).replace(/\.+$/, '').toLowerCase());
      const separator = /^\s*[,，]\s*/.exec(tail);
      if (!separator) break;
      rest = tail.slice(separator[0].length);
    }
    return result;
  }
  function failureKind(message, provider) {
    const text = message?.errorMessage;
    if (typeof text !== 'string' || text.length > 64 * 1024 || message.stopReason !== 'error'
      || message.content?.length || (message.usage?.output ?? 0) > 0) return;
    const prefix = text.startsWith('400:') ? '400:' : provider + ' API error (400):';
    if (!text.startsWith(prefix)) return;
    let body = text.slice(prefix.length).trim();
    let data;
    try { data = JSON.parse(body); } catch { /* Opaque 400 bodies remain eligible. */ }
    for (let depth = 0; data && typeof data === 'object' && depth < 4; depth++) {
      if (data.param != null && !fields.includes(data.param)) return;
      if (data.code === 'UNKNOWN_FIELD' && data.data?.field != null) {
        return fields.includes(data.data.field) ? 'explicit' : undefined;
      }
      if (typeof data.message === 'string') body = data.message;
      // Exclude known unrelated categories; unfamiliar gateway types stay opaque.
      if ([data.code, data.type].some(value => typeof value === 'string'
        && /auth|permission|forbidden|quota|billing|rate.?limit|model.?not.?found|context|length|content.?filter|policy|invalid.?(?:value|type)|missing.?required/i.test(value))) return;
      data = data.error;
    }
    if (/api.?key|unauthori[sz]ed|authentication|permission denied|quota|rate.?limit|model.{0,30}(?:not found|does not exist)|context.{0,25}(?:length|limit)|content.?filter|content.?policy|invalid.{0,15}value|鉴权|认证失败|额度|限流|模型不存在|上下文.{0,8}(?:超|长)|内容审核|参数值/i.test(body)) return;
    // Removing optional cache fields cannot supply a required value or repair
    // an explicitly invalid type. A generic invalid_parameter code alone does
    // not establish either condition and must retain its bounded contrast.
    if (/missing\s+required|(?:field|parameter|property|argument)\s+(?:is\s+)?required|required\s+(?:field|parameter|property|argument).{0,80}missing|invalid\s+type/i.test(body)) return;
    for (const pattern of [
      /invalid\s+(?:parameters?|fields?|arguments?|properties|property|options?)(?:\(s\))?[\s:=]*/gi,
      /(?:parameter|field|argument|property|option)\s*[:=]?\s*['"\x60]?([a-z_][\w.-]*)['"\x60]?\s+(?:is\s+)?invalid/gi,
    ]) {
      for (const match of body.matchAll(pattern)) {
        const invalid = match[1] ? [match[1].toLowerCase()]
          : rejectedFieldList(body.slice(match.index + match[0].length));
        if (invalid.some(field => !fields.includes(field))) return;
      }
    }
    // A named rejection is evidence even when a gateway omits structured param.
    // Parse the field relationship, never a list of vendor or parameter names.
    let cacheRejected = false;
    for (const pattern of [
      /(?:unsupported|unknown|unrecognized|unexpected)\s+(?:parameters?|fields?|arguments?|properties|property|options?)(?:\(s\))?[\s:=]*/gi,
      /(?:parameter|field|argument|property|option)\s*[:=]?\s*['"\x60]?([a-z_][\w.-]*)['"\x60]?\s+(?:is\s+)?(?:unsupported|unknown|unrecognized|unexpected|not\s+(?:supported|allowed|permitted))/gi,
      /(?:未知|不支持|不接受|无法识别)(?:的)?(?:请求)?(?:参数|字段|属性|选项)[\s:：=]*/gi,
      /(?:参数|字段|属性|选项)\s*[:：=]?\s*['"\x60]?([a-z_][\w.-]*)['"\x60]?\s*(?:不支持|不被支持|未知|无法识别)/gi,
    ]) {
      for (const match of body.matchAll(pattern)) {
        const rejected = match[1] ? [match[1].replace(/\.+$/, '').toLowerCase()]
          : rejectedFieldList(body.slice(match.index + match[0].length));
        for (const field of rejected) {
          if (!fields.includes(field)) return;
          cacheRejected = true;
        }
      }
    }
    return cacheRejected || /(?:unsupported|not supported|unknown|未知|不支持).{0,80}prompt_cache_(?:key|retention)|prompt_cache_(?:key|retention).{0,80}(?:unsupported|not supported|unknown|未知|不支持)/i.test(body) ? 'explicit' : 'opaque';
  }
  function invalidate() {
    pendingInput = undefined;
    if (turn) { turn.safe = false; turn.valid = false; }
  }
  pi.on('input', () => {
    // Queuing/steering invalidates the old trial immediately. It cannot arm a
    // budget for the new input until Pi actually starts that user message.
    directInput = false;
    invalidate();
  });
  pi.on('before_agent_start', () => { directInput = true; });
  pi.on('message_start', (event, ctx) => {
    if (event.message?.role !== 'user') return;
    // Pi represents both steer and followUp as user messages. Snapshot now,
    // but decide ownership only after the supervisor sees the public event.
    invalidate();
    recoverReleases();
    for (const [key, record] of Object.entries(memory)) void persist(key, record);
    const inputRules = readRules();
    const records = load()?.routes ?? Object.create(null);
    for (const [key, record] of Object.entries(memory)) {
      if ((records[key]?.learnedAt ?? 0) < record.learnedAt) records[key] = record;
    }
    const startedAt = Date.now();
    const learned = new Set(Object.keys(records).filter(key => active(records[key], startedAt)));
    if (directInput) {
      routeRules = inputRules;
      turn = { safe: true, valid: true, attempted: false, learned };
    }
    if (!directInput || !nativeRegistry(ctx)) {
      // Pi's message_end hooks may replace the message in place. Capture the
      // receipt now. Modern direct inputs need no query; older host recovery
      // still needs this exact input's snapshot, never an agent_start guess.
      const key = createHash('sha256').update(JSON.stringify(event.message)).digest('hex');
      pendingInput = { key, ctx, direct: directInput, learned, inputRules };
    }
    directInput = false;
  });
  async function settleInput() {
    const input = pendingInput;
    if (!input) return;
    if (!input.promise) input.promise = (async () => {
      let followUp = false;
      let timer;
      try {
        // Older RPC ExtensionContext versions do not expose mode.
        if (input.ctx?.mode && input.ctx.mode !== 'rpc') throw new Error('not RPC');
        const key = input.key;
        const raw = await Promise.race([
          input.ctx.ui.input('cindy:cache-input', JSON.stringify({ key, direct: input.direct })),
          new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 5000); }),
        ]);
        if (typeof raw === 'string') {
          const receipt = JSON.parse(raw);
          followUp = receipt?.key === key && receipt.followUp === true;
        }
      } catch { /* Unconfirmed queued provenance must not reopen recovery. */ }
      finally { if (timer) clearTimeout(timer); }
      if (pendingInput !== input || input.ctx?.signal?.aborted) return;
      if (!input.direct && followUp) {
        routeRules = input.inputRules;
        turn = { safe: true, valid: true, attempted: false, learned: input.learned };
      }
      pendingInput = undefined;
    })();
    await input.promise;
  }
  for (const name of ['tool_call', 'tool_execution_start', 'model_select', 'session_switch', 'session_shutdown']) {
    pi.on(name, invalidate);
  }
  pi.on('before_provider_request', async (event, ctx) => {
    // Older registries cannot safely restore an extension provider's ownership.
    // Keep their existing host recovery usable without registering a provider;
    // modern registries leave all payload handling to the final stream wrapper.
    if (nativeRegistry(ctx)) return;
    await settleInput();
    const key = route(ctx.model);
    // Use the same input snapshot as the modern wrapper, including tool rounds
    // across expiry. Before any input exists, preserve native preparation calls.
    if (!key || !(turn ? turn.learned.has(key) : active(load()?.routes[key], Date.now()))) return;
    const payload = event.payload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) return withoutCache(payload);
  });
  return {
    refreshRules,
    ownRegistry: registry => ownedRegistries.add(registry),
    accepts: model => Boolean(route(model)),
    wrap(model, options, invoke, provider = model.provider) {
      return (async function* () {
        await settleInput();
        const key = route(model);
        if (!key || !turn) { yield* invoke(options); return; }
        const owner = turn;
        const startedAt = Date.now();
        const learned = owner.learned.has(key);
        let originalFingerprint;
        let originalIdentity;
        let hasCache = false;
        let skipped = false;
        const sameInput = () => turn === owner && owner.valid && owner.safe && !options?.signal?.aborted;
        const requestOptions = (trial) => ({ ...options,
          onPayload: async (payload, requestModel) => {
            const replacement = await options?.onPayload?.(payload, requestModel);
            const finalPayload = replacement === undefined ? payload : replacement;
            if (!finalPayload || typeof finalPayload !== 'object' || Array.isArray(finalPayload)) return finalPayload;
            if (trial) {
              if (!sameInput() || fingerprint(finalPayload) !== originalFingerprint
                || requestIdentity(requestModel, options) !== originalIdentity) {
                skipped = true;
                throw new Error('CINDY_CACHE_RETRY_CONTEXT_CHANGED');
              }
              return withoutCache(finalPayload);
            }
            hasCache = fields.some(field => Object.hasOwn(finalPayload, field));
            if (hasCache && sameInput() && !owner.attempted && requestModel?.id === model.id
              && requestModel?.api === model.api && requestModel?.baseUrl === model.baseUrl) {
              originalFingerprint = fingerprint(finalPayload);
              originalIdentity = requestIdentity(requestModel, options);
            }
            return learned || owner.trialKey === key ? withoutCache(finalPayload) : finalPayload;
          },
        });
        for await (const event of invoke(requestOptions(false))) {
          if (event.type !== 'error') {
            // A successful response start rules out retrying an in-stream failure.
            owner.safe = false;
            yield event;
            continue;
          }
          const evidence = failureKind(event.error, provider);
          if (!evidence || learned || !hasCache || !originalFingerprint || !sameInput() || owner.attempted) {
            yield { ...event, error: { ...event.error, cindyCacheRecoveryHandled: true } };
            continue;
          }
          owner.attempted = true;
          owner.trialKey = key;
          for await (const retried of invoke(requestOptions(true))) {
            if (skipped) {
              yield options?.signal?.aborted ? retried : { ...event, error: { ...event.error, cindyCacheRecoveryHandled: true } };
              return;
            }
            if (retried.type === 'done' && turn === owner && owner.valid && !options?.signal?.aborted
              && ['stop', 'toolUse'].includes(retried.message?.stopReason)) {
              const record = remember(key, evidence, startedAt);
              if (record) owner.learned.add(key);
            }
            if (retried.type !== 'error') owner.safe = false;
            yield retried.type === 'error'
              ? { ...retried, error: { ...retried.error, cindyCacheRecoveryHandled: true } } : retried;
          }
          return;
        }
      })();
    },
  };
}
`;
