import { describe, expect, it } from "vitest";

import {
  collectRemoteMarkdownImages,
  replaceUploadedRemoteImages,
} from "../outbound.js";

describe("dingtalk outbound markdown images", () => {
  it("collects unique HTTPS images with a strict limit", () => {
    const text = [
      "![first](https://cdn.example/one.png)",
      "![duplicate](https://cdn.example/one.png)",
      "![second](https://cdn.example/two.jpg)",
      "![third](https://cdn.example/three.webp)",
    ].join("\n");

    expect(collectRemoteMarkdownImages(text, 2)).toEqual([
      { alt: "first", url: "https://cdn.example/one.png" },
      { alt: "second", url: "https://cdn.example/two.jpg" },
    ]);
  });

  it("rejects credentials and non-HTTPS image URLs", () => {
    const text = [
      "![http](http://cdn.example/image.png)",
      "![credentials](https://user:secret@cdn.example/image.png)",
      "![safe](https://cdn.example/image.png)",
    ].join("\n");

    expect(collectRemoteMarkdownImages(text, 4)).toEqual([
      { alt: "safe", url: "https://cdn.example/image.png" },
    ]);
  });

  it("removes only successfully uploaded image URLs", () => {
    const uploaded = "https://cdn.example/uploaded.png";
    const failed = "https://cdn.example/failed.png";
    const text = `before\n![uploaded](${uploaded})\n![failed](${failed})\nafter`;

    expect(replaceUploadedRemoteImages(text, new Set([uploaded]))).toBe(
      `before\nuploaded\n![failed](${failed})\nafter`,
    );
  });
});
