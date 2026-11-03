// Provenance of the HDR avatar fixtures used by hdrAvatarToSdr.test.ts.
// The files are encoded by macOS ImageIO (not hand-built), so they carry the
// real-world signalling: PNG cICP + ICC v4 cicp tags, and ISO 21496-1 gain maps.
// Regenerate on macOS 15+:
//   swiftc -O make-hdr-avatar-fixtures.swift -o /tmp/make-hdr-avatar-fixtures
//   /tmp/make-hdr-avatar-fixtures "$PWD"
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let W = 256, H = 128
// Linear extended sRGB scene: horizontal ramp 0 → 8x SDR white, top half neutral, bottom half warm.
var px = [Float](repeating: 0, count: W * H * 4)
for y in 0..<H { for x in 0..<W {
  let v = Float(x) / Float(W - 1) * 8.0
  let i = (y * W + x) * 4
  if y < H / 2 { px[i] = v; px[i+1] = v; px[i+2] = v } else { px[i] = v; px[i+1] = v * 0.6; px[i+2] = v * 0.3 }
  px[i+3] = 1
}}
let extLinear = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.floatComponents.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
let provider = CGDataProvider(data: Data(bytes: px, count: px.count * 4) as CFData)!
let hdr = CGImage(width: W, height: H, bitsPerComponent: 32, bitsPerPixel: 128, bytesPerRow: W * 16, space: extLinear, bitmapInfo: info, provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!

func convert(_ img: CGImage, to name: CFString, bits: Int) -> CGImage {
  let cs = CGColorSpace(name: name)!
  let bi: UInt32 = bits == 16 ? (CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder16Little.rawValue) : CGImageAlphaInfo.premultipliedLast.rawValue
  let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: bits, bytesPerRow: 0, space: cs, bitmapInfo: bi)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
  return ctx.makeImage()!
}
func write(_ img: CGImage, _ path: String, _ type: UTType, _ opts: [CFString: Any] = [:]) {
  let url = URL(fileURLWithPath: path)
  let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, img, opts as CFDictionary)
  print(path, CGImageDestinationFinalize(dest))
}
let dir = CommandLine.arguments[1]
let pq = convert(hdr, to: CGColorSpace.itur_2100_PQ, bits: 16)
write(pq, "\(dir)/pq-bt2100.png", .png)
let hlg = convert(hdr, to: CGColorSpace.itur_2100_HLG, bits: 16)
write(hlg, "\(dir)/hlg-bt2100.png", .png)
write(pq, "\(dir)/pq-bt2100.jpg", .jpeg, [kCGImageDestinationLossyCompressionQuality: 0.95])
write(hdr, "\(dir)/iso-gainmap.jpg", .jpeg, [kCGImageDestinationEncodeRequest: kCGImageDestinationEncodeToISOGainmap, kCGImageDestinationLossyCompressionQuality: 0.95])
// SDR rendition by ImageIO itself: Display P3 + sRGB transfer cICP (12/13), must stay untouched.
write(hdr, "\(dir)/sdr-display-p3.png", .png, [kCGImageDestinationEncodeRequest: kCGImageDestinationEncodeToSDR])
