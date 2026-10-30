import CoreGraphics
import CoreVideo

@main
struct PresentationCropTests {
  static func main() {
    let bounds = CGRect(x: 0, y: 0, width: 400, height: 800)
    // Fit and letterboxed layouts keep the whole frame, including rounding noise.
    assert(RemoteDesktopPresentationCrop.visibleRegion(
      viewport: CGRect(x: 0, y: 287.5, width: 400, height: 225), bounds: bounds) == nil)
    assert(RemoteDesktopPresentationCrop.visibleRegion(
      viewport: CGRect(x: -0.4, y: 0, width: 400.8, height: 800), bounds: bounds) == nil)
    assert(RemoteDesktopPresentationCrop.visibleRegion(viewport: .zero, bounds: bounds) == nil)
    assert(RemoteDesktopPresentationCrop.visibleRegion(
      viewport: CGRect(x: 0, y: 0, width: 400, height: 225), bounds: .zero) == nil)
    // A 4x zoom panned right/down keeps exactly the on-screen quarter.
    let zoomed = RemoteDesktopPresentationCrop.visibleRegion(
      viewport: CGRect(x: -800, y: -100, width: 1600, height: 900), bounds: bounds)!
    assert(abs(zoomed.minX - 0.5) < 1e-9 && abs(zoomed.width - 0.25) < 1e-9)
    assert(abs(zoomed.minY - 100.0 / 900) < 1e-9 && abs(zoomed.height - 800.0 / 900) < 1e-9)
    // Pixel rects stay chroma aligned, even sized and inside the frame.
    let rect = RemoteDesktopPresentationCrop.pixelRect(region: zoomed, width: 1920, height: 1080)!
    assert(rect == CGRect(x: 960, y: 120, width: 480, height: 960))
    let edge = RemoteDesktopPresentationCrop.pixelRect(
      region: CGRect(x: 0.9993, y: 0.0003, width: 0.0007, height: 0.9997), width: 1921, height: 1081)!
    assert(Int(edge.minX) % 2 == 0 && Int(edge.minY) % 2 == 0)
    assert(Int(edge.width) % 2 == 0 && Int(edge.height) % 2 == 0 && edge.width >= 2)
    assert(edge.maxX <= 1921 && edge.maxY <= 1081)

    // Row copies select the same luma and chroma samples as the source.
    var source: CVPixelBuffer?
    let attributes = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary
    assert(CVPixelBufferCreate(nil, 64, 32, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      attributes, &source) == kCVReturnSuccess)
    let input = source!
    CVPixelBufferLockBaseAddress(input, [])
    for plane in 0..<2 {
      let base = CVPixelBufferGetBaseAddressOfPlane(input, plane)!.assumingMemoryBound(to: UInt8.self)
      let stride = CVPixelBufferGetBytesPerRowOfPlane(input, plane)
      for row in 0..<CVPixelBufferGetHeightOfPlane(input, plane) {
        for column in 0..<64 { base[row * stride + column] = UInt8((row * 3 + column + plane * 100) & 0xff) }
      }
    }
    CVPixelBufferUnlockBaseAddress(input, [])
    let cropper = RemoteDesktopPresentationCropper()
    let region = CGRect(x: 0.25, y: 0.5, width: 0.5, height: 0.25)
    let output = cropper.crop(input, region: region)!
    assert(CVPixelBufferGetWidth(output) == 32 && CVPixelBufferGetHeight(output) == 8)
    assert(CVPixelBufferGetPixelFormatType(output) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
    CVPixelBufferLockBaseAddress(output, .readOnly)
    let luma = CVPixelBufferGetBaseAddressOfPlane(output, 0)!.assumingMemoryBound(to: UInt8.self)
    let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(output, 0)
    assert(luma[0] == UInt8((16 * 3 + 16) & 0xff))
    assert(luma[7 * lumaStride + 31] == UInt8((23 * 3 + 47) & 0xff))
    let chroma = CVPixelBufferGetBaseAddressOfPlane(output, 1)!.assumingMemoryBound(to: UInt8.self)
    let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(output, 1)
    assert(chroma[0] == UInt8((8 * 3 + 16 + 100) & 0xff))
    assert(chroma[3 * chromaStride + 31] == UInt8((11 * 3 + 47 + 100) & 0xff))
    CVPixelBufferUnlockBaseAddress(output, .readOnly)
    // Frames still retained by AVKit must not make the next crop fall back.
    var retained = [output]
    for _ in 0..<6 { retained.append(cropper.crop(input, region: region)!) }
    assert(Set(retained.map { ObjectIdentifier($0) }).count == retained.count)
    // A changed zoom reallocates; unsupported formats leave the frame uncropped.
    let wider = cropper.crop(input, region: CGRect(x: 0, y: 0, width: 0.5, height: 0.5))!
    assert(CVPixelBufferGetWidth(wider) == 32 && CVPixelBufferGetHeight(wider) == 16)
    var rgb: CVPixelBuffer?
    CVPixelBufferCreate(nil, 64, 32, kCVPixelFormatType_32BGRA, attributes, &rgb)
    assert(cropper.crop(rgb!, region: region) == nil)
    print("PASS: picture in picture keeps the visible zoom region with exact NV12 samples")
  }
}
