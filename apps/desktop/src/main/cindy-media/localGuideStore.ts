import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AgentKind } from '@cindy/model-providers';
import { parseMediaInvocationGuide, type MediaInvocationGuide } from '../../shared/mediaInvocation.js';
import { atomicWriteFileSync } from '../utils/atomicWriteFile.js';

export interface MediaGuideTarget { providerId: string; agent: AgentKind; modelId: string; }
export interface MediaGuideEvidence { kind: 'documentation' | 'curl' | 'prompt'; }
export interface LocalMediaGuide {
  target: MediaGuideTarget;
  connectionScope: string;
  guide: MediaInvocationGuide;
  evidence?: MediaGuideEvidence;
}
const MAX_BYTES = 2 * 1024 * 1024;
const keyOf = (target: MediaGuideTarget) => JSON.stringify([target.providerId, target.agent, target.modelId]);

/** Small owner-scoped override file; synchronous read/compare/atomic-write is one
 * Main transaction. No defaults, missing entries or public Guides are written. */
export function createLocalGuideStore(filePath: () => string) {
  const readAll = (): Record<string, LocalMediaGuide> => {
    const file = filePath();
    try {
      // Read the atomic writer's surviving backup without mutating on get.
      // A later save must merge it rather than treating it as an empty store.
      const readable = fs.existsSync(file) ? file : `${file}.bak`;
      if (fs.statSync(readable).size > MAX_BYTES) throw new Error('GUIDE_STORE_TOO_LARGE');
      const raw: unknown = JSON.parse(fs.readFileSync(readable, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          !('version' in raw) || raw.version !== 1 || !('guides' in raw) ||
          !raw.guides || typeof raw.guides !== 'object' || Array.isArray(raw.guides)) throw new Error('GUIDE_STORE_INVALID');
      return raw.guides as Record<string, LocalMediaGuide>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  };
  return {
    revision(target: MediaGuideTarget): string | null { return readAll()[keyOf(target)]?.guide.revision ?? null; },
    read(target: MediaGuideTarget, connectionScope: string): LocalMediaGuide | null {
      const entry = readAll()[keyOf(target)];
      if (!entry || entry.connectionScope !== connectionScope) return null;
      const parsed = parseMediaInvocationGuide(entry.guide);
      if (!parsed.ok || keyOf(entry.target) !== keyOf(target)) throw new Error('GUIDE_STORE_INVALID');
      return { ...entry, guide: parsed.value };
    },
    save(target: MediaGuideTarget, connectionScope: string, candidate: unknown,
      expectedRevision: string | null, evidence?: MediaGuideEvidence): LocalMediaGuide {
      const parsed = parseMediaInvocationGuide(candidate);
      if (!parsed.ok) throw new Error(`GUIDE_INVALID: ${parsed.error}`);
      if (evidence && !['documentation', 'curl', 'prompt'].includes(evidence.kind)) throw new Error('GUIDE_EVIDENCE_INVALID');
      const guides = readAll();
      const key = keyOf(target);
      if ((guides[key]?.guide.revision ?? null) !== expectedRevision) throw new Error('GUIDE_REVISION_CONFLICT');
      if (!Object.hasOwn(guides, key) && Object.keys(guides).length >= 128) throw new Error('GUIDE_STORE_FULL');
      const entry: LocalMediaGuide = { target, connectionScope, guide: { ...parsed.value, revision: randomUUID() }, ...(evidence ? { evidence: { kind: evidence.kind } } : {}) };
      const encoded = JSON.stringify({ version: 1, guides: { ...guides, [key]: entry } });
      if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('GUIDE_STORE_TOO_LARGE');
      atomicWriteFileSync(filePath(), encoded);
      return entry;
    },
  };
}
