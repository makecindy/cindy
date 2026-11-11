// Compatibility exports: existing Make callers keep the same API.
export {
  extractToolArchive as extractMakeToolArchive,
  safeArchivePath,
  safeArchiveLink,
} from '../managed-tools/archive.js';
