import CoreImage

/// Mirrors the browser viewer's 5% / 90% / 5% ambient canvas, independent of pan/zoom.
enum RemoteDesktopBackdrop {
  static func image(source: CIImage, size: CGSize, fillHeight: Bool, context: CIContext) -> CGImage? {
    guard size.width > 0, size.height > 0, source.extent.width > 0, source.extent.height > 0 else { return nil }
    let sw = source.extent.width, sh = source.extent.height
    let vw = size.width, vh = size.height
    let scale = fillHeight ? vh / sh : min(vw / sw, vh / sh)
    let w = sw * scale, h = sh * scale
    let horizontal = w < vw - 0.01
    guard horizontal || h < vh - 0.01 else {
      return nil
    }
    let center = (horizontal ? w : h) * 0.9
    let side = ((horizontal ? vw : vh) - center) / 2
    let cuts: [CGFloat] = [0, 0.05, 0.95, 1]
    let starts: [CGFloat] = [0, side, side + center]
    let lengths: [CGFloat] = [side, center, side]
    let resolution = min(1, 512 / max(vw, vh))
    var composite = CIImage.empty()
    for index in 0..<3 {
      let src = horizontal
        ? CGRect(x: sw * cuts[index], y: 0, width: sw * (cuts[index + 1] - cuts[index]), height: sh)
        : CGRect(x: 0, y: sh * cuts[index], width: sw, height: sh * (cuts[index + 1] - cuts[index]))
      let dst = horizontal
        ? CGRect(x: starts[index], y: (vh - h) / 2, width: lengths[index], height: h)
        : CGRect(x: (vw - w) / 2, y: starts[index], width: w, height: lengths[index])
      let transform = CGAffineTransform(a: dst.width / src.width * resolution, b: 0,
        c: 0, d: dst.height / src.height * resolution,
        tx: (dst.minX - src.minX * dst.width / src.width) * resolution,
        ty: (dst.minY - src.minY * dst.height / src.height) * resolution)
      // Clamp before stretching: transparent pixels outside a 5% strip would
      // otherwise become a visible faded border after magnification and blur.
      let target = dst.applying(CGAffineTransform(scaleX: resolution, y: resolution))
      composite = source.cropped(to: src).clampedToExtent().transformed(by: transform)
        .cropped(to: target).composited(over: composite)
    }
    let extent = CGRect(x: 0, y: 0, width: vw * resolution, height: vh * resolution)
    let blurred = composite.cropped(to: extent).clampedToExtent()
      .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: 16 * resolution])
    return context.createCGImage(blurred, from: extent)
  }
}
