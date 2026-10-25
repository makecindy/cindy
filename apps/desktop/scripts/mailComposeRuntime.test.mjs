import assert from "node:assert/strict";
import fs from "node:fs";
import { URL } from "node:url";
import { webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { test } from "vitest";
import { JSDOM } from 'jsdom';
import { isSyntheticTriggerText, syntheticTriggerKind } from "@cindy/maker-shared/synthetic-trigger";

const source = fs.readFileSync(new URL("../../../packages/plugin-runtime/src/mailComposeRuntime.js", import.meta.url), "utf8");
const copy = (value) => JSON.parse(JSON.stringify(value));
const { DOMParser } = new JSDOM('').window;

// Behavioral adapter contract, not real-provider integration. Exercise three
// different identity/receipt shapes through the same production flow.
function fixture({
  providerName = "QQ 邮箱",
  draftStorage = "server",
  shape = "imap",
  write,
  read,
  remove,
  supportsDelete = true,
  autoSend = true,
  acceptCard = true,
  richText = false,
  allowCardRead = true,
} = {}) {
  let kv = {},
    revision = 1,
    timerId = 0,
    clock = 100000,
    flow;
  const cards = [],
    continuations = [],
    writes = [],
    reads = [],
    deletes = [],
    timers = new Map(),
    locks = new Map();
  let current = {
    status: "read_back",
    draftId: "logical-draft",
    fingerprint: "revision-1",
    locator:
      shape === "imap"
        ? { folder: "草稿箱", uid: 42, uidValidity: "700" }
        : { id: "native-draft" },
    headers: {
      from: "self@example.test",
      to: "David <david@example.test>",
      cc: "",
      bcc: "",
      subject: "Meeting",
    },
    editor: { editable: true, body: "Original", quote: "", ...(richText ? { format: 'html', bodyHtml: '<p style="color:red">Original</p>', quoteHtml: '' } : {}) },
    attachments: [],
  };
  const account = {
    ok: true,
    accountId: "account-a",
    accountEmail: "self@example.test",
  };
  const context = createContext({
    DOMParser,
    crypto: webcrypto,
    TextEncoder,
    Date: class extends Date { static now() { return clock; } },
    setTimeout(fn, delay) {
      const id = ++timerId;
      if (delay === 10000 && autoSend) queueMicrotask(fn);
      else timers.set(id, { fn, at: clock + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    navigator: {
      locks: {
        request(name, fn) {
          const next = (locks.get(name) || Promise.resolve()).then(fn);
          locks.set(
            name,
            next.catch(() => {}),
          );
          return next;
        },
      },
    },
    async fetch(url, options = {}) {
      if (url === "/app-context")
        return {
          ok: true,
          json: async () => ({ context: { locale: "zh-CN" } }),
        };
      assert.equal(url, "/kv");
      if (options.method === "PUT") kv = JSON.parse(options.body);
      return { ok: true, json: async () => copy(kv) };
    },
    cindy: {
      onHostMessage() {},
      async send(card) {
        if (card.type === 'mail-draft-read') {
          const stored = cards.findLast(c => c.draft && c.callId === card.callId);
          if (!stored || !allowCardRead) return { ok: false };
          const draft = copy(stored.draft);
          // Host persists status-only patches as part of the same card.
          for (const update of cards.slice(cards.indexOf(stored) + 1)) {
            if (update.callId === card.callId && update.statusOnly) Object.assign(draft, copy(update.statusOnly));
          }
          return { ok: true, draft };
        }
        cards.push(copy(card));
        return { ok: acceptCard || !card.statusOnly?.pendingSend };
      },
      agent: {
        async run(event) {
          continuations.push(copy(event));
          return { ok: true };
        },
      },
    },
  });
  runInContext(source, context);
  const adapter = {
    providerName,
    draftStorage,
    richText,
    ...(supportsDelete ? { async deleteDraft(request) {
      deletes.push(copy(request));
      assert.deepEqual(copy(request.record.locator), current.locator);
      return remove ? remove(request) : { ok: true, data: { deleted: true, draftId: current.draftId } };
    } } : {}),
    async selectAccount(id) {
      return id === account.accountId
        ? account
        : { ok: false, message: "账号不存在" };
    },
    async readDraft({ record, sourceCallId }) {
      reads.push({ record: copy(record), sourceCallId });
      if (read) {
        const result = await read();
        if (result) return result;
      }
      return { ok: true, data: { readBack: copy(current) } };
    },
    async writeDraft(request) {
      writes.push(copy(request));
      if (write) {
        const result = await write(request, writes.length);
        if (result) return result;
      }
      if (request.record.fingerprint !== current.fingerprint)
        return { ok: false, execution: 'not_executed', stale: copy(current), message: 'Changed' };
      assert.deepEqual(copy(request.record.locator), current.locator);
      assert.equal(request.record.fingerprint, current.fingerprint);
      if (request.send)
        return {
          ok: true,
          data: {
            sent: true,
            receipt:
              shape === "graph"
                ? { accepted: true, delivery_confirmed: false, status: 202 }
                : {
                    message_id: "<sent@example.test>",
                    accepted: ["david@example.test"],
                    rejected: [],
                  },
          },
        };
      current = {
        ...current,
        fingerprint: "revision-" + ++revision,
        locator:
          shape === "imap"
            ? { ...current.locator, uid: current.locator.uid + 1 }
            : current.locator,
        headers: {
          ...current.headers,
          ...Object.fromEntries(
            ["to", "cc", "bcc", "subject"].map((name) => [
              name,
              request.fields[name],
            ]),
          ),
        },
        editor: {
          ...current.editor,
          body: request.fields.body,
          quote: request.fields.quote,
          ...(richText ? { bodyHtml: request.fields.bodyHtml, quoteHtml: request.fields.quoteHtml } : {}),
        },
        ...(richText ? { attachments: JSON.parse(request.fields.attachmentItems) } : {}),
      };
      return { ok: true, data: { readBack: copy(current) } };
    },
  };
  function restart() {
    timers.clear();
    flow = context.cindyMail.register(adapter);
  }
  restart();
  const values = () => ({
    to: current.headers.to,
    cc: current.headers.cc,
    bcc: current.headers.bcc,
    subject: current.headers.subject,
    body: current.editor.body,
    quote: current.editor.quote,
    ...(richText ? { bodyHtml: current.editor.bodyHtml, quoteHtml: current.editor.quoteHtml, attachmentItems: JSON.stringify(current.attachments) } : {}),
  });
  const action = (operation) => {
    const card = cards.findLast((card) => card.draft);
    return `mail:${operation}:${card.draft.key}`;
  };
  return {
    cards,
    continuations,
    writes,
    reads,
    deletes,
    values,
    action,
    restart,
    current: () => copy(current),
    kv: () => copy(kv),
    relocate: () => {
      current.locator = { ...current.locator, uid: current.locator.uid + 10 };
    },
    externalEdit: (fields = {}) => {
      current.fingerprint = 'external-' + ++revision;
      for (const [name, value] of Object.entries(fields)) {
        if (name === 'attachments') current.attachments = value;
        else if (name in current.headers) current.headers[name] = value;
        else current.editor[name] = value;
      }
    },
    present: () =>
      flow.present({ callId: "card-call" }, account, copy(current)),
    tool: (operation, extra = {}) =>
      flow.beforeTool({
        operation,
        account: account.accountId,
        draftId: current.draftId,
        readOnly: false,
        sourceCallId: "agent-call",
        ...extra,
      }),
    resolve: () => flow.resolveDraft(account.accountId, current.draftId),
    card: (operation, fields = values(), extra = {}) =>
      flow.handleCard({
        actionId: action(operation),
        callId: "card-call",
        userActionToken: "host-click-token",
        formChange: operation === "change",
        formValues: fields,
        ...extra,
      }),
    waitCountdown: async () => {
      for (let i = 0; i < 300 && ![...timers.values()].some(t => t.at === clock + 10000); i++) await Promise.resolve();
      assert.ok([...timers.values()].some(t => t.at === clock + 10000), "countdown armed");
    },
    advance: async (ms) => {
      clock += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); await timer.fn(); }
    },
    flush: async () => {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        await timer.fn();
      }
    },
  };
}

// Reading before an AI edit must not publish the old mail at the new tool call.
// The saved revision is presented only after the provider update completes.
for (const providerName of ['Gmail', 'QQ 邮箱']) test(providerName + ': unchanged reads keep the existing card until an update is ready', async () => {
  const f = fixture({ providerName, richText: true });
  await f.present();
  const key = f.cards.at(-1).draft.key;
  const read = await f.tool('get');
  assert.equal(read.data.readBack.editor.body, 'Original');
  assert.equal(f.cards.length, 1);
  assert.equal(await f.tool('update'), null);
  assert.equal(f.cards.length, 1);
  f.externalEdit({ body: 'Updated text', bodyHtml: '', format: 'text' });
  await f.present();
  assert.equal(f.cards.length, 2);
  assert.notEqual(f.cards.at(-1).draft.key, key);
  assert.equal(f.cards.at(-1).draft.fields.find(f => f.name === 'body').value, 'Updated text');
  assert.equal(f.writes.length, 0);
});
test('a draft read in another task still presents its own card', async () => {
  const f = fixture({ allowCardRead: false });
  await f.present();
  await f.tool('get');
  assert.equal(f.cards.length, 2);
  assert.equal(f.cards.at(-1).callId, 'agent-call');
});

// The plain quote editor and HTML MIME alternative must describe the same reply.
for (const quote of ['Updated <quote>\nSecond line', '']) test('editing the plain quote updates or clears its HTML alternative: ' + JSON.stringify(quote), async () => {
  const f = fixture({ richText: true });
  f.externalEdit({ quote: 'Original quote', quoteHtml: '<blockquote><b>Original quote</b></blockquote>' });
  await f.present();
  const values = f.values();
  await f.card('change', { ...values, quote: 'Intermediate' });
  await f.card('change', { ...values, quote });
  assert.ok((await f.tool('send')).ok);
  const sent = f.writes.find(x => x.send).fields;
  assert.equal(sent.quote, quote);
  assert.equal(sent.quoteHtml, quote ? '<div>Updated &lt;quote&gt;<br>Second line</div>' : '');
});
test('editing other fields preserves authored HTML quotes byte for byte', async () => {
  const f = fixture({ richText: true });
  const quoteHtml = '<blockquote style="color:red"><b>Original quote</b></blockquote>';
  f.externalEdit({ quote: 'Original quote', quoteHtml });
  await f.present();
  await f.card('change', { ...f.values(), subject: 'New subject' });
  assert.ok((await f.tool('send')).ok);
  assert.equal(f.writes.find(x => x.send).fields.quoteHtml, quoteHtml);
});

// Regression: the real sent reply nested a full HTML document inside its quote.
// Existing adapter tests covered edits, not outgoing HTML structure or CID integrity.
// Unit tier: production present/send entries, fake providers, no network or real sends.
for (const providerName of ['Gmail', 'QQ 邮箱']) test(providerName + ': shared formatting repairs quoted documents before preview/save/send', async () => {
  const f = fixture({ providerName, richText: true });
  f.externalEdit({
    quote: '\nOriginal message',
    quoteHtml: '<br><br><div class="gmail_quote"><div>Sender wrote:</div><blockquote><!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body style="font-family:Georgia;background:#eee"><table width="600"><tr><td><img src="cid:card@test" width="544">原文</td></tr></table></body></html></blockquote></div>',
    attachments: [{ key: 'image-key', filename: 'image-1', mimeType: 'image/png', bytes: 123, contentId: 'card@test' }],
  });
  await f.present();
  const shown = Object.fromEntries(f.cards.findLast(c => c.draft).draft.fields.map(x => [x.name, x.value]));
  assert.doesNotMatch(shown.quoteHtml, /<!doctype|<\/?(?:html|head|body)\b/i);
  const doc = new DOMParser().parseFromString(shown.quoteHtml, 'text/html');
  assert.equal(doc.querySelector('blockquote [style]')?.style.fontFamily, 'Georgia');
  assert.equal(doc.querySelector('img')?.getAttribute('src'), 'cid:card@test');
  assert.equal(doc.querySelector('table')?.getAttribute('width'), '600');
  assert.equal(JSON.parse(shown.attachmentItems)[0].filename, 'image-1.png');
  assert.ok((await f.tool('send')).ok);
  assert.equal(f.writes.filter(x => !x.send).length, 1);
  assert.equal(f.writes.find(x => x.send).fields.quoteHtml, shown.quoteHtml);
  assert.equal(f.current().editor.quoteHtml, shown.quoteHtml);
});

test('shared send blocks broken inline images and permits an explicit correction', async () => {
  const f = fixture({ richText: true });
  f.externalEdit({ bodyHtml: '<p>Hello<img src="cid:missing@test"></p>' });
  await f.present();
  const blocked = await f.tool('send');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.execution, 'not_executed');
  assert.equal(f.writes.length, 0);
  // The assistant can correct the draft instead of being stuck behind validation.
  assert.equal(await f.tool('update'), null);
  await f.card('change', { ...f.values(), bodyHtml: '<p>Hello</p>' });
  assert.ok((await f.tool('send')).ok);
});

