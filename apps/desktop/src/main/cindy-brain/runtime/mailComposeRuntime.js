/* Cindy-owned mail SDK. Served by the Host before provider entry points.
 * Providers supply only account/read/write adapters; no HTML or card handlers.
 * State is scoped to the provider sandbox and uses its existing routing KV. */
var cindyMail = (function () {
  "use strict";
  // Outgoing content policy belongs to Cindy, not individual provider adapters.
  // Parse in an inert document; never mount incoming mail in the plugin page.
  // Leave ordinary fragments byte-for-byte intact to avoid spurious sync edits.
  function formatMailFields(input, additions, format) {
    const fields = { ...input };
    if (typeof fields.bodyHtml !== 'string') return { fields };
    const items = JSON.parse(fields.attachmentItems || '[]');
    const files = [...items, ...(additions || [])];
    const cid = value => (value || '').replace(/^<|>$/g, '');
    const ids = files.map(f => cid(f.contentId)).filter(Boolean);
    let issue = new Set(ids).size !== ids.length ? 'duplicateImage' : undefined;
    const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
      'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'text/plain': 'txt' };
    let renamed = false;
    for (const file of items) {
      const extension = extensions[(file.mimeType || '').toLowerCase()];
      if (extension && !/\.[^./\\]+$/.test(file.filename || '')) {
        file.filename = (file.filename || 'attachment') + '.' + extension;
        renamed = true;
      }
    }
    if (renamed) fields.attachmentItems = JSON.stringify(items);
    for (const name of ['bodyHtml', 'quoteHtml']) {
      const source = fields[name] || '';
      if (!source) continue;
      const doc = new DOMParser().parseFromString(source, 'text/html');
      const fullDocument = /<!doctype\s|<\/?(?:html|head|body)(?:\s|>)/i.test(source);
      let changed = fullDocument;
      if (fullDocument) {
        // Browsers adopt a nested <body>'s attributes onto the document body.
        // Restore those attributes on the quoted content, not on the reply or
        // attribution. Keep tables, inline styles and Outlook comments intact.
        const container = name === 'quoteHtml' ? doc.body.querySelector('blockquote') || doc.body : doc.body;
        const wrapper = doc.createElement('div');
        for (const element of [doc.documentElement, doc.body])
          for (const attr of element.attributes) {
            if (attr.name === 'style') wrapper.style.cssText += ';' + attr.value;
            else wrapper.setAttribute(attr.name, attr.value);
          }
        // Legacy HTML body colours/backgrounds also need to survive extraction.
        for (const [attr, prop] of [['bgcolor', 'background-color'], ['text', 'color']])
          if (doc.body.hasAttribute(attr) && !wrapper.style.getPropertyValue(prop))
            wrapper.style.setProperty(prop, doc.body.getAttribute(attr));
        if (doc.body.hasAttribute('background') && !wrapper.style.backgroundImage)
          wrapper.style.backgroundImage = 'url(' + JSON.stringify(doc.body.getAttribute('background')) + ')';
        doc.querySelectorAll('meta, base, title').forEach(node => node.remove());
        while (container.firstChild) wrapper.appendChild(container.firstChild);
        for (const node of [...doc.head.childNodes].reverse())
          if (node.nodeType === 8 || node.nodeName === 'STYLE') wrapper.prepend(node);
        container.appendChild(wrapper);
      }
      // Preview URLs are Host-local. Reconnect to the same MIME image instead of
      // leaking a local address or sending a broken picture to the recipient.
      const checkImage = value => {
        value = value.trim();
        const match = files.find(f => f.previewUrl === value && cid(f.contentId));
        if (match) return 'cid:' + cid(match.contentId);
        if (/^cid:/i.test(value)) {
          let id = value.slice(4);
          try { id = decodeURIComponent(id); } catch (_) { /* Literal CID. */ }
          if (!ids.includes(cid(id))) issue ||= 'missingImage';
        } else if (/^(?:cindy-media|xdt-image|blob|file):/i.test(value)) issue ||= 'localImage';
        return value;
      };
      const checkCss = value => value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,
        (all, doubleQuoted, singleQuoted, bare) => {
          const url = doubleQuoted ?? singleQuoted ?? bare, next = checkImage(url);
          return next === url.trim() ? all : 'url("' + next + '")';
        });
      const checkSrcset = value => {
        // URLs end at ASCII whitespace, not commas (data URLs contain commas).
        // Keep descriptors and separators verbatim; inspect every candidate.
        let position = 0, copied = 0, output = '';
        while (position < value.length) {
          while (/[\t\n\f\r ,]/.test(value[position] || '') && position < value.length) position++;
          const start = position;
          while (position < value.length && !/[\t\n\f\r ]/.test(value[position])) position++;
          const token = value.slice(start, position), url = token.replace(/,+$/, '');
          if (!url) break;
          output += value.slice(copied, start) + checkImage(url);
          copied = start + url.length;
          if (token.endsWith(',')) continue;
          let depth = 0;
          while (position < value.length) {
            const char = value[position++];
            if (char === '(') depth++;
            else if (char === ')') depth = Math.max(0, depth - 1);
            else if (char === ',' && !depth) break;
          }
        }
        return output + value.slice(copied);
      };
      for (const element of doc.querySelectorAll('[src], [srcset], [background], [style], style')) {
        for (const attr of ['src', 'background']) if (element.hasAttribute(attr)) {
          const before = element.getAttribute(attr), after = checkImage(before);
          if (before !== after) { element.setAttribute(attr, after); changed = true; }
        }
        for (const attr of ['style', 'srcset']) if (element.hasAttribute(attr)) {
          const before = element.getAttribute(attr);
          const after = attr === 'style' ? checkCss(before) : checkSrcset(before);
          if (before !== after) { element.setAttribute(attr, after); changed = true; }
        }
        if (element.nodeName === 'STYLE') {
          const before = element.textContent, after = checkCss(before);
          if (before !== after) { element.textContent = after; changed = true; }
        }
      }
      if (changed) {
        // A fragment starting with <style> is parsed into head. Retain it when
        // serializing a repaired image URL instead of dropping authored CSS.
        for (const node of [...doc.head.childNodes].reverse())
          if (node.nodeType === 8 || node.nodeName === 'STYLE') doc.body.prepend(node);
        fields[name] = doc.body.innerHTML;
      }
      const plain = name === 'bodyHtml' ? 'body' : 'quote';
      if (format !== 'text' && !fields[plain]?.trim()) {
        // Only supply an absent fallback; never overwrite an authored text part.
        const textRoot = doc.body.cloneNode(true);
        textRoot.querySelectorAll('style, script, title').forEach(n => n.remove());
        textRoot.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
        textRoot.querySelectorAll('p, div, tr, li, blockquote, h1, h2, h3, h4').forEach(n => n.append('\n'));
        fields[plain] = (plain === 'quote' ? '\n\n' : '') + textRoot.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      }
    }
    if (Object.entries(fields).some(([name, value]) => typeof value !== 'string' || value.length > (name.endsWith('Html') ? 64000 : 16000))) issue ||= 'formatTooLarge';
    return { fields, issue };
  }
  function create(adapter) {
    if (
      !adapter ||
      typeof adapter.providerName !== "string" ||
      !adapter.providerName ||
      !["server", "local"].includes(adapter.draftStorage) ||
      ["selectAccount", "readDraft", "writeDraft"].some(
        (name) => typeof adapter[name] !== "function",
      )
    ) {
      throw new Error(
        "Mail compose requires an account/read/write adapter and explicit draft storage.",
      );
    }
    // Card records contain routing/receipts only. The adapter owns draft storage;
    // credentials and mail bodies never enter these records.
    async function mailCopy() {
      var provider = adapter.providerName;
      var locale = "en";
      try {
        var response = await fetch("/app-context");
        var data = await response.json();
        locale = data.context.locale;
      } catch (_) {
        /* English fallback. */
      }
      return locale === "zh-CN"
        ? {
            from: "发件人",
            to: "收件人",
            cc: "抄送",
            bcc: "密送",
            subject: "主题",
            body: "正文",
            quote: "引用内容",
            attachmentItems: "附件",
            send: "发送",
            delete: "删除草稿",
            deleting: "正在删除草稿…",
            deleted: "草稿已删除",
            deleteFailed: "未能删除草稿，请重试。",
            countdown: "{seconds} 秒后发送",
            cancel: "撤销",
            sendNow: "立即发送",
            cancelled: "已撤销发送，草稿已保留。",
            saved:
              adapter.draftStorage === "server"
                ? "已同步到 " + provider
                : "已保存到本地草稿",
            syncing:
              adapter.draftStorage === "server"
                ? "正在同步到 " + provider + "…"
                : "正在保存本地草稿…",
            waiting: "修改已保留，等待同步",
            sent: "邮件已发送",
            busy: "正在处理…",
            failed: "未能完成，请先核对邮箱中的草稿和已发送邮件。",
            unavailable:
              "此草稿无法在卡片中完整编辑，请通过邮箱插件重新读取并核对。",
            missing: "草稿卡片已失效，请让助手重新读取这份草稿。",
            recoveryConflict: "{fields}有两处修改无法自动合并。卡片上的编辑已保留，请核对后再发送。",
            continued: "已交给助手继续处理",
            continue: "继续处理",
            continueFailed: "邮件已发送，但未能继续任务。可点击“继续处理”。",
            review: "草稿已更新，请检查后再发送。",
            duplicateImage: "正文图片引用重复，请让助手重新关联图片后再发送。",
            missingImage: "正文中的图片缺少对应附件，请补上图片或删除该图片后再发送。",
            localImage: "正文图片仍使用本地地址，请将图片作为内嵌附件插入后再发送。",
            formatTooLarge: "整理后的邮件超过编辑大小上限，请让助手缩减内容后再发送。",
            formatNotRetained: "邮箱插件未保留整理后的邮件格式，草稿已保留，请让助手检查插件后再发送。",
          }
        : {
            from: "From",
            to: "To",
            cc: "Cc",
            bcc: "Bcc",
            subject: "Subject",
            body: "Message",
            quote: "Quoted message",
            attachmentItems: "Attachments",
            send: "Send",
            delete: "Delete draft",
            deleting: "Deleting draft…",
            deleted: "Draft deleted",
            deleteFailed: "Could not delete the draft. Please try again.",
            countdown: "Sending in {seconds}s",
            cancel: "Undo",
            sendNow: "Send now",
            cancelled: "Send cancelled. Draft retained.",
            saved:
              adapter.draftStorage === "server"
                ? "Synced to " + provider
                : "Saved to local draft",
            syncing:
              adapter.draftStorage === "server"
                ? "Syncing to " + provider + "…"
                : "Saving local draft…",
            waiting: "Changes retained, waiting to sync",
            sent: "Message sent",
            busy: "Working…",
            failed:
              "Unable to complete. Check the draft and Sent folder in your mailbox before taking further action.",
            unavailable:
              "This draft cannot be edited in full here. Read and review it through the mail plugin.",
            missing:
              "This draft card is no longer available. Ask the assistant to read the saved draft again.",
            recoveryConflict: "Conflicting edits in {fields}. Your card edits are retained; review them before sending.",
            continued: "Handed back to the assistant",
            continue: "Continue",
            continueFailed:
              "Message sent, but the task could not continue. Select Continue.",
            review: "Draft updated. Review it before sending.",
            duplicateImage: "Inline images have duplicate references. Ask the assistant to reconnect them before sending.",
            missingImage: "An inline image has no matching attachment. Add the image or remove it before sending.",
            localImage: "An image still uses a local address. Insert it as an inline attachment before sending.",
            formatTooLarge: "The formatted message exceeds the editor size limit. Ask the assistant to shorten it before sending.",
            formatNotRetained: "The mail plugin did not retain the formatted content. The draft is saved; ask the assistant to check the plugin before sending.",
          };
    }
    async function mailRecords(change) {
      return navigator.locks.request(
        adapter.storageLock || "mail-compose-records",
        async function () {
          var response = await fetch("/kv");
          if (!response.ok)
            throw new Error("草稿卡片状态无法读取，请检查邮箱。");
          var data = await response.json();
          var records = data.mailDraftCards || {};
          if (!change) return records;
          var result = change(records);
          data.mailDraftCards = records;
          var saved = await fetch("/kv", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          if (!saved.ok)
            throw new Error(
              "草稿卡片状态无法保存，邮件未再次发送，请先检查邮箱。",
            );
          return result;
        },
      );
    }
    async function mailStatus(callId, text, action, working, sourceCallId, state, pendingSend) {
      return cindy.send({ type: "mail-draft-update", callId,
        ...(sourceCallId ? { sourceCallId } : {}),
        statusOnly: { status: text, state: state || (working ? "sending" : "error"), pendingSend,
          ...(action ? { continueLabel: action } : {}) } });
    }
    const mailEdits = new Map();
    function draftValues(readBack) {
      const values = Object.fromEntries(['to', 'cc', 'bcc', 'subject'].map(name => [name, readBack.headers[name] || '']));
      Object.assign(values, { body: readBack.editor.body || '', quote: readBack.editor.quote || '' });
      if (adapter.richText) Object.assign(values, {
        bodyHtml: readBack.editor.bodyHtml || '<div>' + values.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</div>',
        quoteHtml: readBack.editor.quoteHtml || '',
        attachmentItems: JSON.stringify(readBack.attachments.map(a => ({ key: a.key, filename: a.filename, bytes: a.bytes, contentId: a.contentId || '', mimeType: a.mimeType, previewUrl: a.previewUrl }))),
      });
      return values;
    }
    function comparable(name, value) {
      if (name !== 'attachmentItems') return (value || '').replace(/\r\n/g, '\n');
      // Managed preview addresses are not mailbox content.
      return JSON.stringify(JSON.parse(value || '[]').map(a =>
        [a.key, (a.contentId || '').replace(/^<|>$/g, ''), a.filename, a.bytes]).sort());
    }
    function sameFields(a, b) {
      return Object.keys(b).every(name => comparable(name, a[name]) === comparable(name, b[name]));
    }
    // A conservative three-way text merge: identical edits converge; independent
    // replacement ranges combine. Overlapping replacements remain for review.
    function mergeText(base, local, remote) {
      function range(next) {
        let start = 0, end = base.length, last = next.length;
        while (start < end && start < last && base[start] === next[start]) start++;
        while (end > start && last > start && base[end - 1] === next[last - 1]) { end--; last--; }
        return { start, end, text: next.slice(start, last) };
      }
      const a = range(local), b = range(remote);
      if ((a.start === b.start && (a.start === a.end || b.start === b.end)) ||
          !(a.end <= b.start || b.end <= a.start)) return undefined;
      let result = base;
      for (const edit of [a, b].sort((x, y) => y.start - x.start))
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
      return result;
    }
    function mergeFields(base, local, remote) {
      // The browser edits a full document; saving extracts an outgoing fragment.
      // Compare all three revisions in that same representation, so our own
      // formatting is not mistaken for a concurrent replacement of the body.
      // Keep authored text unchanged and leave validation to the save boundary.
      if (adapter.richText) {
        if (base) base = formatMailFields(base, [], 'text').fields;
        local = formatMailFields(local, [], 'text').fields;
        remote = formatMailFields(remote, [], 'text').fields;
      }
      const fields = { ...remote }, conflicts = [];
      for (const name of Object.keys(remote)) {
        const l = local[name] ?? '', r = remote[name], b = base?.[name];
        if (comparable(name, l) === comparable(name, r)) continue;
        if (b !== undefined && comparable(name, l) === comparable(name, b)) continue;
        if (b !== undefined && comparable(name, r) === comparable(name, b)) { fields[name] = l; continue; }
        let merged;
        if (b !== undefined && ['body', 'quote', 'bodyHtml', 'quoteHtml'].includes(name))
          merged = mergeText(b.replace(/\r\n/g, '\n'), l.replace(/\r\n/g, '\n'), r.replace(/\r\n/g, '\n'));
        if (merged !== undefined && merged.length <= (name.endsWith('Html') ? 64000 : 16000)) fields[name] = merged;
        else { fields[name] = l; conflicts.push(name); }
      }
      return { fields, conflicts };
    }
    async function conflictError(conflicts) {
      if (!conflicts.length) return undefined;
      const copy = await mailCopy();
      const labels = [...new Set(conflicts.map(n => copy[n.replace(/Html$/, '')] || n))];
      return { ok: false, execution: 'not_executed', stale: true, conflicts,
        message: copy.recoveryConflict.replace('{fields}', labels.join(' / ')) };
    }
    // Rebuild volatile editor state from the provider's saved draft, using only
    // the persisted routing identity. Concurrent keystrokes share this read.
    async function restoreMailDraft(key, callId, sourceCallId) {
      return navigator.locks.request('mail-restore:' + key, async function () {
        if (mailEdits.has(key)) return true;
        const record = (await mailRecords())[key];
        if (!record || record.callId !== callId || record.state !== 'draft') return false;
        const saved = await cindy.send({ type: 'mail-draft-read', callId, ...(sourceCallId ? { sourceCallId } : {}) });
        const card = saved?.ok && saved.draft;
        if (!card || card.key !== key || card.accountId !== record.account || card.draftId !== record.draftId) return false;
        const account = await adapter.selectAccount(record.account);
        if (!account.ok) throw new Error('Mail account unavailable');
        const result = await adapter.readDraft({ record: { ...record }, sourceCallId });
        const readBack = result?.ok && result.data?.readBack;
        if (!readBack || readBack.status !== 'read_back' || readBack.draftId !== record.draftId || !readBack.editor) throw new Error('Mail draft unavailable');
        const remote = draftValues(readBack);
        const local = { ...remote, ...Object.fromEntries(card.fields.map(f => [f.name, f.value])) };
        // Legacy clean cards are their own last synchronized snapshot. A legacy
        // error without a base can still converge when both contents are equal.
        const base = card.baseValues || (card.state === 'draft' ? local :
          ['syncing', 'sending'].includes(card.state) && readBack.fingerprint === record.fingerprint ? remote : undefined);
        const merged = mergeFields(base, local, remote);
        const active = await mailRecords(records => {
          const current = records[key];
          if (!current || current.callId !== callId || current.state !== 'draft' || current.fingerprint !== record.fingerprint) return false;
          current.locator = readBack.locator;
          current.fingerprint = readBack.fingerprint;
          return true;
        });
        if (!active) return false;
        mailEdits.set(key, { fields: merged.fields, revision: sameFields(merged.fields, remote) ? 0 : 1,
          savedRevision: 0, callId, readBack, error: await conflictError(merged.conflicts),
          inputFields: local, conflictBase: merged.conflicts.length ? base : undefined });
        return true;
      });
    }
    async function showMailDraft(
      message,
      account,
      readBack,
      note,
      settledKey,
      edits,
      renderOnly,
      unconfirmed,
    ) {
      var copy = await mailCopy();
      if (!readBack || readBack.status !== "read_back") return false;
      var editor = readBack.editor;
      const originalValues = editor ? draftValues(readBack) : {};
      const formatted = editor && adapter.richText && !renderOnly ? formatMailFields(edits || originalValues, undefined, editor.format) : undefined;
      if (formatted) {
        edits = formatted.fields;
        if (formatted.issue) note = copy[formatted.issue];
        else if (!sameFields(edits, originalValues)) note ||= copy.waiting;
      }
      var fields = ["to", "cc", "bcc", "subject", "body", "quote"].map(
        function (name) {
          return {
            name: name,
            label: copy[name],
            value: originalValues[name] || '',
            ...(name === "body" || name === "quote" ? { multiline: true } : {}),
            ...(name === "to" || name === "cc" ? { row: "recipients" } : {}),
            ...(["to", "cc", "bcc"].includes(name)
              ? { kind: "recipients" }
              : {}),
            ...(name === "quote" || (name === "bcc" && !readBack.headers.bcc)
              ? { collapsed: true }
              : {}),
          };
        },
      );
      if (adapter.richText === true && editor) {
        if (editor.format !== 'text') fields.find(f => f.name === 'body').kind = 'hidden';
        fields.push({ name: 'bodyHtml', label: copy.body, kind: editor.format === 'text' ? 'hidden' : 'mail-html', value: originalValues.bodyHtml });
        fields.push({ name: 'quoteHtml', label: copy.quote, kind: 'hidden', value: originalValues.quoteHtml });
        fields.push({ name: 'attachmentItems', label: 'Attachments', kind: 'mail-attachments', value: originalValues.attachmentItems });
      }
      if (edits)
        fields.forEach(function (field) {
          field.value = edits[field.name];
        });
      // New messages have no quote section. Keep the complete value set internally
      // so hiding an empty quote never changes the draft sent to the worker.
      var values = Object.fromEntries(fields.map((f) => [f.name, f.value]));
      fields = fields.filter(function (field) {
        return field.name !== "quote" || field.value;
      });
      var key = renderOnly ? settledKey : crypto.randomUUID();
      if (!editor || (!editor.editable && !adapter.richText) || fields.some(f => typeof f.value !== 'string' || f.value.length > (f.name.endsWith('Html') ? 64000 : 16000))) return false;
      const activeEdit = mailEdits.get(key);
      var draft = { accountId: account.accountId, draftId: readBack.draftId, key,
        ...(activeEdit?.error?.stale && !activeEdit.conflictBase ? {} : { baseValues: activeEdit?.conflictBase || originalValues }),
        from: readBack.headers.from || account.accountEmail, fields,
        attachments: readBack.attachments.map(a => a.filename || a.mimeType || ""),
        ...(readBack.images ? { images: readBack.images } : {}),
        state: unconfirmed ? "unconfirmed" : note === copy.syncing ? "syncing" : note && note !== copy.waiting ? "error" : "draft",
        status: note || copy.saved, sendLabel: copy.send, fromLabel: copy.from,
        ...(typeof adapter.deleteDraft === "function" ? { deleteLabel: copy.delete } : {}) };
      if (!renderOnly)
        await mailRecords(function (records) {
          if (
            Object.keys(records).some(function (id) {
              return (
                id !== settledKey &&
                records[id].account === account.accountId &&
                records[id].draftId === readBack.draftId &&
                records[id].state !== "draft"
              );
            })
          ) {
            throw new Error("此草稿有待核对的操作，请先检查邮箱。");
          }
          // A newly read version supersedes older buttons for this saved draft.
          Object.keys(records).forEach(function (id) {
            if (
              records[id].account === account.accountId &&
              records[id].draftId === readBack.draftId
            ) {
              cancelMailSend(id);
              clearTimeout(mailEdits.get(id)?.timer);
              mailEdits.delete(id);
              delete records[id];
            }
          });
          records[key] = {
            account: account.accountId,
            draftId: readBack.draftId,
            fingerprint: readBack.fingerprint,
            locator: readBack.locator,
            callId: message.callId,
            state: "draft",
          };
        });
      if (!renderOnly)
        mailEdits.set(key, {
          fields: values,
          revision: sameFields(values, originalValues) ? 0 : 1,
          savedRevision: 0,
          callId: message.callId,
          readBack: readBack,
          ...(formatted?.issue ? { error: { ok: false, execution: 'not_executed', format: true, message: copy[formatted.issue] } } : {}),
        });
      const presented = await cindy.send({ type: "mail-draft-update", callId: message.callId,
        ...(message.sourceCallId ? { sourceCallId: message.sourceCallId } : {}), draft });
      const created = !renderOnly && mailEdits.get(key);
      if (presented?.ok && created && !created.error && created.revision !== created.savedRevision)
        scheduleMailSave(key, message.callId, copy.failed);
      return presented?.ok === true;
    }
    async function continueMailTask(message, record, copy, key) {
      var result;
      try {
        if (
          message.userActionToken &&
          cindy.agent &&
          typeof cindy.agent.run === "function"
        )
          result = await cindy.agent.run({
            mode: "continue",
            userActionToken: message.userActionToken,
            // The card already shows the outcome. Reuse the shared synthetic
            // input marker so desktop/mobile hide this internal continuation.
            promptTemplate: "[UI_ACTION_TRIGGER]{{user_message}}\n{{event_json}}",
            userMessage:
              "用户已在邮件草稿卡片点击发送，邮箱服务已接受发送请求。请根据回执继续原任务，不要重复发送，也不要把接受请求说成已送达。用户可能修改过草稿；需要描述实际邮件内容时，通过此邮箱插件读取已发送邮件，不沿用之前的草稿。",
            event: {
              provider: adapter.providerName,
              account: record.account,
              draftId: record.draftId,
              receipt: record.receipt,
            },
          });
      } catch (_) {
        /* Sending already succeeded; never turn this into a send retry. */
      }
      await mailStatus(
        message.callId,
        result && result.ok
          ? copy.sent + " · " + copy.continued
          : copy.continueFailed,
        result && result.ok
          ? ""
          : copy.continue,
        false, undefined, "sent",
      );
    }
    // Both UI sends and Agent draft sends enter this same per-draft operation.
    // Change events capture text immediately; only adapter writes are debounced.
    function scheduleMailSave(key, callId, failureMessage) {
      const edit = mailEdits.get(key);
      clearTimeout(edit.timer);
      const timer = setTimeout(() => runMailDraft(key, false, undefined, timer)
        .catch(() => mailStatus(callId, failureMessage)), 2000);
      edit.timer = timer;
    }
    async function runMailDraft(key, send, sourceCallId, autosaveTimer) {
      return navigator.locks.request("mail-compose:" + key, async function () {
        var record = (await mailRecords())[key];
        if (!record)
          return {
            ok: false,
            execution: "not_executed",
            message: "草稿卡片已失效，请重新读取。",
          };
        if (record.state === "deleted" || mailEdits.get(key)?.deleting)
          return { ok: false, execution: "not_executed", message: "草稿已删除或正在删除，不能保存或发送。" };
        if (record.state === "sent")
          return {
            ok: true,
            data: {
              ...record.receipt,
              receipt: record.receipt,
              sent: true,
              alreadySent: true,
              draftId: record.draftId,
            },
          };
        if (record.state !== "draft")
          return {
            ok: false,
            execution: "unknown",
            message: "之前操作的结果尚未确认，请先检查邮箱，未再次发送。",
          };
        var selected = await adapter.selectAccount(record.account);
        if (!selected.ok)
          return {
            ok: false,
            execution: "not_executed",
            message: selected.message,
          };
        var edit = mailEdits.get(key);
        if (!edit)
          return {
            ok: false,
            execution: "not_executed",
            message: "请重新读取草稿后再操作。",
          };
        // A timer may have waited behind another save while the user resumed
        // typing. Only the current debounce may start an automatic write.
        if (autosaveTimer !== undefined && edit.timer !== autosaveTimer)
          return { ok: true, deferred: true };
        clearTimeout(edit.timer);
        edit.timer = undefined;
        if (edit.error) return edit.error;
        var result;
        var rebased = false;
        do {
          if (adapter.richText) {
            const formatted = formatMailFields(edit.fields, edit.additions, edit.readBack.editor.format);
            if (!sameFields(formatted.fields, edit.fields)) { edit.fields = formatted.fields; edit.revision++; }
            if (formatted.issue) {
              edit.error = { ok: false, execution: 'not_executed', format: true, message: (await mailCopy())[formatted.issue] };
              await showMailDraft({ callId: record.callId, sourceCallId }, selected, edit.readBack, edit.error.message, key, edit.fields, true);
              return edit.error;
            }
          }
          var revision = edit.revision;
          var fields = { ...edit.fields };
          var additions = (edit.additions || []).slice();
          var sending = send && revision === edit.savedRevision;
          if (!send && revision === edit.savedRevision)
            return {
              ok: true,
              data: { draftId: record.draftId, readBack: edit.readBack },
            };
          if (sending) edit.sending = true;
          record.state = "pending";
          await mailRecords(function (records) {
            records[key] = record;
          });
          if (sending) {
            await showMailDraft({ callId: record.callId, sourceCallId }, selected, edit.readBack, undefined, key, fields, true);
            await mailStatus(
              record.callId,
              (await mailCopy()).busy,
              "",
              true,
              sourceCallId,
            );
          } else {
            await showMailDraft({ callId: record.callId, sourceCallId }, selected,
              edit.readBack, (await mailCopy()).syncing, key, edit.fields, true);
          }
          var response = undefined;
          try {
            response = await adapter.writeDraft({
              record: { ...record },
              account: selected,
              fields: fields,
              attachments: additions,
              readBack: edit.readBack,
              send: sending,
              sourceCallId: sourceCallId,
            });
          } catch (_) {
            /* Unknown write: keep pending and never replay it. */
          }
          result = response || {
            ok: false,
            execution: "unknown",
            message: "无法确认邮箱操作结果，请先检查邮箱，未再次发送。",
          };
          if (
            result.ok &&
            (sending
              ? result.data?.sent !== true ||
                !result.data.receipt ||
                typeof result.data.receipt !== "object" ||
                Array.isArray(result.data.receipt)
              : result.data?.readBack?.status !== "read_back" ||
                result.data.readBack.draftId !== record.draftId)
          ) {
            result = {
              ok: false,
              execution: "unknown",
              message: "邮箱返回的操作回执不完整，请核对邮箱，未再次发送。",
            };
          }
          if (!result.ok) {
            edit.sending = false;
            // Retry only a provider-confirmed non-execution. Unknown writes and
            // sends retain the existing terminal protection; never replay them.
            if (!rebased && result.execution === 'not_executed' && result.stale) {
              let latest = typeof result.stale === 'object' ? result.stale : undefined;
              if (!latest) {
                const fetched = await adapter.readDraft({ record: { ...record }, sourceCallId });
                latest = fetched?.ok && fetched.data?.readBack;
              }
              if (latest?.status === 'read_back' && latest.draftId === record.draftId && latest.editor) {
                const base = draftValues(edit.readBack), remote = draftValues(latest);
                const merged = mergeFields(base, edit.fields, remote);
                edit.inputFields = { ...edit.fields };
                edit.fields = merged.fields;
                edit.conflictBase = merged.conflicts.length ? base : undefined;
                edit.readBack = latest;
                edit.revision++;
                edit.savedRevision = sameFields(merged.fields, remote) ? edit.revision : edit.revision - 1;
                record.fingerprint = latest.fingerprint;
                record.locator = latest.locator;
                record.state = 'draft';
                await mailRecords(records => { records[key] = record; });
                edit.error = await conflictError(merged.conflicts);
                if (!edit.error) {
                  rebased = true;
                  // Content learned after the countdown must be shown for a new
                  // full grace period; a metadata-only change can proceed.
                  if (sending && !sameFields(fields, merged.fields)) {
                    await showMailDraft({ callId: record.callId, sourceCallId }, selected, latest, undefined, key, edit.fields, true);
                    return { ok: true, restartCountdown: true };
                  }
                  result = { ok: true, data: { draftId: record.draftId, readBack: latest } };
                  continue;
                }
                result = edit.error;
              }
            }
            edit.error = result;
            if (result.execution === "not_executed") {
              if (additions.length && !result.stale) {
                edit.additions = (edit.additions || []).filter(a => !additions.includes(a));
                for (const file of additions) if (file.contentId) {
                  edit.fields.bodyHtml = edit.fields.bodyHtml.replace(new RegExp('<p><img src="cid:' + file.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*></p>', 'g'), '');
                }
              }
              record.state = "draft";
              await mailRecords(function (records) {
                records[key] = record;
              });
            }
            await showMailDraft(
              { callId: record.callId, sourceCallId: sourceCallId },
              selected,
              edit.readBack,
              result.message,
              key,
              edit.fields,
              true,
            );
            return result;
          }
          if (result.data.sent) {
            record.state = "sent";
            record.receipt = result.data.receipt;
            try {
              await mailRecords(function (records) {
                records[key] = record;
              });
            } catch (_) {
              /* A known send is never retried. */
            }
            edit.sent = true;
            if (sourceCallId)
              await mailStatus(
                record.callId,
                (await mailCopy()).sent,
                "",
                false,
                sourceCallId, "sent",
              );
            return result;
          }
          edit.readBack = result.data.readBack;
          edit.conflictBase = undefined;
          if (adapter.richText) {
            edit.additions = (edit.additions || []).filter(a => !additions.includes(a));
            if (edit.fields.attachmentItems === fields.attachmentItems) edit.fields.attachmentItems = draftValues(edit.readBack).attachmentItems;
            if (edit.fields.bodyHtml === fields.bodyHtml) edit.fields.bodyHtml = edit.readBack.editor.bodyHtml || '';
            if (edit.fields.quote === fields.quote) edit.fields.quoteHtml = edit.readBack.editor.quoteHtml || '';
          }
          edit.savedRevision = revision;
          record.fingerprint = edit.readBack.fingerprint;
          record.locator = edit.readBack.locator;
          record.state = "draft";
          await mailRecords(function (records) {
            records[key] = record;
          });
          if (adapter.richText) {
            const actual = draftValues(edit.readBack), verified = formatMailFields(actual, undefined, edit.readBack.editor.format);
            if (verified.issue || !sameFields(verified.fields, actual)) {
              edit.error = { ok: false, execution: 'not_executed', format: true, message: (await mailCopy()).formatNotRetained };
              await showMailDraft({ callId: record.callId, sourceCallId }, selected, edit.readBack, edit.error.message, key, edit.fields, true);
              return edit.error;
            }
          }
          // Typing during an automatic save starts a fresh idle period. An
          // explicit read/send still flushes all edits through the existing loop.
          if (autosaveTimer !== undefined && edit.timer) break;
        } while (send || edit.savedRevision !== edit.revision);
        await showMailDraft(
          { callId: record.callId, sourceCallId: sourceCallId },
          selected,
          edit.readBack,
          edit.savedRevision !== edit.revision ? (await mailCopy()).waiting : undefined,
          key,
          edit.fields,
          true,
        );
        return result;
      });
    }
    // Deletion shares the save/send lock and uses the latest provider locator.
    // Discard pending edits instead of writing them back before deleting.
    async function deleteMailDraft(key, sourceCallId) {
      if (typeof adapter.deleteDraft !== "function")
        return { ok: false, execution: "not_executed", message: "此邮箱插件尚不支持删除草稿。" };
      const edit = mailEdits.get(key);
      if (edit?.sending)
        return { ok: false, execution: "not_executed", message: "邮件正在发送，不能删除草稿。" };
      cancelMailSend(key, { ok: false, execution: "not_executed", cancelled: true,
        message: "用户已删除草稿，发送已取消。不要自动重新创建或发送。" });
      if (edit) { edit.deleting = true; clearTimeout(edit.timer); edit.timer = undefined; }
      return navigator.locks.request("mail-compose:" + key, async function () {
        const record = (await mailRecords())[key], copy = await mailCopy();
        if (!record || record.state === "sent") {
          if (edit) edit.deleting = false;
          return { ok: false, execution: "not_executed", message: "草稿不存在或已发送，不能删除。" };
        }
        if (record.state === "deleted")
          return { ok: true, data: { deleted: true, alreadyDeleted: true, draftId: record.draftId } };
        if (record.state !== "draft")
          return { ok: false, execution: "unknown", message: "之前操作结果尚未确认，请先检查邮箱，未执行删除。" };
        let result, deleteStarted = false;
        try {
          // Show progress before account refresh/read-back (which may fetch large
          // attachments). A delete discards this logical draft, not one revision.
          await mailStatus(record.callId, copy.deleting, "", true, sourceCallId, "deleting");
          const account = await adapter.selectAccount(record.account);
          if (!account.ok) result = { ...account, execution: "not_executed" };
          else {
            const latest = await adapter.readDraft({ record: { ...record }, sourceCallId });
            if (!latest?.ok || latest.data?.readBack?.status !== "read_back" ||
                latest.data.readBack.draftId !== record.draftId)
              result = { ok: false, execution: "not_executed", message: latest?.message || copy.deleteFailed };
            else {
              record.locator = latest.data.readBack.locator;
              record.fingerprint = latest.data.readBack.fingerprint;
              record.state = "pending";
              await mailRecords(records => { records[key] = record; });
              deleteStarted = true;
              result = await adapter.deleteDraft({ record: { ...record }, account, sourceCallId });
              if (result?.ok && result.data?.deleted !== true) result = undefined;
            }
          }
        } catch (_) {
          // Failed preparation made no destructive request and can be retried.
          // Once handed to the provider, an uncertain delete is never replayed.
          if (!deleteStarted) result = { ok: false, execution: "not_executed", message: copy.deleteFailed };
        }
        result ||= { ok: false, execution: "unknown", message: "无法确认草稿是否已删除，请先检查邮箱，不要重复操作。" };
        record.state = result.ok ? "deleted" : result.execution === "not_executed" ? "draft" : "pending";
        if (edit) {
          edit.deleting = record.state !== "draft";
          if (!result.ok) edit.error = result;
          if (result.ok) edit.additions = [];
        }
        await mailRecords(records => { records[key] = record; });
        await mailStatus(record.callId, result.ok ? copy.deleted : result.message || copy.failed,
          "", false, sourceCallId, result.ok ? "deleted" : record.state === "draft" ? "error" : "unconfirmed");
        return result;
      });
    }
    // The provider is never called with send=true until this in-memory grace
    // period settles. Restarting the sandbox cannot resume an unattended send.
    function cancelMailSend(key, result) {
      const edit = mailEdits.get(key), pending = edit?.pendingSend;
      if (!pending || pending.phase === "sending") return false;
      pending.phase = "cancelled";
      clearTimeout(pending.timer);
      edit.pendingSend = undefined;
      pending.resolve(result || { ok: false, execution: "not_executed", cancelled: true,
        message: "用户已撤销发送，草稿已保留。不要自动重试发送，等待用户新的指示。" });
      return true;
    }
    function requestMailSend(key, sourceCallId) {
      const edit = mailEdits.get(key);
      if (!edit || edit.sent) return runMailDraft(key, true, sourceCallId);
      if (edit.pendingSend) return edit.pendingSend.promise.then(result =>
        result.ok && result.data?.sent ? { ...result, data: { ...result.data, alreadySent: true } } : result);
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const pending = { promise, resolve, phase: "preparing", sourceCallId };
      edit.pendingSend = pending;
      pending.finish = async function () {
        if (edit.pendingSend !== pending || pending.phase !== "waiting") return;
        pending.phase = "sending";
        edit.sending = true;
        clearTimeout(pending.timer);
        try {
          const result = await runMailDraft(key, true, sourceCallId);
          if (result.restartCountdown) {
            edit.sending = false;
            pending.phase = 'preparing';
            await prepare();
            return;
          }
          resolve(result);
        }
        catch (_) {
          resolve({ ok: false, execution: "unknown", message: "无法确认发送结果，请核对邮箱，不要重复发送。" });
        } finally {
          if (edit.pendingSend === pending && pending.phase === 'sending') edit.pendingSend = undefined;
        }
      };
      async function prepare() {
        try {
          const saved = await runMailDraft(key, false, sourceCallId);
          if (edit.pendingSend !== pending) return;
          if (!saved.ok || saved.data?.sent) { edit.pendingSend = undefined; resolve(saved); return; }
          // Restoration may adopt remote-only changes without any write. Show
          // that exact content before starting the grace period, including AI sends.
          const record = (await mailRecords())[key];
          const account = record && await adapter.selectAccount(record.account);
          if (!account?.ok || !await showMailDraft({ callId: edit.callId, sourceCallId }, account,
              edit.readBack, undefined, key, edit.fields, true)) throw new Error('Draft preview unavailable');
          const copy = await mailCopy();
          if (edit.pendingSend !== pending) return;
          const deadline = Date.now() + 10000;
          const shown = await mailStatus(edit.callId, copy.countdown.replace("{seconds}", "10"), "", true,
            sourceCallId, "sending", { deadline, label: copy.countdown, cancelLabel: copy.cancel, sendNowLabel: copy.sendNow });
          if (edit.pendingSend !== pending) return;
          if (!shown?.ok) throw new Error("Countdown card unavailable");
          pending.phase = "waiting";
          // Give the user the full grace period after the card was accepted.
          pending.timer = setTimeout(pending.finish, 10000);
        } catch (_) {
          if (edit.pendingSend === pending) {
            cancelMailSend(key, { ok: false, execution: "not_executed", message: "无法展示发送倒计时，邮件未发送。请重新读取草稿。" });
            await mailStatus(edit.callId, (await mailCopy()).failed, "", false, sourceCallId, "error");
          }
        }
      }
      void prepare();
      return promise;
    }
    async function handleMailCard(message) {
      var match = /^mail:(change|send|continue|cancel|now|attach|image|delete):([a-f0-9-]{36})$/.exec(
        message.actionId || "",
      );
      if (!match || (message.formChange === true) !== (match[1] === "change"))
        return;
      var key = match[2];
      var edit = mailEdits.get(key);
      if (!edit && ['change', 'send', 'attach', 'image', 'cancel', 'now'].includes(match[1])) {
        await restoreMailDraft(key, message.callId);
        edit = mailEdits.get(key);
      }
      if (edit?.deleting && match[1] !== "delete") return;
      if (
        ["change", "send", "attach", "image"].includes(match[1]) &&
        edit &&
        edit.callId === message.callId &&
        (!message.formValues ||
          ["to", "cc", "bcc", "subject", "body"].some(
            (name) => typeof message.formValues[name] !== "string",
          ) ||
          (edit.fields.quote && typeof message.formValues.quote !== "string"))
      ) {
        await mailStatus(message.callId, (await mailCopy()).unavailable);
        return;
      }
      // Capture before the first await so a following model tool sees the keystroke.
      if (
        ["change", "send", "attach", "image"].includes(match[1]) &&
        edit &&
        edit.callId === message.callId &&
        !edit.sent &&
        !edit.sending &&
        message.formValues &&
        Object.keys(message.formValues).some(
          (name) => message.formValues[name] !== edit.fields[name],
        )
      ) {
        cancelMailSend(key);
        const incoming = { ...edit.fields, ...message.formValues };
        const base = edit.error?.stale ? edit.conflictBase : edit.inputFields || edit.fields;
        const merged = mergeFields(base, incoming, edit.error?.stale ? draftValues(edit.readBack) : edit.fields);
        // The quote text field edits the outgoing quote too. Preserve authored
        // HTML unless that text changed, including an explicit deletion.
        if (adapter.richText && incoming.quote !== base?.quote && incoming.quoteHtml === base?.quoteHtml) {
          merged.fields.quoteHtml = merged.fields.quote
            ? '<div>' + merged.fields.quote.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r\n?|\n/g, '<br>') + '</div>'
            : '';
        }
        edit.conflictBase = merged.conflicts.length ? base : undefined;
        edit.fields = merged.fields;
        edit.inputFields = incoming;
        edit.revision++;
        if (!edit.error || edit.error.execution === 'not_executed') edit.error = await conflictError(merged.conflicts);
      }
      if (['attach', 'image'].includes(match[1]) && adapter.richText && edit && !edit.sent && !edit.sending && message.mailAttachment) {
        cancelMailSend(key);
        if (edit.error?.execution === 'not_executed' && !edit.error.stale) edit.error = undefined;
        edit.additions = [...(edit.additions || []), message.mailAttachment];
        if (message.mailAttachment.contentId) {
          const alt = message.mailAttachment.filename.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
          edit.fields.bodyHtml += '<p><img src="cid:' + message.mailAttachment.contentId + '" alt="' + alt + '" style="max-width:100%"></p>';
        }
        edit.revision++;
      }
      var record = (await mailRecords())[key];
      if (!record || record.callId !== message.callId) return;
      if (match[1] === "delete") { await deleteMailDraft(key); return; }
      if (record.state === "deleted") return;
      var copy = await mailCopy();
      if (match[1] === "continue" && record.state === "sent") {
        await continueMailTask(message, record, copy, key);
        return;
      }
      if (!edit) {
        await mailStatus(record.callId, copy.missing);
        return;
      }
        if (edit.error?.stale) {
        const selected = await adapter.selectAccount(record.account);
        if (selected.ok) await showMailDraft({ callId: record.callId }, selected, edit.readBack, edit.error.message, key, edit.fields, true);
        return;
      }
      if (
        match[1] === "change" &&
        (record.state === "sent" || edit.sent || edit.sending)
      )
        return;
      if (match[1] === "cancel" || match[1] === "now") {
        if (record.state !== "draft" || edit.sent || edit.sending) return;
        if (match[1] === "now" && edit.pendingSend) {
          await edit.pendingSend.finish();
        } else if (cancelMailSend(key) || !edit.pendingSend) {
          // After restart the persisted countdown has no live send behind it.
          // Restore a draft; a new send request must start a fresh grace period.
          const selected = await adapter.selectAccount(record.account);
          if (selected.ok) await showMailDraft({ callId: record.callId },
            selected, edit.readBack, undefined, key, edit.fields, true);
        }
        return;
      }
      clearTimeout(edit.timer);
      if (["change", "attach", "image"].includes(match[1])) {
        var selected = await adapter.selectAccount(record.account);
        if (selected.ok)
          await showMailDraft(
            { callId: record.callId },
            selected,
            edit.readBack,
            copy.waiting,
            key,
            edit.fields,
            true,
          );
        scheduleMailSave(key, record.callId, copy.failed);
        return;
      }
      var result = await requestMailSend(key);
      if (result.ok && result.data.sent && !result.data.alreadySent) {
        record = { ...record, state: "sent", receipt: result.data.receipt };
        await continueMailTask(message, record, copy, key);
      }
    }
    // Provider tool names and argument schemas stay in the adapter. null means the
    // caller can proceed with its ordinary operation after pending edits are saved.
    async function beforeTool(args) {
      var { operation, account, draftId, sourceCallId, readOnly } = args;
      if (!["get", "send", "update", "delete"].includes(operation))
        throw new Error("Unsupported draft operation");
      var records = await mailRecords();
      var key = Object.keys(records).find(
        (id) =>
          records[id].account === account && records[id].draftId === draftId,
      );
      if (!key) return operation === "send" ? { ok: false, execution: "not_executed",
        message: "请先读取草稿并展示卡片，再通过公共邮件流程发送。" } : null;
      // Uncertain writes must block repeat writes, not the read needed to inspect
      // the mailbox. Keep the receipt record intact and expose a read-only view.
      if (operation === "get" && records[key].state === "pending") {
        const latest = await adapter.readDraft({ record: { ...records[key] }, sourceCallId });
        if (latest?.ok && latest.data?.readBack?.status === "read_back" && sourceCallId && readOnly === false) {
          const selected = await adapter.selectAccount(account);
          if (selected.ok) latest.data.draftCard = await showMailDraft(
            { callId: sourceCallId }, selected, latest.data.readBack,
            (await mailCopy()).failed, key, undefined, true, true,
          );
        }
        return latest || { ok: false, execution: "not_executed", message: "无法读取当前草稿，请稍后再试。" };
      }
      if (readOnly !== false) {
        if (
          operation !== "get" ||
          mailEdits.get(key)?.revision !== mailEdits.get(key)?.savedRevision
        )
          return {
            ok: false,
            execution: "not_executed",
            message: "只读任务不能同步或发送草稿。",
          };
        return null;
      }
      if (operation === "delete" && typeof adapter.deleteDraft === "function")
        return deleteMailDraft(key, sourceCallId);
      if (records[key].state === "deleted")
        return { ok: false, execution: "not_executed", message: "草稿已删除，不能继续操作。" };
      if (!mailEdits.has(key)) {
        const record = records[key];
        if (record.state === "sent" || record.state === "pending")
          return runMailDraft(key, operation === "send", sourceCallId);
        if (!await restoreMailDraft(key, record.callId, sourceCallId)) {
          // A different task can read the provider draft without taking over an
          // old task's card. Sending still requires a current, owned card.
          if (operation === 'get') return null;
          return { ok: false, execution: 'not_executed', message: '暂时无法连接原草稿，请稍后再试。' };
        }
      }
      if (operation !== "send") cancelMailSend(key);
      // An explicit model update can resolve a conflict using the latest provider
      // version. Reads below expose both versions; automatic sends remain blocked.
      if (operation === 'update' && (mailEdits.get(key)?.error?.stale || mailEdits.get(key)?.error?.format)) return null;
      var result = operation === "send" ? await requestMailSend(key, sourceCallId) :
        operation === "get" &&
        mailEdits.get(key)?.error?.execution === "not_executed"
          ? { ok: true }
          : await runMailDraft(key, operation === "send", sourceCallId);
      if (operation === "get" && result.ok) {
        // Saving can change an IMAP locator; read the latest record, not the old UID.
        var record = (await mailRecords())[key];
        var latest = await adapter.readDraft({
          record: { ...record },
          sourceCallId,
        });
        if (!latest)
          return {
            ok: false,
            execution: "not_executed",
            message: "无法读取当前草稿，请稍后再试。",
          };
        // Reading a conflict must expose both versions to the assistant without
        // replacing the card and silently discarding the user's local edits.
        const edit = mailEdits.get(key);
        if (edit?.error?.stale && latest.ok) return { ...latest, data: { ...latest.data,
          cardEdits: { ...edit.fields }, conflicts: edit.error.conflicts || [] } };
        if (
          latest.ok &&
          latest.data.readBack?.status === "read_back" &&
          sourceCallId
        ) {
          // Inspecting a draft before editing it must not move an unchanged
          // snapshot to the latest turn. Verify its task ownership with the host;
          // another task still gets its own card. Adopt fresh provider locators
          // even when the visible document did not change.
          const saved = await cindy.send({ type: 'mail-draft-read', callId: record.callId, sourceCallId });
          const currentEdit = mailEdits.get(key);
          if (saved?.ok && saved.draft?.key === key && currentEdit &&
              currentEdit.revision === currentEdit.savedRevision &&
              currentEdit.readBack.editor?.format === latest.data.readBack.editor?.format &&
              sameFields(currentEdit.fields, draftValues(latest.data.readBack))) {
            currentEdit.readBack = latest.data.readBack;
            await mailRecords(records => {
              if (records[key]?.fingerprint !== record.fingerprint) return;
              records[key].fingerprint = latest.data.readBack.fingerprint;
              records[key].locator = latest.data.readBack.locator;
            });
            return latest;
          }
          var selected = await adapter.selectAccount(account);
          if (selected.ok)
            await showMailDraft(
              { callId: sourceCallId }, selected, latest.data.readBack,
            );
        }
        return latest;
      }
      return operation === "send" || !result.ok ? result : null;
    }
    cindy.onHostMessage(async function (message) {
      if (message?.type !== "event" || message.name !== "card-action" || !message.actionId?.startsWith("mail:")) return;
      try { await handleMailCard(message); }
      catch (_) { await mailStatus(message.callId, (await mailCopy()).failed); }
    });
    return {
      present: (message, account, snapshot) =>
        showMailDraft(message, account, snapshot),
      beforeTool,
      // IMAP save can replace a UID. Adapters performing update/delete after
      // beforeTool must resolve the current locator rather than use an older UID.
      resolveDraft: async function (account, draftId) {
        return (
          Object.values(await mailRecords()).find(
            (record) =>
              record.account === account && record.draftId === draftId,
          ) || null
        );
      },
      handleCard: async function (message) {
        try {
          await handleMailCard(message);
        } catch (_) {
          await mailStatus(message.callId, (await mailCopy()).failed);
        }
      },
    };
  }
  return { version: 1, sendGraceMs: 10000, register: create };
})();
