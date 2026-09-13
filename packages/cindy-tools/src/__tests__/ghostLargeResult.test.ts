import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleGhostCall } from "../ghost/mcpServer.js";
import { GHOST_RESULT_MAX_BYTES } from "../ghost/largeResult.js";

const input = { ghost_id: "synthetic", tool: "large-result" };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("ghost_call oversized result boundary", () => {
  it.each(["x".repeat(641694), "\\".repeat(641694), "汉".repeat(213898), "😀".repeat(160424)])(
    "persists the complete production handler response and bounds the MCP envelope (case %#)",
    async data => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cindy-ghost-result-"));
      roots.push(root);
      const filename = "result.json";
      const save = vi.fn(async (text: string) => {
        await fs.writeFile(path.join(root, filename), text, { flag: "wx", mode: 0o600 });
        return filename;
      });
      const call = vi.fn(async () => ({ ok: true as const, result: { data } }));
      const response = await handleGhostCall({ callGhostTool: call, saveLargeGhostResult: save }, input);
      const projected = JSON.parse(response.content[0].text);
      expect(save).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledOnce();
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(GHOST_RESULT_MAX_BYTES);
      expect(projected).toMatchObject({ ok: true, saved_to: filename, complete_result_saved: true, truncated: true });
      const stored = await fs.readFile(path.join(root, projected.saved_to), "utf8");
      expect(hash(JSON.parse(stored).result.data)).toBe(hash(data));
      expect(projected.bytes).toBe(Buffer.byteLength(stored));
      expect(Buffer.byteLength(JSON.stringify(projected.preview))).toBeLessThanOrEqual(1024);
      expect(response.isError).toBeUndefined();
    },
  );

  it("preserves small results byte for byte and never asks the Host to save", async () => {
    const payload = { ok: true as const, result: { data: "small", saved_to: "existing.json" } };
    const save = vi.fn();
    const response = await handleGhostCall({ callGhostTool: async () => payload, saveLargeGhostResult: save }, input);
    expect(response).toEqual({ content: [{ type: "text", text: JSON.stringify(payload) }] });
    expect(save).not.toHaveBeenCalled();
  });

  it("counts escaping in the envelope even when raw UTF-8 text is below 64 KiB", async () => {
    const data = "\\".repeat(20000);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: { data } }))).toBeLessThan(GHOST_RESULT_MAX_BYTES);
    const save = vi.fn(async () => "escaped.json");
    await handleGhostCall({ callGhostTool: async () => ({ ok: true, result: { data } }), saveLargeGhostResult: save }, input);
    expect(save).toHaveBeenCalledOnce();
  });

  it.each(["missing", "rejected"])("bounds an unavailable storage result without repeating the plugin (%s)", async kind => {
    const call = vi.fn(async () => ({ ok: true as const, result: { data: "x".repeat(70000) } }));
    const save = kind === "missing" ? undefined : vi.fn(async () => { throw new Error("private path /secret"); });
    const response = await handleGhostCall({ callGhostTool: call, saveLargeGhostResult: save }, input);
    const projected = JSON.parse(response.content[0].text);
    expect(projected).toMatchObject({ ok: true, complete_result_saved: false, truncated: true });
    expect(projected.saved_to).toBeUndefined();
    expect(response.content[0].text).not.toContain("/secret");
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(GHOST_RESULT_MAX_BYTES);
    expect(call).toHaveBeenCalledOnce();
  });

  // Codex P1 (round 13): a rejected callGhostTool must not bypass the bound.
  it("bounds an oversized thrown error from callGhostTool through the same helper", async () => {
    const message = "transport failure: " + "y".repeat(200000);
    const save = vi.fn(async () => "thrown.json");
    const response = await handleGhostCall({ callGhostTool: async () => { throw new Error(message); }, saveLargeGhostResult: save }, input);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(GHOST_RESULT_MAX_BYTES);
    expect(response.isError).toBe(true);
    const projected = JSON.parse(response.content[0].text);
    expect(projected).toMatchObject({ ok: false, errorCode: "INTERNAL", saved_to: "thrown.json", truncated: true, complete_result_saved: true });
    expect(save).toHaveBeenCalledOnce();
    expect(JSON.parse((save.mock.calls[0] as unknown as [string])[0]).message).toBe(message);
  });

  it("keeps a small thrown error byte for byte", async () => {
    const save = vi.fn();
    const response = await handleGhostCall({ callGhostTool: async () => { throw new Error("boom"); }, saveLargeGhostResult: save }, input);
    expect(response).toEqual({ content: [{ type: "text", text: JSON.stringify({ ok: false, errorCode: "INTERNAL", message: "boom" }) }], isError: true });
    expect(save).not.toHaveBeenCalled();
  });

  it("retains the original error status for an oversized plugin failure", async () => {
    const response = await handleGhostCall({ callGhostTool: async () => ({ ok: false, errorCode: "INTERNAL", message: "x".repeat(70000) }), saveLargeGhostResult: async () => "error.json" }, input);
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ ok: false, complete_result_saved: true });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(GHOST_RESULT_MAX_BYTES);
  });

  it("keeps hoisted media/card routing while saving the complete result", async () => {
    const image = `cindy-media://blobs/${"a".repeat(64)}.png`;
    const save = vi.fn(async (_text: string) => "media.json");
    const response = await handleGhostCall({ callGhostTool: async () => ({ ok: true, result: { data: "x".repeat(70000), xdt_image_urls: [image], xdt_card_id: "card" } }), saveLargeGhostResult: save }, input);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ xdt_image_urls: [image], xdt_card_id: "card", complete_result_saved: true });
    expect(JSON.parse(response.content[0].text).hint).toContain("媒体已由聊天气泡自动渲染成卡片");
    expect(JSON.parse(save.mock.calls[0]![0]).result.data).toHaveLength(70000);
  });
});