test('shared formatting derives missing plain text and replaces a preview URL with its attachment CID', async () => {
  const f = fixture({ richText: true });
  f.externalEdit({ body: '', bodyHtml: '<html><body style="color:red"><p>Hello</p><p>World<img src="cindy-media://image"></p></body></html>',
    attachments: [{ key: 'image', filename: 'photo.png', mimeType: 'image/png', bytes: 123, contentId: 'photo@test', previewUrl: 'cindy-media://image' }] });
  await f.present();
  assert.ok((await f.tool('send')).ok);
  const sent = f.writes.find(x => x.send).fields;
  assert.match(sent.body, /Hello\n+World/);
  assert.match(sent.bodyHtml, /src="cid:photo@test"/);
  assert.doesNotMatch(sent.bodyHtml, /cindy-media:/);
});

// #6404: src/background/inline-style tests missed stylesheet and srcset paths.
// Production tool/card send entries must inspect body and quote using one policy.
for (const name of ['bodyHtml', 'quoteHtml']) for (const syntax of ['css', 'srcset'])
  for (const url of ['cid:missing@test', 'file:///private/image.png'])
    test(`shared send validates ${name} ${syntax} image ${url}`, async () => {
      const f = fixture({ richText: true });
      f.externalEdit({ [name]: syntax === 'css'
        ? `<style>.photo { background-image:url('${url}') }</style><p class="photo">Photo</p>`
        : `<picture><source srcset="https://example.test/photo.png 1x, ${url} 2x"><img src="https://example.test/photo.png"></picture>` });
      await f.present();
      if (name === 'bodyHtml') {
        const result = await f.tool('send');
        assert.equal(result.ok, false);
        assert.equal(result.execution, 'not_executed');
      } else await f.card('send', Object.fromEntries(f.cards.findLast(c => c.draft).draft.fields.map(x => [x.name, x.value])));
      assert.equal(f.writes.length, 0);
    });

