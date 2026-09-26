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

  it("strips paths and URLs from native, SSH and WebView failures", () => {
    expect(errorText(new Error("ENOENT: /data/user/0/com.cindy/cache/a.html"))).toBe(
      "ENOENT: [redacted-path]",
    );
    expect(errorText("failed file:///var/mobile/Containers/Data/Application/ABC/tmp/x.html")).toBe(
      "failed [redacted-url]",
    );
    expect(errorText("open E:\\Cindy\\secret\\file.html")).toBe("open [redacted-path]");
    expect(errorText("open \\\\server\\share\\secret.html")).toBe("open [redacted-path]");
    expect(errorText("open \\\\files.corp\\workdir\\doc.html")).toBe("open [redacted-path]");
    expect(errorText("ssh: /srv/secret/plot.png")).toBe("ssh: [redacted-path]");
    expect(errorText("https://oss.example.com/a.mp4?Signature=secret")).toBe("[redacted-url]");
    expect(
      errorText(
        'Error Domain=NSURLErrorDomain Code=-1100 UserInfo={NSErrorFailingURLStringKey=file:///var/mobile/cache/x}',
      ),
    ).not.toMatch(/var\/mobile|file:\/\//);
    expect(errorText("")).toBe("");
  });
});
