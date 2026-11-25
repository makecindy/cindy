// Integration: capture a card, complete send preparation, and admit against SQLite at that
// instant. A stale card must never become a normal enqueue into a different turn/session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory';
import { admitAtDagTip, readExpectedDagTip } from '../dagTipAdmission';
import type { DbClient } from '../../localDb/client/DbClient';

let sqlite: ReturnType<typeof createBetterSqliteDatabase>;
const tip = { answerId:'a', userMessageId:'q' };
const db: Pick<DbClient,'queryOne'> = {async queryOne<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).get(...params) as T | undefined; }};
function row(session:string, role:string, id:string, at:number, meta:object|null=null) {
  sqlite.prepare('INSERT INTO messages VALUES (?,?,?,?,?,NULL)').run(session,role,id,at,meta ? JSON.stringify(meta) : null);
}
beforeEach(() => {
  sqlite = createBetterSqliteDatabase(':memory:');
  sqlite.exec(`CREATE TABLE sessions (id TEXT,status TEXT,hidden_at INTEGER,source TEXT,cleared_at INTEGER,remote_host_id TEXT);
    CREATE TABLE messages (session_id TEXT,role TEXT,client_id TEXT,created_at INTEGER,agent_meta TEXT,rewind_at INTEGER);
    INSERT INTO sessions VALUES ('root','active',NULL,'desktop',NULL,NULL), ('sibling','active',NULL,'desktop',NULL,NULL)`);
  row('root','user','q',1); row('root','assistant','a',1,{replyToClientId:'q'});
});
afterEach(() => sqlite.close());
const idle = () => true;
describe('anchored native DAG append', () => {
  it('accepts after trailing tool metadata or an explicitly linked recovery, independently of other branches', async () => {
    row('sibling','user','newer',3); row('root','tool_result','tools',2);
    expect(await admitAtDagTip(db,'root',tip,idle,()=> 'root')).toBe('root');
    row('root','user','hidden',3,{recoveryCheckpoint:{failedUserClientId:'q'}});
    row('root','assistant','a2',4,{replyToClientId:'hidden'});
    expect(await admitAtDagTip(db,'root',{...tip,answerId:'a2'},idle,()=> 'root')).toBe('root');
  });
  it.each(['new question','late old answer','missing anchor','context rebuild','rewind','clear','ssh','other session','provider switch'])('refuses %s before enqueue', async mode => {
    if(mode==='new question') row('root','user','later',1);
    if(mode==='late old answer') {row('root','user','later',2);row('root','assistant','late',3,{replyToClientId:'q'});}
    if(mode==='context rebuild') row('root','context_rebuild','boundary',2);
    if(mode==='provider switch') row('root','agent_switch','switched',2);
    if(mode==='rewind') sqlite.exec("UPDATE messages SET rewind_at=2 WHERE role='assistant'");
    if(mode==='clear') sqlite.exec("UPDATE sessions SET cleared_at=1");
    if(mode==='ssh') sqlite.exec("UPDATE sessions SET remote_host_id='remote'");
    const accept = vi.fn();
    const expected = mode==='late old answer' ? {answerId:'late',userMessageId:'later'} : mode==='missing anchor' ? {...tip,answerId:'missing'} : tip;
    await expect(admitAtDagTip(db,mode==='other session'?'sibling':'root',expected,idle,accept)).rejects.toThrow('DAG_TIP_REJECTED');
    expect(accept).not.toHaveBeenCalled();
  });
  it('does not accept if idle or owner validation changes during the database read', async () => {
    const accept = vi.fn(), current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(admitAtDagTip(db,'root',tip,current,accept)).rejects.toThrow('DAG_TIP_REJECTED');
    expect(accept).not.toHaveBeenCalled();
    expect(() => readExpectedDagTip({answerId:'a'})).toThrow('DAG_TIP_REJECTED');
  });
});