test('shared formatting preserves styles and srcset descriptors while reconnecting image bytes', async () => {
  const f = fixture({ richText: true });
  const html = '<style>.photo{background:url("cindy-media://image")}</style><picture><source srcset="data:image/png;base64,AAAA 1x, cindy-media://image 2x"><img src="cid:photo@test"></picture>';
  f.externalEdit({ bodyHtml: html, quoteHtml: html,
    attachments: [{ key: 'image', filename: 'photo.png', mimeType: 'image/png', bytes: 123, contentId: 'photo@test', previewUrl: 'cindy-media://image' }] });
  await f.present();
  const shown = Object.fromEntries(f.cards.findLast(c => c.draft).draft.fields.map(x => [x.name, x.value]));
  for (const name of ['bodyHtml', 'quoteHtml']) {
    assert.doesNotMatch(shown[name], /cindy-media:/);
    const doc = new DOMParser().parseFromString(shown[name], 'text/html');
    assert.match(doc.querySelector('style').textContent, /url\("cid:photo@test"\)/);
    assert.equal(doc.querySelector('source').getAttribute('srcset'), 'data:image/png;base64,AAAA 1x, cid:photo@test 2x');
  }
  assert.ok((await f.tool('send')).ok);
  for (const name of ['bodyHtml', 'quoteHtml']) assert.equal(f.writes.find(x => x.send).fields[name], shown[name]);
});

