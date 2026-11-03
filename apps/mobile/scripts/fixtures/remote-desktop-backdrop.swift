import CoreImage

@main
struct BackdropTests {
  static func main() {
    let context = CIContext()
    func solid(_ color: CIColor, _ rect: CGRect) -> CIImage {
      CIImage(color: color).cropped(to: rect)
    }
    func render(_ source: CIImage, _ size: CGSize, _ fill: Bool = false) -> CGImage? {
      RemoteDesktopBackdrop.image(source: source, size: size, fillHeight: fill, context: context)
    }
    func pixel(_ image: CGImage, _ x: CGFloat, _ y: CGFloat) -> [UInt8] {
      var bytes = [UInt8](repeating: 0, count: 4)
      context.render(CIImage(cgImage: image), toBitmap: &bytes, rowBytes: 4,
        bounds: CGRect(x: x, y: y, width: 1, height: 1), format: .RGBA8,
        colorSpace: CGColorSpaceCreateDeviceRGB())
      return bytes
    }
    // Distinct edge colors prove the narrow source strips stretch across the
    // bars, stay the right way up, and remain opaque after the blur.
    let wide = solid(.green, CGRect(x: 0, y: 0, width: 1000, height: 500))
      .composited(over: CIImage.empty())
    let vertical = solid(.red, CGRect(x: 0, y: 0, width: 1000, height: 25))
      .composited(over: solid(.blue, CGRect(x: 0, y: 475, width: 1000, height: 25)))
      .composited(over: wide)
    let portrait = render(vertical, CGSize(width: 300, height: 500))!
    let bottom = pixel(portrait, 150, 20), top = pixel(portrait, 150, 480)
    assert(bottom[0] > 240 && bottom[2] < 15 && bottom[3] == 255)
    assert(top[2] > 240 && top[0] < 15 && top[3] == 255)
    let tall = solid(.green, CGRect(x: 0, y: 0, width: 500, height: 1000))
    let horizontal = solid(.red, CGRect(x: 0, y: 0, width: 25, height: 1000))
      .composited(over: solid(.blue, CGRect(x: 475, y: 0, width: 25, height: 1000)))
      .composited(over: tall)
    let landscape = render(horizontal, CGSize(width: 500, height: 300), true)!
    assert(pixel(landscape, 20, 150)[0] > 240)
    assert(pixel(landscape, 480, 150)[2] > 240)
    // Fill-height removes vertical bars; equal-aspect content needs no backdrop.
    assert(render(vertical, CGSize(width: 300, height: 500), true) == nil)
    assert(render(vertical, CGSize(width: 1000, height: 500)) == nil)
    assert(render(vertical, .zero) == nil)
    // A later frame replaces the image, rather than retaining the first JPEG.
    let changed = render(solid(.blue, vertical.extent), CGSize(width: 300, height: 500))!
    assert(pixel(changed, 150, 20)[2] > 240)
    let large = render(vertical, CGSize(width: 1200, height: 2400))!
    assert(max(large.width, large.height) <= 512)
    print("PASS: native backdrop edges, orientation, live frame replacement, fit and resolution")
  }
}
