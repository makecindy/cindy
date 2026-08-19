import ExpoModulesCore
import UIKit
import WebKit

private let onScreenshot = "onScreenshot"
private let conversationShareRenderTimeout: TimeInterval = 20
private let conversationShareMaxOutputPixels: CGFloat = 12_000_000
private let conversationShareMaxSourcePixels: CGFloat = 12_000_000
private let conversationShareViewportHeight: CGFloat = 760

public class XdtScreenshotMonitorModule: Module {
  private var screenshotObserver: NSObjectProtocol?
  private var conversationShareRenderers: [UUID: ConversationShareHtmlRenderer] = [:]

  public func definition() -> ModuleDefinition {
    Name("XdtScreenshotMonitor")

    Events(onScreenshot)

    OnStartObserving(onScreenshot) {
      self.startObservingScreenshots()
    }

    OnStopObserving(onScreenshot) {
      self.stopObservingScreenshots()
    }

    AsyncFunction("renderConversationShareHtmlToPng") { (options: [String: Any], promise: Promise) in
      guard let html = options["html"] as? String, !html.isEmpty else {
        promise.reject("ERR_CONVERSATION_SHARE_HTML", "Conversation share HTML is missing.")
        return
      }
      let width = max(280, numericOption(options["width"]) ?? 390)
      let scale = max(0.25, numericOption(options["scale"]) ?? 2)
      DispatchQueue.main.async {
        let identifier = UUID()
        let renderer = ConversationShareHtmlRenderer(html: html, width: width, scale: scale) { [weak self] result in
          self?.conversationShareRenderers.removeValue(forKey: identifier)
          switch result {
          case .success(let base64):
            promise.resolve(base64)
          case .failure(let error):
            promise.reject("ERR_CONVERSATION_SHARE_RENDER", error.localizedDescription)
          }
        }
        self.conversationShareRenderers[identifier] = renderer
        renderer.start()
      }
    }

    OnDestroy {
      self.stopObservingScreenshots()
      let renderers = Array(self.conversationShareRenderers.values)
      self.conversationShareRenderers.removeAll()
      renderers.forEach { $0.cancel() }
    }
  }

  private func startObservingScreenshots() {
    guard screenshotObserver == nil else {
      return
    }
    screenshotObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.userDidTakeScreenshotNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.sendEvent(onScreenshot, [
        "capturedAt": Date().timeIntervalSince1970 * 1_000
      ])
    }
  }

  private func stopObservingScreenshots() {
    guard let screenshotObserver else {
      return
    }
    NotificationCenter.default.removeObserver(screenshotObserver)
    self.screenshotObserver = nil
  }
}

private final class ConversationShareHtmlRenderer: NSObject, WKNavigationDelegate {
  private let html: String
  private let width: CGFloat
  private let scale: CGFloat
  private let completion: (Result<String, Error>) -> Void
  private var completed = false
  private var timeoutWorkItem: DispatchWorkItem?
  private var webView: WKWebView?
  private var hostingWindow: UIWindow?

  init(
    html: String,
    width: CGFloat,
    scale: CGFloat,
    completion: @escaping (Result<String, Error>) -> Void
  ) {
    self.html = html
    self.width = width
    self.scale = scale
    self.completion = completion
  }

