// Read the existing bbcodex archive off Electron's main thread.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type Database from 'better-sqlite3';

interface Attachment {
  guid: string;
  name?: string;
  transferName?: string;
  mimeType?: string;
}

const { directory, chat, before, query, limit, modulePath, nativeBinding } = workerData;
let db: Database.Database | undefined;
try {
  const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
  const Driver = require(modulePath) as typeof Database;
  const root = fs.realpathSync(directory);
  const database = path.join(root, 'bridge.sqlite3');
  if (fs.realpathSync(database) !== database) throw new Error();
  db = new Driver(database, { readonly: true, fileMustExist: true, timeout: 2000, nativeBinding });
  db.pragma('query_only = ON');
  db.pragma('trusted_schema = OFF');
  const meta = db.prepare('SELECT value FROM bridge_meta WHERE key=?').pluck();
  if (meta.get('application') !== 'bbcodex' || meta.get('schema') !== '2') throw new Error();
  const routes = db.prepare(`SELECT id FROM routes WHERE chat_guid=? AND kind='chat'
    AND enabled=1 AND paused IS NULL LIMIT 2`).pluck().all(chat);
  if (routes.length !== 1) throw new Error();
  const rows = db.prepare(`SELECT v.seq,m.record FROM message_versions v JOIN messages m
    ON m.route_id=v.route_id AND m.guid=v.guid WHERE v.route_id=? AND v.seq<?
    AND instr(COALESCE(json_extract(m.record,'$.text'),''),?)>0 ORDER BY v.seq DESC LIMIT ?`)
    .iterate(routes[0], before ?? Number.MAX_SAFE_INTEGER, query ?? '', limit) as Iterable<{ seq: number; record: string }>;
  const cachedAttachment = db.prepare('SELECT state,sha256 FROM attachments WHERE guid=?');
  const attachmentsRoot = path.join(root, 'attachments');
  const messages = [];
  let bytes = 0;
  let truncated = false;
  for (const row of rows) {
    const record = JSON.parse(row.record);
    const attachments = (record.attachments ?? []).map((item: Attachment) => {
      const cached = cachedAttachment.get(item.guid) as { state: string; sha256: string } | undefined;
      let localPath: string | null = null;
      if (cached?.state === 'ready' && /^[a-f0-9]{64}$/.test(cached.sha256)) {
        const file = path.join(attachmentsRoot, cached.sha256);
        if (fs.existsSync(file) && fs.realpathSync(file) === file && fs.statSync(file).isFile()) {
          localPath = file;
        }
      }
      return {
        name: item.transferName ?? item.name, mime: item.mimeType, local_path: localPath,
        state: cached?.state === 'ready' && !localPath ? 'unavailable' : cached?.state ?? 'pending',
      };
    });
    const message = {
      cursor: row.seq, speaker: record.handle?.address ?? null, date_created: record.dateCreated,
      is_from_me: !!record.isFromMe, text: record.text ?? '', attachments,
    };
    bytes += Buffer.byteLength(JSON.stringify(message));
    if (bytes > 1024 * 1024) {
      if (!messages.length) throw new Error();
      truncated = true;
      break;
    }
    messages.push(message);
  }
  parentPort?.postMessage({
    messages, next_before: truncated || messages.length === limit ? messages.at(-1)?.cursor : null,
  });
} catch {
  parentPort?.postMessage({ error: 'IMESSAGE_ARCHIVE_UNAVAILABLE' });
} finally {
  db?.close();
}
