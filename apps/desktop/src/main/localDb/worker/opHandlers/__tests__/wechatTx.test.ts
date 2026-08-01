import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { tx } from '../tx.js';

const HASH = 'a'.repeat(64);
const CONTEXT = {
  nonce: Buffer.alloc(12, 1).toString('base64'),
  ciphertext: Buffer.from('encrypted-context').toString('base64'),
  tag: Buffer.alloc(16, 2).toString('base64'),
};

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('WeChat reliable worker transactions', () => {
  it('uses binding epoch and cursor CAS to reject stale callbacks', () => {
    const db = createDb();

    expect(activate(db, 'epoch-1', null)).toEqual({
      activated: true,
      previousActiveEpoch: null,
      activeBindingEpoch: 'epoch-1',
    });
    expect(activate(db, 'epoch-2', null)).toEqual({
      activated: false,
      previousActiveEpoch: 'epoch-1',
      activeBindingEpoch: 'epoch-1',
    });
    expect(activate(db, 'epoch-2', 'epoch-1')).toEqual({
      activated: true,
      previousActiveEpoch: 'epoch-1',
      activeBindingEpoch: 'epoch-2',
    });
    expect(
      runTx(db, 'wechatCloseBindingEpoch', {
        bindingEpoch: 'epoch-1',
        now: 101,
      }),
    ).toEqual({ closed: true });

    expect(
      commitBatch(db, {
        bindingEpoch: 'epoch-1',
        expectedCursor: '',
        nextCursor: 'stale',
        messages: [message('stale-task', 'stale-platform', 'session-1')],
      }),
    ).toEqual({
      committed: false,
      reason: 'stale-epoch',
      activeBindingEpoch: 'epoch-2',
      currentCursor: '',
    });
    expect(count(db, 'wechat_inbox')).toBe(0);
  });

  it('commits inbox, media ledger, overload reply and cursor atomically', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);

    const result = commitBatch(db, {
      bindingEpoch: 'epoch-1',
      expectedCursor: '',
      nextCursor: 'cursor-1',
      maxQueuedTasks: 1,
      messages: [
        message('task-1', 'platform-1', 'session-1'),
        {
          ...message('task-2', 'platform-2', 'session-2'),
          overloadReply: {
            outboxId: 'outbox-overload-2',
            clientId: 'overload-2',
            text: '系统繁忙，请稍后再试。',
          },
        },
      ],
      mediaBlobs: [
        {
          hash: HASH,
          ext: '.png',
          mimeType: 'image/png',
          bytes: 4,
          isCache: true,
          createdAt: 100,
          lastAccessAt: 100,
        },
      ],
      mediaRefs: [
        {
          id: 'media-ref-1',
          hash: HASH,
          taskId: 'task-1',
          label: 'image',
          createdAt: 100,
        },
      ],
    });

    expect(result).toEqual({
      committed: true,
      insertedTaskIds: ['task-1', 'task-2'],
      duplicateTaskIds: [],
      rejectedTaskIds: ['task-2'],
    });
    expect(
      db
        .prepare('SELECT id, status FROM wechat_inbox WHERE binding_epoch = ? ORDER BY id')
        .all('epoch-1'),
    ).toEqual([
      { id: 'task-1', status: 'pending' },
      { id: 'task-2', status: 'rejected_overload' },
    ]);
    expect(
      db
        .prepare('SELECT sync_cursor AS cursor FROM wechat_sync_state WHERE binding_epoch = ?')
        .get('epoch-1'),
    ).toEqual({ cursor: 'cursor-1' });
    expect(count(db, 'media_blobs')).toBe(1);
    expect(count(db, 'media_refs')).toBe(1);
    expect(
      db.prepare('SELECT task_id AS taskId, kind, status FROM wechat_outbox ORDER BY id').all(),
    ).toEqual([{ taskId: 'task-2', kind: 'overload', status: 'pending' }]);

    expect(
      commitBatch(db, {
        bindingEpoch: 'epoch-1',
        expectedCursor: 'cursor-1',
        nextCursor: 'cursor-2',
        messages: [message('different-local-id', 'platform-1', 'session-1')],
      }),
    ).toEqual({
      committed: true,
      insertedTaskIds: [],
      duplicateTaskIds: ['task-1'],
      rejectedTaskIds: [],
    });
    expect(count(db, 'wechat_inbox')).toBe(2);
  });

  it('keeps stop commands pending when the normal inbox queue is full', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);

    expect(
      commitBatch(db, {
        maxQueuedTasks: 1,
        nextCursor: 'cursor-1',
        messages: [message('seed-task', 'platform-seed', 'session-1')],
      }),
    ).toMatchObject({ committed: true });

    const result = commitBatch(db, {
      expectedCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      maxQueuedTasks: 1,
      messages: [
        {
          ...message('stop-task', 'platform-stop', 'session-1'),
          payloadJson: JSON.stringify({ text: '/stop' }),
        },
        {
          ...message('stop-all-task', 'platform-stop-all', 'session-2'),
          payloadJson: JSON.stringify({ text: '/stop all' }),
        },
        {
          ...message('normal-task', 'platform-normal', 'session-2'),
          overloadReply: {
            outboxId: 'outbox-overload-normal',
            clientId: 'overload-normal',
            text: 'overloaded',
          },
        },
      ],
    });

    expect(result).toEqual({
      committed: true,
      insertedTaskIds: ['stop-task', 'stop-all-task', 'normal-task'],
      duplicateTaskIds: [],
      rejectedTaskIds: ['normal-task'],
    });
    expect(db.prepare('SELECT id, status FROM wechat_inbox ORDER BY id').all()).toEqual([
      { id: 'normal-task', status: 'rejected_overload' },
      { id: 'seed-task', status: 'pending' },
      { id: 'stop-all-task', status: 'pending' },
      { id: 'stop-task', status: 'pending' },
    ]);
  });

  it('rolls back the whole poll batch when media accounting is invalid', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);

    expect(() =>
      commitBatch(db, {
        bindingEpoch: 'epoch-1',
        expectedCursor: '',
        nextCursor: 'must-not-commit',
        messages: [message('task-1', 'platform-1', 'session-1')],
        mediaRefs: [
          {
            id: 'missing-ref',
            hash: HASH,
            taskId: 'task-1',
            label: null,
            createdAt: 100,
          },
        ],
      }),
    ).toThrowError(/unknown hash/);
    expect(count(db, 'wechat_inbox')).toBe(0);
    expect(db.prepare('SELECT sync_cursor FROM wechat_sync_state').pluck().get()).toBe('');
  });

  it('promotes accepted task attachments to the session before terminal cleanup', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);
    commitBatch(db, {
      bindingEpoch: 'epoch-1',
      messages: [message('task-1', 'platform-1', 'session-1')],
      mediaBlobs: [
        {
          hash: HASH,
          ext: '.png',
          mimeType: 'image/png',
          bytes: 4,
          isCache: false,
          createdAt: 100,
          lastAccessAt: 100,
        },
      ],
      mediaRefs: [
        {
          id: 'media-ref-1',
          hash: HASH,
          taskId: 'task-1',
          label: 'wechat-image.png',
          createdAt: 100,
        },
      ],
      fileAttachments: [
        {
          id: 'file-1',
          taskId: 'task-1',
          sessionId: 'session-1',
          absPath: 'C:\\safe\\report.pdf',
          originalName: 'report.pdf',
          mimeType: 'application/pdf',
          bytes: 4,
          createdAt: 100,
        },
      ],
    });
    lease(db, 'epoch-1', 200);
    expect(
      runTx(db, 'wechatMarkAccepted', {
        bindingEpoch: 'epoch-1',
        taskId: 'task-1',
      }),
    ).toBe(true);

    expect(
      runTx(db, 'wechatPromoteTaskAttachments', {
        bindingEpoch: 'epoch-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        now: 201,
      }),
    ).toEqual({
      eligible: true,
      promotedMediaRefs: 1,
      promotedFiles: 1,
    });
    expect(db.prepare('SELECT ref_kind AS refKind, ref_id AS refId FROM media_refs').all()).toEqual(
      [{ refKind: 'session-attachment', refId: 'session-1' }],
    );
    expect(
      db.prepare('SELECT status, promoted_at AS promotedAt FROM wechat_file_attachments').get(),
    ).toEqual({ status: 'promoted', promotedAt: 201 });
  });

  it('refreshes pending replies with a newer peer context token and wakes delivery', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);
    commitBatch(db, {
      messages: [message('task-1', 'platform-1', 'session-1')],
    });
    lease(db, 'epoch-1', 200);
    runTx(db, 'wechatMarkAccepted', {
      bindingEpoch: 'epoch-1',
      taskId: 'task-1',
    });
    runTx(db, 'wechatCommitTerminal', {
      bindingEpoch: 'epoch-1',
      taskId: 'task-1',
      now: 201,
      outbox: [outbox('outbox-1', 'client-1', 0, 'reply')],
    });
    db.prepare('UPDATE wechat_outbox SET next_retry_at = 9999').run();
    const replacement = {
      nonce: Buffer.alloc(12, 8).toString('base64'),
      ciphertext: Buffer.from('replacement-context').toString('base64'),
      tag: Buffer.alloc(16, 9).toString('base64'),
    };

    expect(
      runTx(db, 'wechatRefreshOutboxContexts', {
        bindingEpoch: 'epoch-1',
        peerId: 'peer-session-1',
        now: 202,
        contexts: [{ taskId: 'task-1', context: replacement }],
      }),
    ).toEqual({ refreshedTasks: 1, outboxWoken: 1 });
    expect(
      db
        .prepare(
          `SELECT context_nonce AS nonce, context_ciphertext AS ciphertext,
                  context_tag AS tag
           FROM wechat_inbox WHERE id = 'task-1'`,
        )
        .get(),
    ).toEqual(replacement);
    expect(db.prepare('SELECT next_retry_at FROM wechat_outbox').pluck().get()).toBe(202);
  });

  it('repairs accepted attachment ownership conservatively after a process restart', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);
    commitBatch(db, {
      messages: [message('task-1', 'platform-1', 'session-1')],
      mediaBlobs: [
        {
          hash: HASH,
          ext: '.png',
          mimeType: 'image/png',
          bytes: 4,
          isCache: false,
          createdAt: 100,
          lastAccessAt: 100,
        },
      ],
      mediaRefs: [
        {
          id: 'media-ref-1',
          hash: HASH,
          taskId: 'task-1',
          label: 'image',
          createdAt: 100,
        },
      ],
    });
    lease(db, 'epoch-1', 200);
    runTx(db, 'wechatMarkAccepted', {
      bindingEpoch: 'epoch-1',
      taskId: 'task-1',
    });

    runTx(db, 'wechatStopAll', {
      bindingEpoch: 'epoch-1',
      now: 201,
      errorCode: 'PROCESS_RESTARTED',
    });
    expect(readTaskStatus(db, 'task-1')).toBe('interrupted');
    expect(db.prepare('SELECT ref_kind AS refKind, ref_id AS refId FROM media_refs').all()).toEqual(
      [{ refKind: 'session-attachment', refId: 'session-1' }],
    );
  });

  it('replays only pre-accepted work and interrupts accepted work after recovery', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);
    commitBatch(db, {
      bindingEpoch: 'epoch-1',
      expectedCursor: '',
      nextCursor: 'cursor-1',
      messages: [message('task-1', 'platform-1', 'session-1')],
    });

    const firstLease = lease(db, 'epoch-1', 200);
    expect(firstLease).toMatchObject({ id: 'task-1', attempts: 1 });
    expect(
      runTx(db, 'wechatStopAll', {
        bindingEpoch: 'epoch-1',
        now: 201,
        errorCode: 'PROCESS_RESTARTED',
      }),
    ).toMatchObject({ requeued: 1, interrupted: 0 });

    const secondLease = lease(db, 'epoch-1', 202);
    expect(secondLease).toMatchObject({ id: 'task-1', attempts: 2 });
    expect(
      runTx(db, 'wechatMarkAccepted', {
        bindingEpoch: 'epoch-1',
        taskId: 'task-1',
      }),
    ).toBe(true);
    expect(
      runTx(db, 'wechatStopAll', {
        bindingEpoch: 'epoch-1',
        now: 203,
        errorCode: 'PROCESS_RESTARTED',
      }),
    ).toMatchObject({ requeued: 0, interrupted: 1 });
    expect(lease(db, 'epoch-1', 204)).toBeNull();
    expect(readTaskStatus(db, 'task-1')).toBe('interrupted');
    expect(
      runTx(db, 'wechatCommitInterrupted', {
        bindingEpoch: 'epoch-1',
        taskId: 'task-1',
        now: 205,
        errorCode: 'PROCESS_RESTARTED',
        context: {
          nonce: Buffer.alloc(12, 3).toString('base64'),
          ciphertext: Buffer.from('fresh-context').toString('base64'),
          tag: Buffer.alloc(16, 4).toString('base64'),
        },
        outbox: [
          {
            ...outbox('interrupted-outbox', 'interrupted-client', 0, '任务已中断。'),
            kind: 'interrupted',
          },
        ],
      }),
    ).toBe(true);
    expect(readTaskStatus(db, 'task-1')).toBe('delivery_pending');
  });

  it('releases a busy pre-dispatch lease and persists Desktop-waiting state', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);
    commitBatch(db, {
      bindingEpoch: 'epoch-1',
      expectedCursor: '',
      nextCursor: 'cursor-1',
      messages: [message('task-1', 'platform-1', 'session-1')],
    });

    lease(db, 'epoch-1', 200);
    expect(
      runTx(db, 'wechatReleaseDispatch', {
        bindingEpoch: 'epoch-1',
        taskId: 'task-1',
      }),
    ).toBe(true);
    expect(readTaskStatus(db, 'task-1')).toBe('pending');

    lease(db, 'epoch-1', 201);
    expect(
      runTx(db, 'wechatMarkAccepted', {
        bindingEpoch: 'epoch-1',
        taskId: 'task-1',
      }),
    ).toBe(true);
    expect(
      runTx(db, 'wechatSetWaitingDesktop', {
        bindingEpoch: 'epoch-1',
        taskId: 'task-1',
        waiting: true,
      }),
    ).toBe(true);
    expect(readTaskStatus(db, 'task-1')).toBe('waiting_desktop');
    expect(
      runTx(db, 'wechatSetWaitingDesktop', {
        bindingEpoch: 'epoch-1',
        taskId: 'task-1',
        waiting: false,
      }),
    ).toBe(true);
    expect(readTaskStatus(db, 'task-1')).toBe('accepted_running');
  });

  it('commits a pre-dispatch rejection without crossing the accepted barrier', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);
    commitBatch(db, {
      bindingEpoch: 'epoch-1',
      expectedCursor: '',
      nextCursor: 'cursor-1',
      messages: [message('task-1', 'platform-1', 'session-1')],
    });
    lease(db, 'epoch-1', 200);

    expect(
      runTx(db, 'wechatCommitPreDispatchFailure', {
        bindingEpoch: 'epoch-1',
        taskId: 'task-1',
        now: 201,
        errorCode: 'UNSUPPORTED_PERMISSION_MODE',
        outbox: [
          {
            ...outbox('outbox-error', 'client-error', 0, '请修改权限模式。'),
            kind: 'error',
          },
        ],
      }),
    ).toBe(true);
    expect(readTaskStatus(db, 'task-1')).toBe('delivery_pending');
    expect(
      db.prepare('SELECT kind, text FROM wechat_outbox WHERE task_id = ?').get('task-1'),
    ).toEqual({ kind: 'error', text: '请修改权限模式。' });
  });

  it('lets a stop command interrupt its peer without consuming the command task', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);
    commitBatch(db, {
      bindingEpoch: 'epoch-1',
      expectedCursor: '',
      nextCursor: 'cursor-1',
      messages: [message('active-task', 'platform-1', 'session-1')],
    });
    expect(lease(db, 'epoch-1', 200)).toMatchObject({ id: 'active-task' });
    runTx(db, 'wechatMarkAccepted', {
      bindingEpoch: 'epoch-1',
      taskId: 'active-task',
    });
    commitBatch(db, {
      bindingEpoch: 'epoch-1',
      expectedCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      messages: [
        {
          ...message('stop-command', 'platform-2', 'session-1'),
          payloadJson: JSON.stringify({ text: '/stop' }),
        },
        message('other-peer-task', 'platform-3', 'session-2'),
      ],
    });

    expect(
      runTx(db, 'wechatCancelForCommand', {
        bindingEpoch: 'epoch-1',
        commandTaskId: 'stop-command',
        peerId: 'peer-session-1',
        now: 201,
      }),
    ).toEqual({ cancelled: 0, interrupted: 1 });
    expect(readTaskStatus(db, 'active-task')).toBe('interrupted');
    expect(readTaskStatus(db, 'stop-command')).toBe('pending');
    expect(readTaskStatus(db, 'other-peer-task')).toBe('pending');
    expect(lease(db, 'epoch-1', 202)).toMatchObject({ id: 'stop-command' });
  });

  it('commits every final chunk before delivery_pending and completes after all deliveries', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);
    commitBatch(db, {
      bindingEpoch: 'epoch-1',
      expectedCursor: '',
      nextCursor: 'cursor-1',
      messages: [message('task-1', 'platform-1', 'session-1')],
      mediaBlobs: [
        {
          hash: HASH,
          ext: '.png',
          mimeType: 'image/png',
          bytes: 4,
          isCache: true,
          createdAt: 100,
          lastAccessAt: 100,
        },
      ],
      mediaRefs: [
        {
          id: 'media-ref-1',
          hash: HASH,
          taskId: 'task-1',
          label: null,
          createdAt: 100,
        },
      ],
    });
    lease(db, 'epoch-1', 200);
    runTx(db, 'wechatMarkAccepted', {
      bindingEpoch: 'epoch-1',
      taskId: 'task-1',
    });

    expect(
      runTx(db, 'wechatCommitTerminal', {
        bindingEpoch: 'epoch-1',
        taskId: 'task-1',
        now: 300,
        outbox: [
          outbox('outbox-1', 'client-1', 0, 'part 1'),
          outbox('outbox-2', 'client-2', 1, 'part 2'),
        ],
      }),
    ).toEqual({ committed: true, alreadyCommitted: false });
    expect(readTaskStatus(db, 'task-1')).toBe('delivery_pending');
    expect(count(db, 'wechat_outbox')).toBe(2);

    expect(
      runTx(db, 'wechatMarkOutboxDelivered', {
        bindingEpoch: 'epoch-1',
        outboxId: 'outbox-1',
        deliveredAt: 301,
      }),
    ).toEqual({ changed: true, taskId: 'task-1', taskCompleted: false });
    expect(readTaskStatus(db, 'task-1')).toBe('delivery_pending');
    expect(count(db, 'media_refs')).toBe(1);

    expect(
      runTx(db, 'wechatMarkOutboxDelivered', {
        bindingEpoch: 'epoch-1',
        outboxId: 'outbox-2',
        deliveredAt: 302,
      }),
    ).toEqual({ changed: true, taskId: 'task-1', taskCompleted: true });
    expect(readTaskStatus(db, 'task-1')).toBe('completed');
    expect(count(db, 'media_refs')).toBe(0);
  });

  it('rolls back terminal outbox on a chunk conflict and repairs impossible delivery state', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);
    commitBatch(db, {
      bindingEpoch: 'epoch-1',
      expectedCursor: '',
      nextCursor: 'cursor-1',
      messages: [message('task-1', 'platform-1', 'session-1')],
    });
    lease(db, 'epoch-1', 200);
    runTx(db, 'wechatMarkAccepted', {
      bindingEpoch: 'epoch-1',
      taskId: 'task-1',
    });
    db.prepare(
      `INSERT INTO wechat_outbox
       (id, binding_epoch, task_id, client_id, kind, chunk_index, text,
        media_json, status, attempts, next_retry_at, created_at)
       VALUES ('occupied', 'epoch-1', 'task-1', 'duplicate-client', 'final', 9,
               'occupied', '[]', 'delivered', 0, 0, 0)`,
    ).run();

    expect(() =>
      runTx(db, 'wechatCommitTerminal', {
        bindingEpoch: 'epoch-1',
        taskId: 'task-1',
        now: 300,
        outbox: [
          outbox('new-1', 'new-client', 0, 'part 1'),
          outbox('new-2', 'duplicate-client', 1, 'part 2'),
        ],
      }),
    ).toThrow();
    expect(readTaskStatus(db, 'task-1')).toBe('accepted_running');
    expect(
      db.prepare("SELECT COUNT(*) FROM wechat_outbox WHERE id LIKE 'new-%'").pluck().get(),
    ).toBe(0);

    db.prepare("UPDATE wechat_inbox SET status = 'delivery_pending' WHERE id = 'task-1'").run();
    db.prepare("DELETE FROM wechat_outbox WHERE task_id = 'task-1'").run();
    expect(
      runTx(db, 'wechatStopAll', {
        bindingEpoch: 'epoch-1',
        now: 400,
        errorCode: 'PROCESS_RESTARTED',
      }),
    ).toMatchObject({ repaired: 1 });
    expect(readTaskStatus(db, 'task-1')).toBe('interrupted');
  });

  it('retries transient outbox failures and terminates the task on permanent failure', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);
    commitBatch(db, {
      bindingEpoch: 'epoch-1',
      expectedCursor: '',
      nextCursor: 'cursor-1',
      messages: [message('task-1', 'platform-1', 'session-1')],
    });
    lease(db, 'epoch-1', 200);
    runTx(db, 'wechatMarkAccepted', {
      bindingEpoch: 'epoch-1',
      taskId: 'task-1',
    });
    runTx(db, 'wechatCommitTerminal', {
      bindingEpoch: 'epoch-1',
      taskId: 'task-1',
      now: 300,
      outbox: [outbox('outbox-1', 'client-1', 0, 'result')],
    });
    db.prepare("UPDATE wechat_outbox SET status = 'sending' WHERE id = 'outbox-1'").run();

    expect(
      runTx(db, 'wechatRecordOutboxFailure', {
        bindingEpoch: 'epoch-1',
        outboxId: 'outbox-1',
        nextRetryAt: 400,
        terminal: false,
        errorCode: 'NETWORK_TIMEOUT',
      }),
    ).toEqual({ changed: true, taskId: 'task-1', taskFailed: false });
    expect(db.prepare("SELECT status FROM wechat_outbox WHERE id = 'outbox-1'").pluck().get()).toBe(
      'pending',
    );
    expect(readTaskStatus(db, 'task-1')).toBe('delivery_pending');

    db.prepare("UPDATE wechat_outbox SET status = 'sending' WHERE id = 'outbox-1'").run();
    expect(
      runTx(db, 'wechatRecordOutboxFailure', {
        bindingEpoch: 'epoch-1',
        outboxId: 'outbox-1',
        nextRetryAt: 500,
        terminal: true,
        errorCode: 'AUTH_REPLACED',
      }),
    ).toEqual({ changed: true, taskId: 'task-1', taskFailed: true });
    expect(readTaskStatus(db, 'task-1')).toBe('failed_terminal');
  });

  it('closes an epoch before cleanup and cascades durable rows', () => {
    const db = createDb();
    activate(db, 'epoch-1', null);
    commitBatch(db, {
      bindingEpoch: 'epoch-1',
      expectedCursor: '',
      nextCursor: 'cursor-1',
      messages: [message('task-1', 'platform-1', 'session-1')],
    });

    expect(() => runTx(db, 'wechatUnbindCleanup', { bindingEpoch: 'epoch-1' })).toThrowError(
      /must be closed/,
    );
    expect(
      runTx(db, 'wechatCloseBindingEpoch', {
        bindingEpoch: 'epoch-1',
        now: 200,
      }),
    ).toEqual({ closed: true });
    expect(readTaskStatus(db, 'task-1')).toBe('cancelled');
    expect(runTx(db, 'wechatUnbindCleanup', { bindingEpoch: 'epoch-1' })).toEqual({
      deletedTasks: 1,
      deletedMediaRefs: 0,
      filePaths: [],
    });
    expect(count(db, 'wechat_sync_state')).toBe(0);
    expect(count(db, 'wechat_inbox')).toBe(0);
  });
});

