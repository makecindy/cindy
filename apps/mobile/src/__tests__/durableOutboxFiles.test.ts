import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DurableOutboxRecord,
  DurableUpload,
} from "../session/durableOutbox";
const fs = vi.hoisted(() => ({
  documentDirectory: "file:///sandbox/Documents/",
  makeDirectoryAsync: vi.fn(async () => {}),
  copyAsync: vi.fn(async (_options: { from: string; to: string }) => {}),
  getInfoAsync: vi.fn(async () => ({
    exists: true,
    isDirectory: false,
    size: 123,
  })),
  deleteAsync: vi.fn(async () => {}),
}));
vi.mock("expo-file-system/legacy", () => fs);
import {
  durableOutboxDirectory,
  durableOutboxUploadUri,
  retainOutboxFile,
  retainComposerAttachmentFile,
  removeRetainedOutboxFiles,
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
  fs.documentDirectory = "file:///sandbox/Documents/";
  fs.getInfoAsync.mockResolvedValue({
    exists: true,
    isDirectory: false,
    size: 123,
  });
});
describe("outbox-owned attachment bytes", () => {
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
