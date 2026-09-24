import { describe, expect, it } from "vitest";
import { errorText, mediaExtOf, nextFileTrace, resolvedUrlKind } from "./fileDiagnostics";

describe("file diagnostics", () => {
  it("keeps only the extension of a desktop media reference", () => {
    const url = `xdt-file://open?path=${encodeURIComponent("E:/Cindy/hhh/doc/im-watch-v12.HTML")}&baseDir=E%3A%2FCindy`;
    expect(mediaExtOf(url)).toBe("html");
    expect(mediaExtOf("xdt-file://open?path=%2Ftmp%2Fclip.mp4")).toBe("mp4");
    expect(mediaExtOf("xdt-file://open?path=%2Ftmp%2FREADME")).toBe("");
    expect(mediaExtOf("xdt-file://open?path=%E0%A4%A")).toBe("");
  });

  it("reports the scheme of a resolved URL without its address", () => {
    expect(resolvedUrlKind("https://oss.example.com/a.mp4?Signature=x")).toBe("https");
    expect(resolvedUrlKind("file:///var/mobile/cache/file")).toBe("file");
    expect(resolvedUrlKind("data:video/mp4;base64,AAAA")).toBe("data");
    expect(resolvedUrlKind("relative/path")).toBe("unknown");
  });

  it("produces distinct traces and bounded error text", () => {
    expect(nextFileTrace()).not.toBe(nextFileTrace());
    expect(errorText(new Error("FILE_PEER_CANCELLED"))).toBe("FILE_PEER_CANCELLED");
    expect(errorText("x".repeat(500))).toHaveLength(300);
  });
});
