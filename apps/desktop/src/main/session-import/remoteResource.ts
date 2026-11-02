/**
 * 手机远程的任务导入：通过现有远程资源机制提供与设置页同样的列表、导入与结果。
 *
 * - `scan`：可导入的任务（不含隐藏类），只给显示需要的字段：分组名、标题、来源、时间、大小；
 *   不发文件路径、来源内部定位信息（路径与凭证不出电脑），分组键换成不透明的摘要；
 * - `job:<requestId>` / `job:latest`：导入进度与逐项结果；
 * - 动作 `import`（input.keys）开始导入，`cancel`（input.requestId）停止。
 *   原文件夹不存在的任务需要在电脑上选新文件夹，手机上只提示。
 */

import { createHash } from 'node:crypto';

import {
  remoteResourceRegistry,
  RemoteResourceRegistryError,
  type RemoteResourceProvider,
} from '../device-link/remoteResourceRegistry.js';
import { cancelImport, importJob, latestImportJob, recoverInterruptedImports, startImport } from './executor.js';
import { scanImportSources } from './scan.js';
import type { ImportJobView } from './types.js';

export const SESSION_IMPORT_COLLECTION = 'session-import';
export const SESSION_IMPORT_PRIMITIVE = 'session-import';
const KIND = 'import';
const MAX_CANDIDATES = 1000;
const MAX_KEYS = 400;

const groupToken = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);

function jobData(job: ImportJobView) {
  return {
    kind: 'job' as const,
    requestId: job.requestId,
    status: job.status,
    items: job.items.map((it) => ({
      key: it.key,
      source: it.source,
      title: it.title,
      status: it.status,
      step: it.step,
      messagesWritten: it.messagesWritten,
      mode: it.mode,
      harness: it.harness,
      issue: it.issue,
      sessionId: it.status === 'ready' || it.status === 'action' ? it.sessionId : null,
    })),
  };
}

function resource(id: string, data: unknown) {
  return {
    ref: { collectionId: SESSION_IMPORT_COLLECTION, kind: KIND, id },
    revision: '1',
    display: { title: 'Import' },
    links: [],
    blocks: [{ id: 'import', primitive: SESSION_IMPORT_PRIMITIVE, fallbackMarkdown: 'Session import', data }],
  };
}

export function createSessionImportRemoteProvider(): RemoteResourceProvider {
  return {
    collection: {
      id: SESSION_IMPORT_COLLECTION,
      resourceKind: KIND,
      title: 'Import',
      placement: 'hidden',
      icon: { name: 'import', fallbackText: '↓' },
    },
    async list() {
      return { collectionId: SESSION_IMPORT_COLLECTION, revision: '1', items: [] };
    },
    async get(_context, request) {
      if (!request.client.primitives.includes(SESSION_IMPORT_PRIMITIVE)) {
        throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'client does not render session import');
      }
      const id = request.ref.id;
      if (id === 'scan' || id === 'scan:force') {
        void recoverInterruptedImports();
        const scan = await scanImportSources(id === 'scan:force');
        const visible = scan.candidates.filter((c) => !c.hidden).sort((a, b) => b.updatedAt - a.updatedAt);
        return resource(id, {
          kind: 'scan',
          total: visible.length,
          candidates: visible.slice(0, MAX_CANDIDATES).map((c) => ({
            key: c.key,
            source: c.source,
            title: c.title,
            group: c.dialogue ? 'dialogue' : groupToken(c.groupKey),
            groupName: c.dialogue ? '' : c.groupName,
            dialogue: c.dialogue,
            updatedAt: c.updatedAt,
            archived: c.archived,
            sizeBytes: c.sizeBytes,
            missingDir: c.missingDir,
            unsupported: !!c.unsupportedVersion,
          })),
          hiddenTotal: scan.hiddenCounts.cindy + scan.hiddenCounts.temp + scan.hiddenCounts.internal + scan.hiddenCounts.imported,
        });
      }
      if (id.startsWith('job:')) {
        await recoverInterruptedImports();
        const requestId = id.slice('job:'.length);
        const job = requestId === 'latest' ? latestImportJob() : importJob(requestId);
        return resource(id, job ? jobData(job) : { kind: 'job', requestId, status: 'missing', items: [] });
      }
      throw new RemoteResourceRegistryError('NOT_FOUND', 'unknown session import resource');
    },
    async invoke(_context, request) {
      if (request.actionId === 'import') {
        const raw = request.input?.keys;
        const keys = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string' && /^[a-z]+:[^\s]{1,512}$/.test(k)) : [];
        if (keys.length === 0 || keys.length > MAX_KEYS) throw new RemoteResourceRegistryError('INVALID_PARAMS', 'keys');
        const job = await startImport(keys);
        return {
          result: jobData(job),
          effects: [{ kind: 'navigate', target: { kind: 'resource', ref: { collectionId: SESSION_IMPORT_COLLECTION, kind: KIND, id: `job:${job.requestId}` } } }],
        };
      }
      if (request.actionId === 'cancel') {
        const requestId = typeof request.input?.requestId === 'string' ? request.input.requestId : '';
        if (!requestId) throw new RemoteResourceRegistryError('INVALID_PARAMS', 'requestId');
        return { result: { cancelled: cancelImport(requestId) }, effects: [] };
      }
      throw new RemoteResourceRegistryError('INVALID_PARAMS', 'unknown action');
    },
  };
}

export function registerSessionImportRemoteResource(): void {
  remoteResourceRegistry.register(createSessionImportRemoteProvider());
}