test('a provider that reintroduces malformed HTML cannot proceed to sending', async () => {
  const f = fixture({ richText: true, write: request => {
    if (request.send) return;
    return { ok: true, data: { readBack: { ...request.readBack, fingerprint: 'saved-but-unformatted',
      editor: { ...request.readBack.editor, body: 'Changed', bodyHtml: '<html><body><p>Changed</p></body></html>' } } } };
  } });
  await f.present();
  await f.card('change', { ...f.values(), body: 'Changed', bodyHtml: '<p>Changed</p>' });
  const result = await f.tool('send');
  assert.equal(result.ok, false);
  assert.equal(result.format, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].send, false);
});

test('formatting never restores text intentionally cleared in the plain editor', async () => {
  const f = fixture({ richText: true });
  f.externalEdit({ format: 'text' });
  await f.present();
  await f.card('change', { ...f.values(), body: '' });
  await f.flush();
  assert.equal(f.writes[0].fields.body, '');
});

for (const [providerName, shape] of [
  ["Gmail", "api"],
  ["QQ 邮箱", "imap"],
  ["163 邮箱", "imap"],
  ["iCloud Mail", "imap"],
  ["Yahoo Mail", "imap"],
  ["Outlook", "graph"],
]) {
  test(
    providerName +
      " adapter: edits, model read, card/model send race and receipt share one draft",
    async () => {
      const f = fixture({ providerName, shape });
      assert.equal(await f.present(), true);
      const fields = {
        ...f.values(),
        body: "Latest edit",
        cc: "copy@example.test",
      };
      await f.card("change", fields);
      assert.equal(f.writes.length, 0);
      const read = await f.tool("get");
      assert.equal(read.data.readBack.editor.body, fields.body);
      assert.equal(read.data.readBack.headers.cc, fields.cc);
      assert.equal(f.writes.length, 1);
      assert.equal((await f.resolve()).draftId, "logical-draft");
      if (shape === "imap") assert.equal((await f.resolve()).locator.uid, 43);
      await Promise.all([f.tool("send"), f.card("send", fields)]);
      assert.equal(f.writes.filter((request) => request.send).length, 1);
      const repeated = await f.tool("send");
      assert.equal(repeated.data.alreadySent, true);
      if (shape === "graph")
        assert.deepEqual(copy(repeated.data.receipt), {
          accepted: true,
          delivery_confirmed: false,
          status: 202,
        });
      else
        assert.deepEqual(copy(repeated.data.receipt.accepted), [
          "david@example.test",
        ]);
      assert.doesNotMatch(JSON.stringify(f.kv()), /Latest edit|copy@example/);
      assert.ok(
        f.cards.some((card) => card.draft?.status.includes("已同步到 " + providerName)),
      );
    },
  );
}

test("an external locator change with identical content is adopted on read", async () => {
  const f = fixture();
  await f.present();
  f.relocate();
  await f.tool("get");
  assert.equal((await f.resolve()).locator.uid, 52);
  assert.equal((await f.tool("send")).ok, true);
  assert.equal(f.writes[0].record.locator.uid, 52);
});

test("card send alone continues with the provider receipt; model send does not start another turn", async () => {
  for (const entry of ["card", "model"]) {
    const f = fixture({ providerName: "Outlook", shape: "graph" });
    await f.present();
    if (entry === "card") await f.card("send");
    else await f.tool("send");
    assert.equal(f.continuations.length, entry === "card" ? 1 : 0);
    if (entry === "card") {
      assert.equal(f.continuations[0].userActionToken, "host-click-token");
      assert.equal(f.continuations[0].event.provider, "Outlook");
      assert.equal(f.continuations[0].event.receipt.delivery_confirmed, false);
      // Regression: the internal send receipt appeared as a user bubble. Use
      // the shared desktop/mobile visibility rule while retaining Agent input.
      const request = f.continuations[0];
      const prompt = request.promptTemplate.replace(/\{\{user_message\}\}|\{\{event_json\}\}/g,
        key => key === "{{user_message}}" ? request.userMessage : JSON.stringify(request.event));
      assert.equal(isSyntheticTriggerText(prompt), true);
      assert.equal(syntheticTriggerKind(prompt), "generic");
      assert.ok(prompt.includes(JSON.stringify(request.event)));
      assert.ok(prompt.includes("不要重复发送"));
    }
  }
});

test("local storage is labeled honestly and still flushes edits before send", async () => {
  const f = fixture({
    providerName: "SMTP",
    draftStorage: "local",
    shape: "local",
  });
  await f.present();
  await f.card("change", { ...f.values(), body: "Local edit" });
  await f.flush();
  assert.ok(f.cards.at(-1).draft.status.includes("已保存到本地草稿"));
  assert.equal(
    f.cards.some((card) => /已同步到|正在同步到/.test(card.draft?.status)),
    false,
  );
  await f.tool("send");
  assert.equal(f.writes.at(-1).fields.body, "Local edit");
});

test('mailbox autosave waits for two idle seconds while publishing local edits immediately', async () => {
  const f = fixture({ write: async () => {
    assert.equal(f.cards.at(-1).draft.state, 'syncing');
  } });
  await f.present();
  await f.card('change', { ...f.values(), body: 'First' });
  await f.advance(1500);
  await f.card('change', { ...f.values(), body: 'Latest' });
  const pending = f.cards.at(-1).draft;
  assert.equal(pending.fields.find(field => field.name === 'body').value, 'Latest');
  assert.equal(pending.state, 'draft');
  assert.equal(pending.status, '修改已保留，等待同步');
  await f.advance(1999);
  assert.equal(f.writes.length, 0);
  await f.advance(1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.current().editor.body, 'Latest');
  assert.equal(f.cards.at(-1).draft.state, 'draft');
  assert.ok(f.cards.at(-1).draft.status.includes('已同步到'));
});

