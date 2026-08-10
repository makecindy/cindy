import { describe, expect, it } from "vitest";

import { MjpegFrameParser, parseMjpegBoundary } from "./mjpeg-parser.js";

const encoder = new TextEncoder();

function part(boundary: string, bytes: Uint8Array): Uint8Array {
  const headers = encoder.encode(
    `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`,
  );
  const result = new Uint8Array(headers.length + bytes.length + 2);
  result.set(headers);
  result.set(bytes, headers.length);
  result.set([13, 10], headers.length + bytes.length);
  return result;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe("MjpegFrameParser", () => {
  it("parses multiple frames split across arbitrary chunk boundaries", () => {
    const boundary = "BoundaryString";
    const first = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    const second = new Uint8Array([0xff, 0xd8, 3, 4, 5, 0xff, 0xd9]);
    const body = concat(part(boundary, first), part(boundary, second));
    const parser = new MjpegFrameParser({ boundary });
    const frames: Uint8Array[] = [];

    for (let index = 0; index < body.length; index += 3) {
      frames.push(...parser.push(body.slice(index, index + 3)));
    }

    expect(frames).toEqual([first, second]);
    expect(() => parser.finish()).not.toThrow();
  });

  it("rejects oversized headers and declared frame bodies", () => {
    const headerParser = new MjpegFrameParser({
      boundary: "b",
      maxHeaderBytes: 8,
    });
    expect(() =>
      headerParser.push(encoder.encode("--b\r\nContent-Type: image/jpeg")),
    ).toThrow("headers exceed");

    const frameParser = new MjpegFrameParser({
      boundary: "b",
      maxFrameBytes: 2,
    });
    expect(() =>
      frameParser.push(encoder.encode("--b\r\nContent-Length: 3\r\n\r\n")),
    ).toThrowError(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
  });

  it("requires a bounded content length and detects truncated bodies", () => {
    const missingLength = new MjpegFrameParser({ boundary: "b" });
    expect(() =>
      missingLength.push(
        encoder.encode("--b\r\nContent-Type: image/jpeg\r\n\r\n"),
      ),
    ).toThrow("Content-Length");

    const truncated = new MjpegFrameParser({ boundary: "b" });
    truncated.push(
      concat(
        encoder.encode("--b\r\nContent-Length: 4\r\n\r\n"),
        new Uint8Array([0xff, 0xd8]),
      ),
    );
    expect(() => truncated.finish()).toThrow("ended inside");
  });
});

describe("parseMjpegBoundary", () => {
  it("accepts quoted and unquoted multipart boundary parameters", () => {
    expect(
      parseMjpegBoundary("multipart/x-mixed-replace; boundary=frame"),
    ).toBe("frame");
    expect(parseMjpegBoundary('multipart/mixed; boundary="--quoted"')).toBe(
      "quoted",
    );
  });

  it("rejects non-multipart responses", () => {
    expect(() => parseMjpegBoundary("image/jpeg")).toThrow("not multipart");
  });
});
