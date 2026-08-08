import ExpoModulesCore
import UIKit
import WebKit

private let onScreenshot = "onScreenshot"
private let conversationShareRenderTimeout: TimeInterval = 20
private let conversationShareMaxOutputPixels: CGFloat = 12_000_000

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
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: width, height: 1), configuration: configuration)
    webView.navigationDelegate = self
    webView.isOpaque = false
    webView.scrollView.isScrollEnabled = false
    self.webView = webView

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
        captureHeight > 0
      else {
        self.finish(.failure(ConversationShareRenderError("Conversation share dimensions are invalid.")))
        return
      }
      webView.frame = CGRect(x: 0, y: 0, width: captureWidth, height: captureHeight)
      webView.setNeedsLayout()
      webView.layoutIfNeeded()
      let requestedScale = max(0.25, self.scale)
      let maxScale = sqrt(
        conversationShareMaxOutputPixels / max(1, captureWidth * captureHeight)
      )
      let effectiveScale = min(requestedScale, maxScale)
      let snapshot = WKSnapshotConfiguration()
      snapshot.rect = CGRect(x: 0, y: 0, width: captureWidth, height: captureHeight)
      snapshot.snapshotWidth = NSNumber(value: Double(captureWidth * effectiveScale))
      snapshot.afterScreenUpdates = true
      webView.takeSnapshot(with: snapshot) { image, error in
        if let error {
          self.finish(.failure(error))
          return
        }
        guard let data = image?.pngData(), !data.isEmpty else {
          self.finish(.failure(ConversationShareRenderError("Conversation share PNG is empty.")))
          return
        }
        self.finish(.success(data.base64EncodedString()))
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
    webView = nil
    completion(result)
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
  if let number = value as? NSNumber {
    return CGFloat(number.doubleValue)
  }
  if let value = value as? Double {
    return CGFloat(value)
  }
  if let value = value as? Int {
    return CGFloat(value)
  }
  return nil
}