test('typing during an autosave gets a new idle period instead of an immediate second write', async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture({ write: async (_, number) => {
    if (number === 1) { started(); await wait; }
  } });
  await f.present();
  await f.card('change', { ...f.values(), body: 'First' });
  const saving = f.advance(2000);
  await ready;
  await f.card('change', { ...f.values(), body: 'Still typing' });
  release();
  await saving;
  assert.equal(f.writes.length, 1);
  assert.equal(f.current().editor.body, 'First');
  assert.equal(f.cards.at(-1).draft.status, '修改已保留，等待同步');
  await f.advance(1999);
  assert.equal(f.writes.length, 1);
  await f.advance(1);
  assert.equal(f.writes.length, 2);
  assert.equal(f.current().editor.body, 'Still typing');
});

test('explicit send flushes pending edits without waiting for the autosave timer', async () => {
  const f = fixture();
  await f.present();
  await f.card('change', { ...f.values(), body: 'Ready to send' });
  assert.equal(f.writes.length, 0);
  assert.equal((await f.tool('send')).ok, true);
  assert.deepEqual(f.writes.map(request => [request.send, request.fields.body]), [
    [false, 'Ready to send'], [true, 'Ready to send'],
  ]);
  await f.advance(2000);
  assert.equal(f.writes.length, 2);
});

test('an autosave queued behind a slow write cannot bypass newer typing debounce', async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture({ write: async (_, number) => {
    if (number === 1) { started(); await wait; }
  } });
  await f.present();
  await f.card('change', { ...f.values(), body: 'First' });
  const saving = f.advance(2000);
  await ready;
  await f.card('change', { ...f.values(), body: 'Second' });
  const queued = f.advance(2000);
  await f.card('change', { ...f.values(), body: 'Third' });
  release();
  await Promise.all([saving, queued]);
  assert.equal(f.writes.length, 1);
  await f.advance(1999);
  assert.equal(f.writes.length, 1);
  await f.advance(1);
  assert.equal(f.writes.length, 2);
  assert.equal(f.current().editor.body, 'Third');
});

test("a newer edit during IMAP save is saved to the replacement UID before send", async () => {
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    write: async (_, number) => {
      if (number === 1) {
        started();
        await wait;
      }
    },
  });
  await f.present();
  await f.card("change", { ...f.values(), body: "First" });
  const saving = f.flush();
  await ready;
  await f.card("change", { ...f.values(), body: "Newest" });
  const sending = f.tool("send");
  release();
  await saving;
  assert.equal((await sending).ok, true);
  assert.deepEqual(
    f.writes.map((request) => request.record.locator.uid),
    [42, 43, 44],
  );
  assert.equal(f.writes.at(-1).fields.body, "Newest");
});

test("unknown/malformed send receipts never retry, including after a plugin restart", async () => {
  for (const write of [
    async () => {
      throw new Error("lost transport");
    },
    async () => ({ ok: true, data: {} }),
  ]) {
    const f = fixture({ write });
    await f.present();
    assert.equal((await f.tool("send")).execution, "unknown");
    f.restart();
    assert.equal((await f.tool("send")).execution, "unknown");
    assert.equal(f.writes.length, 1);
  }
});

test("read-only and wrong-card events cannot flush edits or send; restart reconnects the original draft", async () => {
  const f = fixture();
  await f.present();
  await f.card("send", f.values(), { callId: "other-call" });
  assert.equal(f.writes.length, 0);
  await f.card("change", { ...f.values(), body: "Pending edit" });
  assert.equal(
    (await f.tool("get", { readOnly: true })).execution,
    "not_executed",
  );
  assert.equal(
    (await f.tool("send", { readOnly: true })).execution,
    "not_executed",
  );
  assert.equal(f.writes.length, 0);
  await f.flush();
  f.restart();
  assert.equal((await f.tool("send")).ok, true);
  assert.equal(f.reads.length, 1);
  assert.equal(f.writes.at(-1).fields.body, 'Pending edit');
});

test('old cards reconnect after restart, keep the latest keystroke and save through the original identity', async () => {
  const f = fixture(); await f.present();
  const key = f.cards.at(-1).draft.key;
  f.restart(); f.relocate();
  await Promise.all([
    f.card('change', { ...f.values(), body: 'First' }),
    f.card('change', { ...f.values(), body: 'Latest typing' }),
  ]);
  await f.flush();
  assert.equal(f.reads.length, 1);
  assert.equal(f.current().editor.body, 'Latest typing');
  assert.equal(f.cards.at(-1).draft.key, key);
  assert.equal(f.writes.some(w => w.send), false);
});