  func start() {
    guard let windowScene = UIApplication.shared.connectedScenes
      .compactMap({ $0 as? UIWindowScene })
      .first(where: { $0.activationState == .foregroundActive || $0.activationState == .foregroundInactive })
    else {
      finish(.failure(ConversationShareRenderError("Conversation share renderer has no active window scene.")))
      return
    }

    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let viewportHeight = min(conversationShareViewportHeight, max(1, width * 2))
    let webView = WKWebView(
      frame: CGRect(x: 0, y: 0, width: width, height: viewportHeight),
      configuration: configuration
    )
    webView.isOpaque = false
    webView.scrollView.isScrollEnabled = true
    webView.scrollView.showsVerticalScrollIndicator = false
    webView.scrollView.showsHorizontalScrollIndicator = false
    webView.backgroundColor = .clear

    // WKWebView 的离屏 snapshot 仍需要挂在可见的 UIKit window 层级中。
    // 不把它挂到业务页面，避免导出期间改变用户当前页面的布局或焦点。
    let hostingWindow = UIWindow(windowScene: windowScene)
    hostingWindow.frame = CGRect(x: 0, y: 0, width: width, height: viewportHeight)
    // 放到主窗口上方才能让 WebKit 进入可合成状态；极低透明度避免导出时闪屏。
    // takeSnapshot 直接读取 WKWebView 内容，不会继承 hostingWindow 的透明度。
    hostingWindow.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue + 1)
    hostingWindow.backgroundColor = .clear
    hostingWindow.alpha = 0.01
    hostingWindow.isUserInteractionEnabled = false
    let viewController = UIViewController()
    viewController.view.backgroundColor = .clear
    viewController.view.frame = hostingWindow.bounds
    webView.frame = viewController.view.bounds
    viewController.view.addSubview(webView)
    hostingWindow.rootViewController = viewController
    hostingWindow.isHidden = false

    webView.navigationDelegate = self
    self.webView = webView
    self.hostingWindow = hostingWindow

