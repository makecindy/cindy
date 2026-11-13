// User-requested process previews: native extraction + persisted refs used by both UIs.
// Unit coverage missing from delivered-media tests; image-only and mixed video are minimal inputs.
import { describe, it, expect } from "vitest";
import {
  readFailedImageDelivery,
  collectNativeToolMedia,
  readToolProcessMedia,
  readToolProcessText,
  withToolProcessMedia,
} from "../toolProcessMedia";
describe("tool process media", () => {
  it("keeps MCP embedded video and Codex dynamic images", () => {
    expect(
      collectNativeToolMedia([
        {
          type: "resource",
          resource: { mimeType: "video/mp4", blob: "dmlkZW8=" },
        },
        { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
        { type: "text", text: "view /tmp/not-an-image.png" },
      ]),
    ).toEqual([
      { kind: "video", data: "dmlkZW8=", mimeType: "video/mp4" },
      { kind: "image", url: "data:image/png;base64,aW1hZ2U=" },
    ]);
  });
  it("preserves sibling metadata and media references while truncating long structured results", () => {
    const refs = [
      { kind: 'image' as const, url: 'cindy-media://blobs/' + 'a'.repeat(64) + '.png' },
    ];
    const input = JSON.stringify({
      ok: true,
      text: 'x'.repeat(9000),
      xdt_video_url: 'https://example.com/final.mp4',
    });
    const output = withToolProcessMedia(input, refs);
    const payload = JSON.parse(output);

    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(8192);
    expect(payload.ok).toBe(true);
    expect(payload.xdt_video_url).toBe('https://example.com/final.mp4');
    expect(payload.text.length).toBeLessThan(9000);
    expect(payload.text).toMatch(/^x+$/);
    expect('x'.repeat(9000).startsWith(payload.text)).toBe(true);
    expect(readToolProcessMedia(output)).toEqual(refs);
  });

  it('falls back to a bounded text-only result when metadata alone exceeds the budget', () => {
    const refs = [
      { kind: 'image' as const, url: 'cindy-media://blobs/' + 'a'.repeat(64) + '.png' },
    ];
    const input = JSON.stringify({ text: 'note', data: 'x'.repeat(9000) });
    const output = withToolProcessMedia(input, refs);
    const payload = JSON.parse(output);

    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(8192);
    expect(payload.data).toBeUndefined();
    expect(payload.text).toBe('');
    expect(readToolProcessMedia(output)).toEqual(refs);
  });

  it("round trips media beside existing delivered results", () => {
    const refs = [
      {
        kind: "image" as const,
        url: "cindy-media://blobs/" + "a".repeat(64) + ".png",
      },
    ];
    const text = withToolProcessMedia(
      '{"xdt_video_url":"https://example.com/final.mp4"}',
      refs,
    );
    expect(readToolProcessMedia(text)).toEqual(refs);
    expect(JSON.parse(text).xdt_video_url).toBe(
      "https://example.com/final.mp4",
    );
  });
  it("rejects arbitrary native paths and active schemes in rendered metadata", () => {
    expect(
      readToolProcessMedia(
        JSON.stringify({
          cindy_process_media: [
            { kind: "image", url: "file:///etc/passwd" },
            { kind: "video", url: "javascript:alert(1)" },
          ],
        }),
      ),
    ).toEqual([]);
    expect(readToolProcessMedia("broken cindy_process_media")).toEqual([]);
  });
  it("keeps multilingual output within the remote byte budget without breaking the media JSON", () => {
    const refs = [
      { kind: "video" as const, url: "https://example.com/clip.mp4" },
    ];
    const text = withToolProcessMedia("截图说明😀".repeat(3000), refs);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(8192);
    expect(readToolProcessMedia(text)).toEqual(refs);
    expect(JSON.parse(text).text).toMatch(/^截图说明😀/);
  });
});

// Unit: more references than the wire can hold must remain parseable, including
// when one signed URL alone exceeds the budget. The count records omitted items.
it("budgets whole references and exposes the original multiline tool text", () => {
  const refs = Array.from({ length: 100 }, (_, i) => ({ kind: "image" as const, url: `https://example.com/${i}.png?token=${"x".repeat(150)}` }));
  refs.unshift({ kind: "image", url: "https://example.com/oversized?" + "x".repeat(9000) });
  const encoded = withToolProcessMedia("", refs);
  expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(8192);
  const kept = readToolProcessMedia(encoded);
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.every(ref => refs.some(original => original.url === ref.url))).toBe(true);
  expect(JSON.parse(encoded).cindy_process_media_omitted).toBe(refs.length - kept.length);
  expect(readToolProcessText(withToolProcessMedia("first\nsecond", refs.slice(-1)))).toBe("first\nsecond");
  const json = '{"ok":true,"text":"note"}';
  expect(JSON.parse(readToolProcessText(withToolProcessMedia(json, refs.slice(-1)))!)).toEqual(JSON.parse(json));
  expect(readToolProcessText(json)).toBe(json);
});

it('only offers image delivery retry for a failed Host artifact record', () => {
  const value = { kind: 'generation', native_image_delivery: { id: 'a'.repeat(64), state: 'failed' } };
  expect(readFailedImageDelivery(JSON.stringify(value))).toBe('a'.repeat(64));
  expect(readFailedImageDelivery(JSON.stringify({ ...value, native_image_delivery: { ...value.native_image_delivery, state: 'stored' } }))).toBeNull();
  expect(readFailedImageDelivery(JSON.stringify({ ...value, native_image_delivery: { id: '/tmp/image.png', state: 'failed' } }))).toBeNull();
});