test('restart with an external change preserves local typing and never overwrites or sends', async () => {
  const f = fixture(); await f.present(); const original = f.values();
  f.restart(); f.externalEdit({ body: 'Remote replacement' });
  await f.card('change', { ...original, body: 'Keep my unsynced edit' });
  await f.flush();
  assert.equal(f.writes.length, 0);
  assert.equal(f.cards.at(-1).draft.fields.find(f => f.name === 'body').value, 'Keep my unsynced edit');
  assert.equal(f.cards.at(-1).draft.state, 'error');
  assert.equal((await f.tool('send')).stale, true);
  assert.equal(f.writes.length, 0);
  const viewCount = f.cards.length;
  const read = await f.tool('get');
  assert.equal(read.data.cardEdits.body, 'Keep my unsynced edit');
  assert.equal(read.data.readBack.editor.body, 'Remote replacement');
  assert.equal(f.cards.length, viewCount);
  assert.match(f.cards.at(-1).draft.status, /正文/);
});

// Regression: restore/save treated every changed provider fingerprint as a
// conflict. Exercise actual card/model entry points, including restart (unit).
test('revision-only changes and one-sided edits reconnect without conflicts', async () => {
  for (const change of [{}, { subject: 'Remote subject' }]) {
    const f = fixture(); await f.present(); const original = f.values();
    f.restart(); f.externalEdit(change);
    await f.card('change', { ...original, body: 'Local typing' });
    await f.flush();
    assert.equal(f.current().editor.body, 'Local typing');
    assert.equal(f.current().headers.subject, change.subject || original.subject);
    assert.equal(f.cards.at(-1).draft.state, 'draft');
  }
});

test('restart restores unsynced card edits for model send and merges separate text ranges', async () => {
  const f = fixture(); await f.present();
  await f.card('change', { ...f.values(), body: 'Dear Original' });
  f.restart(); f.externalEdit({ body: 'Original wishes', cc: 'copy@example.test' });
  assert.equal((await f.tool('send')).ok, true);
  assert.equal(f.writes.at(-1).fields.body, 'Dear Original wishes');
  assert.equal(f.writes.at(-1).fields.cc, 'copy@example.test');
  assert.equal(f.writes.filter(w => w.send).length, 1);
});

test('a rejected stale save merges the latest typing and retries only a proven non-execution', async () => {
  const f = fixture(); await f.present();
  await f.card('change', { ...f.values(), body: 'Local typing' });
  f.externalEdit({ subject: 'Remote subject' });
  await f.flush();
  assert.equal(f.current().editor.body, 'Local typing');
  assert.equal(f.current().headers.subject, 'Remote subject');
  assert.equal(f.cards.at(-1).draft.state, 'draft');
  assert.equal(f.writes.length, 2);
});

test('mailbox changes during countdown get a fresh preview and full undo period', async () => {
  const f = fixture({ autoSend: false }); await f.present();
  const pending = f.tool('send'); await f.waitCountdown();
  f.externalEdit({ subject: 'Updated while waiting' });
  await f.advance(10000); await f.waitCountdown();
  assert.equal(f.writes.length, 1); // Rejected precondition; no mail sent.
  assert.equal(f.cards.findLast(c => c.draft).draft.fields.find(f => f.name === 'subject').value, 'Updated while waiting');
  await f.card('cancel');
  assert.equal((await pending).cancelled, true);
  await f.advance(10000);
  assert.equal(f.writes.length, 1);
});

test('model send after restart previews remote-only changes before starting its countdown', async () => {
  const f = fixture({ autoSend: false }); await f.present(); f.restart();
  f.externalEdit({ subject: 'Latest remote subject' });
  const pending = f.tool('send'); await f.waitCountdown();
  assert.equal(f.writes.length, 0);
  assert.equal(f.cards.findLast(c => c.draft).draft.fields.find(f => f.name === 'subject').value, 'Latest remote subject');
  await f.card('cancel'); assert.equal((await pending).cancelled, true);
});

test('identical concurrent edits converge without rewriting; overlapping replacements remain a conflict', async () => {
  for (const remote of ['Same change', 'Other change']) {
    const f = fixture(); await f.present();
    await f.card('change', { ...f.values(), body: 'Same change' });
    f.externalEdit({ body: remote }); await f.flush();
    assert.equal(f.writes.length, 1);
    assert.equal(f.cards.at(-1).draft.state, remote === 'Same change' ? 'draft' : 'error');
  }
});

test('HTML style and typing changes merge while preview-only attachment changes do not conflict', async () => {
  const f = fixture({ richText: true });
  const file = { key: 'image', filename: 'image.png', mimeType: 'image/png', bytes: 20, contentId: 'image@cindy.local', previewUrl: 'cindy-media://blobs/' + 'a'.repeat(64) + '.png' };
  f.externalEdit({ attachments: [file] }); await f.present();
  const values = f.values();
  f.restart();
  f.externalEdit({ bodyHtml: '<p style="color:blue">Original</p>', attachments: [{ ...file, contentId: '<image@cindy.local>', previewUrl: 'cindy-media://blobs/' + 'b'.repeat(64) + '.png' }] });
  await f.card('change', { ...values, body: 'Dear Original', bodyHtml: '<p style="color:red">Dear Original</p>' });
  await f.flush();
  assert.equal(f.current().editor.bodyHtml, '<p style="color:blue">Dear Original</p>');
  assert.equal(f.current().editor.body, 'Dear Original');
  assert.equal(f.current().attachments.length, 1);
  assert.equal(f.cards.at(-1).draft.state, 'draft');
});

// The whole-body editor emits a document; outgoing mail uses a fragment.
// Saving between keystrokes must not look like a concurrent body replacement.
test('typing across autosaves merges document HTML against its outgoing fragment', async () => {
  const f = fixture({ richText: true }); await f.present();
  const values = f.values();
  for (const text of ['Original.', 'Original..', 'Original...']) {
    await f.card('change', { ...values, body: text,
      bodyHtml: `<html><head></head><body><p style="color:red">${text}</p></body></html>` });
    await f.flush();
    assert.equal(f.current().editor.body, text);
    assert.equal(f.current().editor.bodyHtml, `<div><p style="color:red">${text}</p></div>`);
    assert.equal(f.cards.at(-1).draft.state, 'draft');
  }
  assert.equal(f.writes.length, 3);
});

