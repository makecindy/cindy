import CoreGraphics
import CoreVideo

/// Keeps picture in picture on the desktop region the viewer was browsing.
/// The inline layer draws the whole frame into the zoomed viewport rectangle;
/// the system projection receives only the part visible through the view.
enum RemoteDesktopPresentationCrop {
  /// Visible part of the frame in normalized top-left coordinates, or nil
  /// when the complete frame is on screen (fit, letterboxed or not yet laid out).
  static func visibleRegion(viewport: CGRect, bounds: CGRect) -> CGRect? {
    guard viewport.width > 0, viewport.height > 0, bounds.width > 0, bounds.height > 0,
          [viewport.minX, viewport.minY, viewport.width, viewport.height].allSatisfy({ $0.isFinite })
    else { return nil }
    let visible = viewport.intersection(bounds)
    guard !visible.isNull, visible.width > 0, visible.height > 0 else { return nil }
    let region = CGRect(x: (visible.minX - viewport.minX) / viewport.width,
                        y: (visible.minY - viewport.minY) / viewport.height,
                        width: visible.width / viewport.width,
                        height: visible.height / viewport.height)
    // Sub-point layout rounding at fit is not a zoom.
    guard region.width < 0.995 || region.height < 0.995 else { return nil }
    return region
  }

  /// Pixel rectangle aligned to 4:2:0 chroma samples, clamped to the frame.
  static func pixelRect(region: CGRect, width: Int, height: Int) -> CGRect? {
    guard width >= 2, height >= 2 else { return nil }
    func span(_ start: CGFloat, _ end: CGFloat, _ limit: Int) -> (Int, Int) {
      let lower = max(0, min(limit - 2, Int((start * CGFloat(limit)).rounded(.down)))) & ~1
      var upper = min(limit, Int((end * CGFloat(limit)).rounded(.up)))
      upper = max(lower + 2, upper + (upper - lower) % 2)
      if upper > limit { upper -= 2 }
      return (lower, upper - lower)
    }
    let (x, w) = span(region.minX, region.maxX, width)
    let (y, h) = span(region.minY, region.maxY, height)
    guard w >= 2, h >= 2 else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
  }
}

/// Copies the visible region of a decoded NV12 frame into a pooled buffer.
/// Plain row copies keep colors identical to the inline picture.
final class RemoteDesktopPresentationCropper {
  private var pool: CVPixelBufferPool?
  private var poolSize = CGSize.zero
  private var poolFormat: OSType = 0

  func reset() {
    pool = nil
    poolSize = .zero
    poolFormat = 0
  }

  func crop(_ source: CVPixelBuffer, region: CGRect) -> CVPixelBuffer? {
    let format = CVPixelBufferGetPixelFormatType(source)
    guard format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange ||
            format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
          CVPixelBufferGetPlaneCount(source) == 2,
          let rect = RemoteDesktopPresentationCrop.pixelRect(region: region,
            width: CVPixelBufferGetWidth(source), height: CVPixelBufferGetHeight(source))
    else { return nil }
    let x = Int(rect.minX), y = Int(rect.minY), width = Int(rect.width), height = Int(rect.height)
    if pool == nil || poolSize != rect.size || poolFormat != format {
      pool = nil
      poolSize = rect.size
      poolFormat = format
      let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: format,
        kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
      ]
      CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
    }
    guard let pool else { return nil }
    // No allocation threshold: AVKit may retain several projected frames, and a
    // refused buffer would fall back to the whole desktop for that frame. The
    // pool recycles buffers once AVKit releases them.
    var output: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &output) == kCVReturnSuccess,
          let output else { return nil }
    CVPixelBufferLockBaseAddress(source, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(source, .readOnly) }
    CVPixelBufferLockBaseAddress(output, [])
    defer { CVPixelBufferUnlockBaseAddress(output, []) }
    // Luma is one byte per pixel; interleaved chroma is two bytes per two
    // pixels on half the rows, so the same byte offset x selects its column.
    for (plane, rows, firstRow) in [(0, height, y), (1, height / 2, y / 2)] {
      guard let from = CVPixelBufferGetBaseAddressOfPlane(source, plane),
            let to = CVPixelBufferGetBaseAddressOfPlane(output, plane) else { return nil }
      let fromStride = CVPixelBufferGetBytesPerRowOfPlane(source, plane)
      let toStride = CVPixelBufferGetBytesPerRowOfPlane(output, plane)
      for row in 0..<rows {
        memcpy(to.advanced(by: row * toStride), from.advanced(by: (firstRow + row) * fromStride + x), width)
      }
    }
    CVBufferPropagateAttachments(source, output)
    return output
  }
}
