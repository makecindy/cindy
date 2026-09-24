import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DurableOutboxRecord,
  DurableUpload,
} from "../session/durableOutbox";
import { buildMobileRemoteFileAttachment, buildMobileUploadedAttachment } from '../session/attachments';
const fs = vi.hoisted(() => ({
  ledger: new Map<string, string>(),
  directories: new Map<string, string[]>(),
  stageExists: true,
  removeStage: vi.fn(),
  stagePaths: [] as string[],
  documentDirectory: "file:///sandbox/Documents/",
  makeDirectoryAsync: vi.fn(async () => {}),
  copyAsync: vi.fn(async (_options: { from: string; to: string }) => {}),
  getInfoAsync: vi.fn(async (_uri: string) => ({
    exists: true,
    isDirectory: false,
    size: 123,
  })),
  deleteAsync: vi.fn(async () => {}),
  readDirectoryAsync: vi.fn(async (uri: string): Promise<string[]> => fs.directories.get(uri) ?? []),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getAllKeys: vi.fn(async () => [...fs.ledger.keys()]),
  getItem: vi.fn(async (key: string) => fs.ledger.get(key) ?? null),
} }));
vi.mock("expo-file-system/legacy", () => fs);
vi.mock('expo-file-system', () => ({ Directory: class {
  constructor(uri: string) { fs.stagePaths.push(uri); }
  get exists() { return fs.stageExists; }
  delete() { fs.removeStage(); }
} }));
import {
  durableOutboxDirectory,
  durableOutboxUploadUri,
  retainOutboxFile,
  retainComposerAttachmentFile,
  removeRetainedOutboxFiles,
  initializeComposerAttachmentStage,
  initializeOutboxFiles,
  outboxAttachmentNeedsLocalBytes,
} from "../session/durableOutboxFiles";
const record = {
  accountId: "owner/../a",
  deviceId: "mac",
  item: { sessionId: "../session", clientId: "id" },
} as DurableOutboxRecord;
const source = {
  uri: "file:///cache/prepared.jpg",
  name: "photo.jpg",
  size: 123,
  mimeType: "image/jpeg",
  kind: "image" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as { __cindyOutboxStageInitialized?: boolean }).__cindyOutboxStageInitialized;
  delete (globalThis as { __cindyOutboxFilesInitialized?: Promise<void> }).__cindyOutboxFilesInitialized;
  fs.ledger.clear();
  fs.directories.clear();
  fs.stageExists = true;
  fs.stagePaths.length = 0;
  fs.removeStage.mockReset();
  fs.documentDirectory = "file:///sandbox/Documents/";
  fs.getInfoAsync.mockResolvedValue({
    exists: true,
    isDirectory: false,
    size: 123,
  });
});
describe("outbox-owned attachment bytes", () => {
  it('reclaims pre-commit and replaced files while preserving every account ledger', async () => {
    const root = fs.documentDirectory + 'message-outbox/';
    fs.directories.set(root, ['alice', 'bob']);
    for (const accountId of ['alice', 'bob']) {
      const r = { ...record, version: 1, accountId, uploads: [{ fileName: 'slot-0.jpg' }] } as DurableOutboxRecord;
      const dir = durableOutboxDirectory(r);
      fs.ledger.set(`cindy.mobile.outbox.v1.${accountId}/mac/session/id`, JSON.stringify(r));
      fs.directories.set(root + accountId + '/', ['mac']);
      fs.directories.set(root + accountId + '/mac/', ['%2E%2E%2Fsession']);
      fs.directories.set(root + accountId + '/mac/%2E%2E%2Fsession/', ['id', 'uncommitted']);
      fs.directories.set(dir, ['slot-0.jpg', 'slot-1.jpg']);
      fs.directories.set(dir.replace('/id/', '/uncommitted/'), ['slot-0.jpg']);
    }
    fs.getInfoAsync.mockImplementation(async (uri) => ({ exists: true, isDirectory: fs.directories.has(uri), size: 123 }));
    await initializeOutboxFiles();
    expect(fs.deleteAsync).toHaveBeenCalledTimes(4);
    expect(fs.deleteAsync.mock.calls.flat()).not.toContain(durableOutboxDirectory({ ...record, accountId: 'alice' }) + 'slot-0.jpg');
    expect(fs.deleteAsync.mock.calls.flat()).not.toContain(durableOutboxDirectory({ ...record, accountId: 'bob' }) + 'slot-0.jpg');
    await retainOutboxFile(record, 0, source);
    await initializeOutboxFiles();
    expect(fs.deleteAsync).toHaveBeenCalledTimes(4);
  });
  it('blocks copying and deletion on a corrupt ledger, then retries safely', async () => {
    fs.ledger.set('cindy.mobile.outbox.v1.broken', '{broken');
    await expect(retainOutboxFile(record, 0, source)).rejects.toThrow();
    expect(fs.copyAsync).not.toHaveBeenCalled();
    expect(fs.deleteAsync).not.toHaveBeenCalled();
    fs.ledger.clear();
    await retainOutboxFile(record, 0, source);
    expect(fs.copyAsync).toHaveBeenCalledOnce();
  });
  it('requires retry bytes for phone uploads but preserves Desktop file references without a phone copy', () => {
    const remote = buildMobileRemoteFileAttachment('/Users/dash/report.pdf')!;
    const uploaded = buildMobileUploadedAttachment({ ossKey: 'uploads/report.pdf', name: 'report.pdf', size: 123, sha256: 'a'.repeat(64) })!;
    expect(outboxAttachmentNeedsLocalBytes(remote)).toBe(false);
    expect(outboxAttachmentNeedsLocalBytes(uploaded)).toBe(true);
    expect(outboxAttachmentNeedsLocalBytes({ path: 'cindy-oss-attach://m/legacy' })).toBe(true);
  });
  it('clears previous-runtime staging once without touching retained outbox files or active composers', async () => {
    initializeComposerAttachmentStage();
    await retainComposerAttachmentFile('one', 'id', source.uri, source.size);
    await retainComposerAttachmentFile('two', 'id', source.uri, source.size);
    initializeComposerAttachmentStage();
    expect(fs.stagePaths).toEqual(['file:///sandbox/Documents/outbox-attachment-stage/']);
    expect(fs.removeStage).toHaveBeenCalledOnce();
    expect(fs.copyAsync).toHaveBeenCalledTimes(2);
  });
  it('does not write staging bytes after cleanup fails and retries on the next retain', async () => {
    fs.removeStage.mockImplementationOnce(() => { throw new Error('directory busy'); });
    await expect(retainComposerAttachmentFile('one', 'id', source.uri, source.size)).rejects.toThrow('directory busy');
    expect(fs.makeDirectoryAsync).not.toHaveBeenCalled();
    expect(fs.copyAsync).not.toHaveBeenCalled();
    await retainComposerAttachmentFile('one', 'id', source.uri, source.size);
    expect(fs.removeStage).toHaveBeenCalledTimes(2);
    expect(fs.copyAsync).toHaveBeenCalledOnce();
  });
  it('accepts an absent staging directory on first launch', () => {
    fs.stageExists = false;
    initializeComposerAttachmentStage();
    expect(fs.removeStage).not.toHaveBeenCalled();
  });
  it('does not repeat startup deletion when Fast Refresh reloads the module', async () => {
    await retainComposerAttachmentFile('active', 'id', source.uri, source.size);
    vi.resetModules();
    const refreshed = await import('../session/durableOutboxFiles');
    refreshed.initializeComposerAttachmentStage();
    await refreshed.retainComposerAttachmentFile('next', 'id', source.uri, source.size);
    expect(fs.removeStage).toHaveBeenCalledOnce();
  });
  it('keeps composer PUT bytes outside evictable caches and verifies the copy', async () => {
    const target = await retainComposerAttachmentFile('composer/owner', 'file/id', source.uri, source.size);
    expect(target).toBe('file:///sandbox/Documents/outbox-attachment-stage/composer%2Fowner/file%2Fid');
    expect(fs.copyAsync).toHaveBeenCalledWith({ from: source.uri, to: target });
    expect(fs.getInfoAsync).toHaveBeenCalledWith(target);
  });
  it('removes partial composer copies and refuses cache fallback', async () => {
    fs.copyAsync.mockRejectedValueOnce(new Error('disk full'));
    await expect(retainComposerAttachmentFile('owner', 'id', source.uri, source.size)).rejects.toThrow('disk full');
    expect(fs.deleteAsync).toHaveBeenCalledWith('file:///sandbox/Documents/outbox-attachment-stage/owner/id', { idempotent: true });
    fs.documentDirectory = '';
    await expect(retainComposerAttachmentFile('owner', 'id', source.uri, source.size)).rejects.toThrow('OUTBOX_STORAGE_UNAVAILABLE');
    expect(fs.copyAsync).toHaveBeenCalledOnce();
  });
  it("copies and verifies the full attachment before handing ownership to a record", async () => {
    const upload = await retainOutboxFile(record, 0, source);
    expect(fs.copyAsync).toHaveBeenCalledWith({
      from: source.uri,
      to: durableOutboxUploadUri(record, upload),
    });
    expect(upload.size).toBe(123);
    expect(durableOutboxDirectory(record)).not.toContain("/../");
  });
  it("rejects a partial copy rather than accepting a message with missing bytes", async () => {
    fs.getInfoAsync.mockResolvedValue({
      exists: true,
      isDirectory: false,
      size: 12,
    });
    await expect(retainOutboxFile(record, 0, source)).rejects.toThrow(
      "OUTBOX_FILE_COPY_FAILED",
    );
    expect(fs.deleteAsync).toHaveBeenCalledWith(fs.copyAsync.mock.calls[0]?.[0].to, { idempotent: true });
  });
  it("rolls back new copies without deleting older recovery files in the same directory", async () => {
    const upload = await retainOutboxFile(record, 0, source);
    await removeRetainedOutboxFiles({ ...record, uploads: [upload] });
    expect(fs.deleteAsync).toHaveBeenCalledTimes(1);
    expect(fs.deleteAsync).toHaveBeenCalledWith(durableOutboxUploadUri(record, upload), { idempotent: true });
  });
  it("uses relative filenames so a sandbox path change after restore does not break attachments", () => {
    const upload = { fileName: "slot-0.jpg" } as DurableUpload;
    const previous = durableOutboxUploadUri(record, upload);
    fs.documentDirectory = "file:///new-sandbox/Documents/";
    expect(durableOutboxUploadUri(record, upload)).toBe(
      previous.replace("sandbox/", "new-sandbox/"),
    );
  });
  it("rejects forged filenames before reading or deleting outside the message directory", () => {
    expect(() =>
      durableOutboxUploadUri(record, {
        fileName: "../other/file.jpg",
      } as DurableUpload),
    ).toThrow("OUTBOX_FILE_INVALID");
  });
});