test('restoring a formatting-only conflict preserves unsaved typing without sending', async () => {
  const f = fixture({ richText: true }); await f.present();
  const base = { ...f.values(), body: 'Original.',
    bodyHtml: '<html><head></head><body><p>Original.</p></body></html>' };
  const local = { ...base, body: 'Original...', bodyHtml: base.bodyHtml.replace('Original.', 'Original...') };
  const card = f.cards.at(-1).draft;
  card.baseValues = base;
  card.fields.forEach(field => { field.value = local[field.name]; });
  card.state = 'error'; card.status = 'Conflict';
  f.externalEdit({ body: base.body, bodyHtml: '<div><p>Original.</p></div>' });
  f.restart();
  await f.card('change', local); await f.flush();
  assert.equal(f.current().editor.bodyHtml, '<div><p>Original...</p></div>');
  assert.equal(f.cards.at(-1).draft.state, 'draft');
  assert.equal(f.writes.some(w => w.send), false);
});

test('normalizing HTML still refuses overlapping mailbox edits and preserves the local card', async () => {
  const f = fixture({ richText: true }); await f.present();
  const values = f.values();
  await f.card('change', { ...values, body: 'Local',
    bodyHtml: '<html><body><p style="color:red">Local</p></body></html>' });
  f.externalEdit({ body: 'Remote', bodyHtml: '<p style="color:red">Remote</p>' });
  await f.flush();
  assert.equal(f.current().editor.body, 'Remote');
  assert.equal(f.cards.at(-1).draft.state, 'error');
  assert.equal(f.cards.at(-1).draft.fields.find(f => f.name === 'body').value, 'Local');
  assert.equal(f.writes.length, 1); // Rejected precondition, no overwrite/retry.
});


test('unknown writes allow inspecting the mailbox without unlocking or repeating the write', async () => {
  const f = fixture({ write: async () => { throw new Error('lost response'); } });
  await f.present();
  assert.equal((await f.tool('send')).execution, 'unknown');
  const unknownCardCount = f.cards.length;
  await f.card('cancel', undefined, { formValues: undefined });
  await f.card('now', undefined, { formValues: undefined });
  assert.equal(f.cards.length, unknownCardCount);
  f.restart();
  assert.equal((await f.tool('get')).ok, true);
  assert.equal(f.cards.at(-1).draft.state, 'unconfirmed');
  assert.equal((await f.tool('send')).execution, 'unknown');
  assert.equal(f.writes.length, 1);
});

// Regression: both entry points must expose a real undo interval, not send first.
test("send waits ten seconds; cancel retains draft; send-now and concurrent requests send once", async () => {
  for (const entry of ["card", "model"]) {
    const f = fixture({ autoSend: false });
    await f.present();
    const pending = entry === "card" ? f.card("send") : f.tool("send");
    await f.waitCountdown();
    assert.equal(f.writes.length, 0);
    await f.advance(9999);
    assert.equal(f.writes.length, 0);
    await f.card("cancel", undefined, { formValues: undefined });
    await pending;
    await f.advance(1);
    assert.equal(f.writes.length, 0);
    assert.equal(f.cards.at(-1).draft.state, "draft");
    assert.equal(f.continuations.length, 0);

    const retry = entry === "card" ? f.card("send") : f.tool("send");
    await f.waitCountdown();
    const duplicate = f.tool("send");
    await f.card("now", undefined, { formValues: undefined });
    await Promise.all([retry, duplicate]);
    await f.advance(10000);
    assert.equal(f.writes.filter(w => w.send).length, 1);
    assert.equal(f.continuations.length, entry === "card" ? 1 : 0);
  }
});
test("expiry sends exactly once and restart never resumes a waiting send", async () => {
  const f = fixture({ autoSend: false });
  await f.present();
  const pending = f.tool("send");
  await f.waitCountdown();
  await f.advance(9999);
  assert.equal(f.writes.length, 0);
  await f.advance(1);
  assert.equal((await pending).data.sent, true);
  assert.equal(f.writes.length, 1);
  const sentCardCount = f.cards.length;
  await f.card('cancel', undefined, { formValues: undefined });
  await f.card('now', undefined, { formValues: undefined });
  assert.equal(f.cards.length, sentCardCount);
  assert.equal(f.writes.length, 1);

  const restarted = fixture({ autoSend: false });
  await restarted.present();
  void restarted.tool("send");
  await restarted.waitCountdown();
  restarted.restart();
  await restarted.advance(10000);
  assert.equal(restarted.writes.length, 0);
  const freshSend = restarted.tool('send');
  await restarted.waitCountdown();
  assert.equal(restarted.writes.length, 0);
  await restarted.card('cancel');
  assert.equal((await freshSend).execution, 'not_executed');
  assert.equal(restarted.writes.length, 0);
});
for (const action of ['cancel', 'now']) test(`stale countdown ${action} restores the draft after restart without sending`, async () => {
  const f = fixture({ autoSend: false });
  await f.present();
  void f.tool('send');
  await f.waitCountdown();
  assert.equal(f.cards.at(-1).statusOnly.state, 'sending');
  f.restart();
  await f.card(action, undefined, { formValues: undefined });
  assert.equal(f.reads.length, 1);
  assert.equal(f.cards.at(-1).draft.state, 'draft');
  assert.equal(f.cards.at(-1).draft.pendingSend, undefined);
  await f.advance(10000);
  assert.equal(f.writes.length, 0);
  const fresh = f.tool('send');
  await f.waitCountdown();
  await f.card('cancel', undefined, { formValues: undefined });
  assert.equal((await fresh).execution, 'not_executed');
  assert.equal(f.writes.length, 0);
});
test("a rejected countdown card or a draft without a presented card cannot send", async () => {
  const f = fixture({ acceptCard: false });
  assert.equal((await f.tool("send")).execution, "not_executed");
  await f.present();
  assert.equal((await f.tool("send")).execution, "not_executed");
  assert.equal(f.writes.length, 0);
});