    let timeout = DispatchWorkItem { [weak self] in
      self?.finish(.failure(ConversationShareRenderError("Conversation share rendering timed out.")))
    }
    timeoutWorkItem = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + conversationShareRenderTimeout, execute: timeout)
    webView.loadHTMLString(html, baseURL: URL(string: "https://cindy-mobile.local"))
  }

  func cancel() {
    finish(.failure(ConversationShareRenderError("Conversation share rendering was cancelled.")))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    let script = """
      return (async function () {
        const stage = document.getElementById('xdt-content');
        if (!stage) throw new Error('stage-not-found');
        Array.from(stage.querySelectorAll('img')).forEach((image) => {
          const source = image.getAttribute('src') || '';
          if (!source.startsWith('data:')) image.replaceWith(document.createTextNode(image.getAttribute('alt') || ''));
        });
        await new Promise((resolve) => {
          const deadline = Date.now() + 14_000;
          const check = () => {
            if (window.__cindyConversationShareRichContentReady === true || Date.now() >= deadline) {
              resolve();
              return;
            }
            setTimeout(check, 25);
          };
          check();
        });
        await Promise.all(Array.from(document.images).map(async (image) => {
          if (!image.complete) {
            await new Promise((resolve) => {
              image.addEventListener('load', resolve, { once: true });
              image.addEventListener('error', resolve, { once: true });
            });
          }
          if (image.decode) {
            try { await image.decode(); } catch (_) {}
          }
        }));
        if (document.fonts && document.fonts.ready) {
          try { await document.fonts.ready; } catch (_) {}
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rect = stage.getBoundingClientRect();
        return {
          width: Math.max(stage.scrollWidth, Math.ceil(rect.width)),
          height: Math.max(stage.scrollHeight, Math.ceil(rect.height))
        };
      })();
    """
    webView.callAsyncJavaScript(
      script,
      arguments: [:],
      in: nil,
      in: .page
    ) { [weak self] result in
      guard let self else { return }
      guard case .success(let value) = result else {
        if case .failure(let error) = result {
          self.finish(.failure(error))
        }
        return
      }
      guard
        let dimensions = value as? [String: Any],
        let captureWidth = numericOption(dimensions["width"]),
        let captureHeight = numericOption(dimensions["height"]),
        captureWidth > 0,
        captureHeight > 0,
        captureWidth * captureHeight <= conversationShareMaxSourcePixels
      else {
        self.finish(.failure(ConversationShareRenderError("Conversation share content is too large.")))
        return
      }
      guard captureWidth <= webView.bounds.width + 1 else {
        self.finish(.failure(ConversationShareRenderError("Conversation share width changed unexpectedly.")))
        return
      }
      let viewportHeight = webView.bounds.height
      webView.setNeedsLayout()
      webView.layoutIfNeeded()
      self.hostingWindow?.rootViewController?.view.setNeedsLayout()
      self.hostingWindow?.rootViewController?.view.layoutIfNeeded()
      let requestedScale = max(0.25, self.scale)
      let maxScale = sqrt(
        conversationShareMaxOutputPixels / max(1, captureWidth * captureHeight)
      )
      let effectiveScale = min(requestedScale, maxScale)
      let snapshot = WKSnapshotConfiguration()
      snapshot.rect = webView.bounds
      snapshot.snapshotWidth = NSNumber(value: Double(captureWidth * effectiveScale))
      snapshot.afterScreenUpdates = true
      // 长页面不能用超出 WKWebView.bounds 的 rect 一次截图；按固定视口滚动分片，
      // 每片的 rect 始终位于 bounds 内，再在原生侧拼接成完整 PNG。
      CATransaction.flush()
      self.captureTiles(
        webView: webView,
        snapshot: snapshot,
        contentWidth: captureWidth,
        contentHeight: captureHeight,
        viewportHeight: viewportHeight,
        effectiveScale: effectiveScale
      ) { [weak self] result in
        guard let self else { return }
        switch result {
        case .success(let image):
          guard let data = image.pngData(), !data.isEmpty else {
            self.finish(.failure(ConversationShareRenderError("Conversation share PNG is empty.")))
            return
          }
          self.finish(.success(data.base64EncodedString()))
        case .failure(let error):
          self.finish(.failure(error))
        }
      }
    }
  }

  private func captureTiles(
    webView: WKWebView,
    snapshot: WKSnapshotConfiguration,
    contentWidth: CGFloat,
    contentHeight: CGFloat,
    viewportHeight: CGFloat,
    effectiveScale: CGFloat,
    completion: @escaping (Result<UIImage, Error>) -> Void
  ) {
    let outputSize = CGSize(
      width: contentWidth * effectiveScale,
      height: contentHeight * effectiveScale
    )
    guard outputSize.width > 0, outputSize.height > 0 else {
      completion(.failure(ConversationShareRenderError("Conversation share output is empty.")))
      return
    }
    let tileOffsets: [CGFloat] = {
      if contentHeight <= viewportHeight { return [0] }
      var offsets = stride(from: CGFloat(0), through: contentHeight - viewportHeight, by: viewportHeight).map { $0 }
      let lastOffset = contentHeight - viewportHeight
      if offsets.last != lastOffset { offsets.append(lastOffset) }
      return offsets
    }()
    captureTile(
      index: 0,
      offsets: tileOffsets,
      webView: webView,
      snapshot: snapshot,
      effectiveScale: effectiveScale,
      outputSize: outputSize,
      tiles: [],
      completion: completion
    )
  }

  private func captureTile(
    index: Int,
    offsets: [CGFloat],
    webView: WKWebView,
    snapshot: WKSnapshotConfiguration,
    effectiveScale: CGFloat,
    outputSize: CGSize,
    tiles: [(offset: CGFloat, image: UIImage)],
    completion: @escaping (Result<UIImage, Error>) -> Void
  ) {
    guard !completed else { return }
    guard !offsets.isEmpty else {
      completion(.failure(ConversationShareRenderError("Conversation share produced no tiles.")))
      return
    }
    guard index < offsets.count else {
      let format = UIGraphicsImageRendererFormat()
      // outputSize 已包含 effectiveScale；renderer 再采用屏幕 scale 会把像素数额外
      // 放大 4～9 倍，长图会在合成阶段超时或触发内存压力。
      format.scale = 1
      let renderer = UIGraphicsImageRenderer(size: outputSize, format: format)
      let merged = renderer.image { _ in
        for tile in tiles {
          tile.image.draw(in: CGRect(
            x: 0,
            y: tile.offset * effectiveScale,
            width: outputSize.width,
            height: snapshot.rect.height * effectiveScale
          ))
        }
      }
      guard merged.hasVisibleVariation else {
        completion(.failure(ConversationShareRenderError("Conversation share PNG is blank.")))
        return
      }
      completion(.success(merged))
      return
    }
    let offset = offsets[index]
    webView.scrollView.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
    waitForWebContentPaint(webView) { [weak self, weak webView] result in
      guard let self, let webView else { return }
      guard case .success = result else {
        if case .failure(let error) = result { completion(.failure(error)) }
        return
      }
      webView.takeSnapshot(with: snapshot) { [weak self] image, error in
        guard let self else { return }
        if let error {
          completion(.failure(error))
          return
        }
        guard let image else {
          completion(.failure(ConversationShareRenderError("Conversation share tile is empty.")))
          return
        }
        self.captureTile(
          index: index + 1,
          offsets: offsets,
          webView: webView,
          snapshot: snapshot,
          effectiveScale: effectiveScale,
          outputSize: outputSize,
          tiles: tiles + [(offset: offset, image: image)],
          completion: completion
        )
      }
    }
  }

  private func waitForWebContentPaint(
    _ webView: WKWebView,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    let script = """
      return await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    """
    webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
      switch result {
      case .success:
        completion(.success(()))
      case .failure(let error):
        completion(.failure(error))
      }
    }
  }

  func webView(
    _ webView: WKWebView,
    didFail navigation: WKNavigation!,
    withError error: Error
  ) {
    finish(.failure(error))
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    finish(.failure(error))
  }

  private func finish(_ result: Result<String, Error>) {
    guard !completed else { return }
    completed = true
    timeoutWorkItem?.cancel()
    timeoutWorkItem = nil
    webView?.stopLoading()
    webView?.navigationDelegate = nil
    webView?.removeFromSuperview()
    hostingWindow?.isHidden = true
    hostingWindow?.rootViewController = nil
    hostingWindow = nil
    webView = nil
    completion(result)
  }
}

