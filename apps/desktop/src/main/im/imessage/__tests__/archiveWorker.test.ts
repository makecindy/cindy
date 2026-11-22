import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Tier 1: two chats in a real bridge snapshot share a search term. The live REST
// scope tests do not cover this SQLite join or the archive's digest-based cache.
it('searches only the bound chat and returns its cached original from a read-only snapshot', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-im-archive-'));
  try {
    const bytes = Buffer.from('attachment fixture');
    const hash = createHash('sha256').update(bytes).digest('hex');
    await fs.mkdir(path.join(directory, 'attachments'));
    const file = path.join(directory, 'attachments', hash);
    await fs.writeFile(file, bytes);
    const db = new Database(path.join(directory, 'bridge.sqlite3'));
    try {
      db.exec(`CREATE TABLE bridge_meta(key,value); INSERT INTO bridge_meta VALUES ('application','bbcodex'),('schema','2');
        CREATE TABLE routes(id,chat_guid,kind,enabled,paused); INSERT INTO routes VALUES (1,'mine','chat',1,NULL),(2,'other','chat',1,NULL);
        CREATE TABLE messages(route_id,guid,record); CREATE TABLE message_versions(seq,route_id,guid);
        INSERT INTO message_versions VALUES (1,1,'a'),(2,2,'b'); CREATE TABLE attachments(guid,state,sha256);`);
      db.prepare('INSERT INTO attachments VALUES (?,?,?)').run('file','ready',hash);
      const put = db.prepare('INSERT INTO messages VALUES (?,?,?)');
      put.run(1,'a',JSON.stringify({text:'find mine',attachments:[{guid:'file'}]}));
      put.run(2,'b',JSON.stringify({text:'find private'}));
    } finally { db.close(); }
    const module = path.join(directory, 'worker.cjs');
    buildSync({ entryPoints: [fileURLToPath(new URL('../archiveWorker.ts', import.meta.url))], outfile: module,
      format: 'cjs', platform: 'node', logLevel: 'silent' });
    const worker = new Worker(module,{workerData:{directory,chat:'mine',query:'find',limit:5,
      modulePath:createRequire(import.meta.url).resolve('better-sqlite3')}});
    try {
      const page = await new Promise<{messages:Array<{text:string; attachments:Array<{local_path:string}>}>}>((resolve,reject) => {
        worker.once('message',resolve); worker.once('error',reject);
      });
      expect(page.messages.map(m => m.text)).toEqual(['find mine']);
      expect(await fs.readFile(page.messages[0]!.attachments[0]!.local_path)).toEqual(bytes);
    } finally { await worker.terminate(); }
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