test('card/model deletion discards unsaved edits once and stays terminal after restart', async () => {
  const f = fixture();
  await f.present();
  assert.equal(f.cards.at(-1).draft.deleteLabel, '删除草稿');
  await f.card('change', { ...f.values(), body: 'Discard this edit' });
  await Promise.all([f.card('delete'), f.tool('delete')]);
  await f.flush();
  assert.equal(f.writes.length, 0);
  assert.equal(f.deletes.length, 1);
  assert.equal(f.cards.at(-1).statusOnly.state, 'deleted');
  await f.card('change', { ...f.values(), body: 'Late change' });
  f.restart();
  assert.equal((await f.tool('delete')).data.alreadyDeleted, true);
  assert.equal((await f.tool('send')).execution, 'not_executed');
  assert.equal(f.deletes.length, 1);
  assert.equal(f.continuations.length, 0);
});

test('delete cancels the send countdown and no expiry can send the draft', async () => {
  const f = fixture({ autoSend: false });
  await f.present();
  const sending = f.tool('send');
  await f.waitCountdown();
  assert.equal((await f.tool('delete')).data.deleted, true);
  assert.equal((await sending).cancelled, true);
  await f.advance(10000);
  assert.equal(f.writes.length, 0);
  assert.equal(f.deletes.length, 1);
});

test('delete waits for an in-flight save and uses its replacement IMAP UID', async () => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture({ write: async () => { started(); await wait; } });
  await f.present();
  await f.card('change', { ...f.values(), body: 'Saving' });
  const saving = f.flush();
  await ready;
  const deleting = f.tool('delete');
  release();
  await saving;
  assert.equal((await deleting).ok, true);
  assert.equal(f.deletes[0].record.locator.uid, 43);
  assert.equal(f.cards.at(-1).statusOnly.state, 'deleted');
});

// Regression: an old card silently refused deletion on any provider revision
// change. Discard targets the logical draft, including newer content (unit tier).
test('old cards delete the latest draft after restart, without saving or sending edits', async () => {
  for (const fields of [{}, { bodyHtml: '<p>Updated</p>', attachments: [{ key: 'image', filename: 'card.png', bytes: 42 }] }]) {
    const f = fixture({ richText: true });
    await f.present();
    f.externalEdit(fields);
    f.relocate();
    f.restart();
    await f.card('delete');
    assert.equal(f.deletes.length, 1);
    assert.equal(f.deletes[0].record.fingerprint, f.current().fingerprint);
    assert.equal(f.cards.at(-1).statusOnly.state, 'deleted');
    assert.equal(f.writes.length, 0);
  }
});

test('delete reports progress before slow reads and failed preparation stays retryable', async () => {
  let fail = true;
  const f = fixture({ read: async () => {
    assert.equal(f.cards.at(-1).statusOnly.state, 'deleting');
    if (fail) throw new Error('Read failed');
  } });
  await f.present();
  await f.card('delete');
  assert.equal(f.deletes.length, 0);
  assert.equal(f.cards.at(-1).statusOnly.state, 'error');
  assert.equal(Object.values(f.kv().mailDraftCards)[0].state, 'draft');
  fail = false;
  await f.card('delete');
  assert.equal(f.deletes.length, 1);
  assert.equal(f.cards.at(-1).statusOnly.state, 'deleted');
});

test('readonly or mismatched drafts are not deleted; unknown deletion is never replayed', async () => {
  const readonly = fixture();
  await readonly.present();
  assert.equal((await readonly.tool('delete', { readOnly: true })).execution, 'not_executed');
  assert.equal(readonly.deletes.length, 0);
  const mismatch = fixture({ read: async () => ({ ok: true, data: { readBack: { status: 'read_back', draftId: 'another-draft' } } }) });
  await mismatch.present();
  await mismatch.card('delete');
  assert.equal(mismatch.deletes.length, 0);
  assert.equal(mismatch.cards.at(-1).statusOnly.state, 'error');
  for (const remove of [async () => { throw new Error('lost response'); }, async () => ({ ok: true, data: {} })]) {
    const f = fixture({ remove });
    await f.present();
    assert.equal((await f.tool('delete')).execution, 'unknown');
    assert.equal(f.cards.at(-1).statusOnly.state, 'unconfirmed');
    f.restart();
    assert.equal((await f.tool('delete')).execution, 'unknown');
    assert.equal((await f.tool('send')).execution, 'unknown');
    assert.equal(f.deletes.length, 1);
    assert.equal(f.writes.length, 0);
  }
  const legacy = fixture({ supportsDelete: false });
  await legacy.present();
  assert.equal(legacy.cards.at(-1).draft.deleteLabel, undefined);
  assert.equal(await legacy.tool('delete'), null);
});
