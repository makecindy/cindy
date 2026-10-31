import AppKit
import AVFoundation
import CoreLocation
import Foundation

final class DesktopVideoWall {
  private var windows: [NSWindow] = []
  private var loopers: [AVPlayerLooper] = []
  private var players: [AVQueuePlayer] = []

  func play(path: String) throws {
    stop()
    let url = URL(fileURLWithPath: path)
    guard FileManager.default.fileExists(atPath: path) else {
      throw HelperError.missingFile
    }
    for screen in NSScreen.screens {
      let player = AVQueuePlayer()
      player.isMuted = true
      let item = AVPlayerItem(url: url)
      let looper = AVPlayerLooper(player: player, templateItem: item)
      let view = PlayerView(player: player)
      let window = NSWindow(
        contentRect: screen.frame,
        styleMask: .borderless,
        backing: .buffered,
        defer: false
      )
      window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
      window.isOpaque = true
      window.backgroundColor = .black
      window.hasShadow = false
      window.ignoresMouseEvents = true
      window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
      window.contentView = view
      window.setFrame(screen.frame, display: true)
      window.orderFrontRegardless()
      player.play()
      windows.append(window)
      players.append(player)
      loopers.append(looper)
    }
  }

  func stop() {
    for player in players { player.pause() }
    for window in windows { window.orderOut(nil) }
    windows.removeAll()
    players.removeAll()
    loopers.removeAll()
  }
}

final class PlayerView: NSView {
  private let playerLayer = AVPlayerLayer()

  init(player: AVPlayer) {
    super.init(frame: .zero)
    wantsLayer = true
    playerLayer.player = player
    playerLayer.videoGravity = .resizeAspectFill
    layer = playerLayer
  }

  required init?(coder: NSCoder) { return nil }

  override func layout() {
    super.layout()
    playerLayer.frame = bounds
  }
}

enum HelperError: Error {
  case missingFile
  case badJSON
}

final class Locator: NSObject, CLLocationManagerDelegate {
  private let manager = CLLocationManager()
  private var callback: (([String: Any]) -> Void)?
  private var geocoder = CLGeocoder()

  override init() {
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyKilometer
  }

  func locate(callback: @escaping ([String: Any]) -> Void) {
    self.callback = callback
    let status = manager.authorizationStatus
    if status == .denied || status == .restricted {
      finish(["ok": false, "error": "denied"])
      return
    }
    manager.requestWhenInUseAuthorization()
    manager.requestLocation()
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
      self?.finish(["ok": false, "error": "timeout"])
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last else {
      finish(["ok": false, "error": "unavailable"])
      return
    }
    geocoder.reverseGeocodeLocation(location) { [weak self] marks, _ in
      let mark = marks?.first
      let city = mark?.locality ?? mark?.administrativeArea
      if let city, !city.isEmpty {
        self?.finish(["ok": true, "city": city])
      } else {
        self?.finish(["ok": false, "error": "unavailable"])
      }
    }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    finish(["ok": false, "error": error.localizedDescription])
  }

  private func finish(_ payload: [String: Any]) {
    guard let callback else { return }
    self.callback = nil
    callback(payload)
  }
}

final class HelperApp: NSObject {
  let video = DesktopVideoWall()
  let locator = Locator()

  func handle(line: String) {
    guard let data = line.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = json["id"] as? String,
          let op = json["op"] as? String
    else { return }

    switch op {
    case "setWallpaper":
      let path = json["path"] as? String ?? ""
      reply(id: id, payload: setWallpaper(path: path))
    case "playVideo":
      let path = json["path"] as? String ?? ""
      do {
        try video.play(path: path)
        reply(id: id, payload: ["ok": true])
      } catch {
        reply(id: id, payload: ["ok": false, "error": "missing file"])
      }
    case "stopVideo":
      video.stop()
      reply(id: id, payload: ["ok": true])
    case "locate":
      locator.locate { payload in
        self.reply(id: id, payload: payload)
      }
    case "quit":
      reply(id: id, payload: ["ok": true])
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
        exit(0)
      }
    default:
      reply(id: id, payload: ["ok": false, "error": "unknown op"])
    }
  }

  private func setWallpaper(path: String) -> [String: Any] {
    let url = URL(fileURLWithPath: path)
    guard FileManager.default.fileExists(atPath: path) else {
      return ["ok": false, "error": "missing file"]
    }
    let options: [NSWorkspace.DesktopImageOptionKey: Any] = [
      .imageScaling: NSNumber(value: NSImageScaling.scaleProportionallyUpOrDown.rawValue),
      .allowClipping: true,
    ]
    do {
      for screen in NSScreen.screens {
        try NSWorkspace.shared.setDesktopImageURL(url, for: screen, options: options)
      }
      return ["ok": true]
    } catch {
      return ["ok": false, "error": error.localizedDescription]
    }
  }

  private func reply(id: String, payload: [String: Any]) {
    var body = payload
    body["id"] = id
    guard let data = try? JSONSerialization.data(withJSONObject: body, options: []),
          let line = String(data: data, encoding: .utf8)
    else { return }
    fputs(line + "\n", stdout)
    fflush(stdout)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let helper = HelperApp()
DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine(strippingNewline: true) {
    DispatchQueue.main.async {
      helper.handle(line: line)
    }
  }
  exit(0)
}
app.run()