function createDb(): Database.Database {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE media_blobs (
      hash TEXT PRIMARY KEY NOT NULL,
      ext TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      is_cache INTEGER DEFAULT 0 NOT NULL,
      created_at INTEGER NOT NULL,
      last_access_at INTEGER NOT NULL
    );
    CREATE TABLE media_refs (
      id TEXT PRIMARY KEY NOT NULL,
      hash TEXT NOT NULL REFERENCES media_blobs(hash) ON DELETE CASCADE,
      ref_kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      origin_session_id TEXT,
      origin_kind TEXT,
      origin_id TEXT,
      label TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO sessions (id) VALUES ('session-1'), ('session-2');
  `);
  const migrationPath = path.resolve(__dirname, '../../../../../../drizzle/0082_daffy_calypso.sql');
  db.exec(readFileSync(migrationPath, 'utf8').replaceAll('--> statement-breakpoint', ''));
  return db;
}

function activate(db: Database.Database, bindingEpoch: string, expectedActiveEpoch: string | null) {
  return runTx(db, 'wechatActivateBindingEpoch', {
    bindingEpoch,
    expectedActiveEpoch,
    initialCursor: '',
    now: 100,
  });
}

function commitBatch(db: Database.Database, overrides: Record<string, unknown>) {
  return runTx(db, 'wechatCommitPollBatch', {
    bindingEpoch: 'epoch-1',
    expectedCursor: '',
    nextCursor: 'cursor-1',
    now: 100,
    messages: [],
    mediaBlobs: [],
    mediaRefs: [],
    fileAttachments: [],
    ...overrides,
  });
}

function message(id: string, platformMessageId: string, sessionId: string) {
  return {
    id,
    platformMessageId,
    platformSeq: 1,
    peerId: `peer-${sessionId}`,
    receivedAt: 100,
    platformCreatedAt: 99,
    expiresAt: 1_800_100,
    sessionId,
    conversationEpoch: 0,
    payloadJson: JSON.stringify({ text: id }),
    context: CONTEXT,
  };
}

function lease(db: Database.Database, bindingEpoch: string, now: number) {
  return runTx(db, 'wechatLeaseNextTask', {
    bindingEpoch,
    now,
    leaseUntil: now + 60_000,
  });
}

function outbox(id: string, clientId: string, chunkIndex: number, text: string) {
  return { id, clientId, kind: 'final', chunkIndex, text };
}

function runTx(db: Database.Database, name: string, args: Record<string, unknown>): unknown {
  return tx(db, { name, args });
}

function count(db: Database.Database, table: string): number {
  if (!/^[a-z_]+$/.test(table)) throw new Error('invalid test table');
  return Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
}

function readTaskStatus(db: Database.Database, taskId: string): string {
  return String(db.prepare('SELECT status FROM wechat_inbox WHERE id = ?').pluck().get(taskId));
}