private extension UIImage {
  var hasVisibleVariation: Bool {
    guard let cgImage else { return false }
    let sampleWidth = 64
    let sampleHeight = 64
    let bytesPerPixel = 4
    let bytesPerRow = sampleWidth * bytesPerPixel
    var pixels = [UInt8](repeating: 0, count: sampleHeight * bytesPerRow)
    guard let context = CGContext(
      data: &pixels,
      width: sampleWidth,
      height: sampleHeight,
      bitsPerComponent: 8,
      bytesPerRow: bytesPerRow,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
      return false
    }
    context.interpolationQuality = .low
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: sampleWidth, height: sampleHeight))

    var minimum = [Int](repeating: 255, count: 3)
    var maximum = [Int](repeating: 0, count: 3)
    var hasOpaquePixel = false
    for offset in stride(from: 0, to: pixels.count, by: bytesPerPixel) {
      guard pixels[offset + 3] > 8 else { continue }
      hasOpaquePixel = true
      for channel in 0..<3 {
        let value = Int(pixels[offset + channel])
        minimum[channel] = min(minimum[channel], value)
        maximum[channel] = max(maximum[channel], value)
      }
    }
    guard hasOpaquePixel else { return false }
    return zip(minimum, maximum).contains { lower, upper in
      upper - lower >= 4
    }
  }
}

private struct ConversationShareRenderError: LocalizedError {
  let message: String

  init(_ message: String) {
    self.message = message
  }

  var errorDescription: String? {
    message
  }
}

private func numericOption(_ value: Any?) -> CGFloat? {
  let numericValue: CGFloat
  if let number = value as? NSNumber {
    numericValue = CGFloat(number.doubleValue)
  } else if let value = value as? Double {
    numericValue = CGFloat(value)
  } else if let value = value as? Int {
    numericValue = CGFloat(value)
  } else {
    return nil
  }
  return numericValue.isFinite ? numericValue : nil
}
