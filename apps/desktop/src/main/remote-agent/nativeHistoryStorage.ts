import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { findClaudeSessionJsonl, sanitizeClaudeProjectKey } from '@cindy/maker-core';
import { defaultClaudeConfigDirCandidates } from '../maker-orchestration/claudeTranscriptAnchors';
import { readCodexThreadStorageReadOnly } from '../maker-host/codex-thread-storage';
import { dumpCodexThreadStateRows, importSharedCodexThread, removeSharedCodexThread } from '../maker-host/codex-local-sessions';
import { migrationNativeContext } from '../session-share/migrationNativeContext';
import { writeMigratedTranscript } from '../session-share/migrationTranscriptWriter';
import { claudeConfigDir } from './controller/projectFiles';
import type { NativeHistoryStorage } from './nativeHistoryTransfer';

/** Reuses the task-copy native writers without importing a second Cindy task or any credentials. */
export function nativeHistoryStorage(userDataDir: string): NativeHistoryStorage {
  return {
    async locate(kind, nativeId) {
      if (kind !== 'pi' && !/^[a-f0-9-]{36}$/i.test(nativeId)) throw new Error('NATIVE_HISTORY_INVALID_ID');
      if (kind === 'claude-code') {
        let file: string | null = null;
        for (const dir of defaultClaudeConfigDirCandidates()) {
          file = await findClaudeSessionJsonl(nativeId, undefined, path.join(dir, 'projects'));
          if (file) break;
        }
        if (!file) throw new Error('NATIVE_HISTORY_MISSING');
        return { file };
      }
      if (kind === 'codex') {
        const storage = await readCodexThreadStorageReadOnly(nativeId);
        const { rolloutPath, ...state } = await dumpCodexThreadStateRows(nativeId, storage);
        if (!rolloutPath) throw new Error('NATIVE_HISTORY_MISSING');
        return { file: rolloutPath, state };
      }
      // Pi resumes by absolute JSONL path. Only native history within Cindy's Pi home is transferable.
      const root = await fs.realpath(path.join(userDataDir, 'pi-agent-home'));
      const file = await fs.realpath(nativeId);
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !file.endsWith('.jsonl')) throw new Error('NATIVE_HISTORY_INVALID_ID');
      return { file };
    },
    async restore(file, manifest, workingDir, assertCurrent) {
      const context = migrationNativeContext(randomUUID(), [manifest.nativeId]);
      const nativeId = context.id(manifest.nativeId);
      assertCurrent();
      if (manifest.kind === 'codex') {
        // Codex's paginated rollout reader requires rollout-<timestamp>-<uuid>.jsonl.
        // A descriptive prefix such as rollout-relocated is not resumable.
        const updatedAt = Date.now();
        const timestamp = new Date(updatedAt).toISOString().slice(0, 19).replaceAll(':', '-');
        const written = await importSharedCodexThread({
          migration: true, threadId: nativeId,
          stateRows: context.stateRows(manifest.state ?? { threads: [], threadDynamicTools: [], threadSpawnEdges: [] }),
          rolloutBuffer: null,
          writeRollout: target => writeMigratedTranscript(createReadStream(file), target, { context, agent: 'codex' }, assertCurrent),
          rolloutFilename: `rollout-${timestamp}-${nativeId}.jsonl`, newCwd: workingDir, title: '', updatedAt,
        });
        try {
          assertCurrent();
          if (!written.rolloutPath || (manifest.state?.threads.length && !written.statePresent)) {
            throw new Error('NATIVE_HISTORY_INCOMPLETE');
          }
          return nativeId;
        } catch (error) { await removeSharedCodexThread(nativeId, written); throw error; }
      }
      const target = manifest.kind === 'claude-code'
        ? path.join(claudeConfigDir(), 'projects', sanitizeClaudeProjectKey(workingDir), `${nativeId}.jsonl`)
        : path.join(userDataDir, 'pi-agent-home', 'sessions', `relocated-${nativeId}.jsonl`);
      await writeMigratedTranscript(createReadStream(file), target,
        manifest.kind === 'claude-code' ? { context, agent: 'cc' }
          : { agent: 'pi', sessionId: nativeId, cwd: workingDir }, assertCurrent);
      return manifest.kind === 'pi' ? target : nativeId;
    },
  };
}
