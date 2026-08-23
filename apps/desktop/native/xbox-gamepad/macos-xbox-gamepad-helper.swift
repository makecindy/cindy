import Foundation
import GameController
import IOKit.hid

struct Options {
  var command = "listen"
}

func parseOptions() -> Options {
  var options = Options()
  var iterator = CommandLine.arguments.dropFirst().makeIterator()
  while let arg = iterator.next() {
    if arg == "--command", let value = iterator.next() {
      options.command = value
    }
  }
  return options
}

func emit(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8) else { return }
  fputs(text + "\n", stdout)
  fflush(stdout)
}

func isXboxController(_ controller: GCController) -> Bool {
  if controller.extendedGamepad is GCXboxGamepad { return true }
  let vendor = controller.vendorName?.lowercased() ?? ""
  let category = controller.productCategory.lowercased()
  let haystack = vendor + " " + category
  // Wired Xbox pads often advertise USB product "Controller" and vendor Microsoft.
  return haystack.contains("xbox")
    || haystack.contains("microsoft")
    || vendor == "controller"
}

func homePressed(_ controller: GCController) -> Bool {
  controller.physicalInputProfile.buttons[GCInputButtonHome]?.isPressed ?? false
}

func batteryStateName(_ state: GCDeviceBattery.State) -> String {
  switch state {
  case .charging: return "charging"
  case .full: return "full"
  case .discharging: return "discharging"
  default: return "unknown"
  }
}

/// Best-effort USB vs Bluetooth from IOHID. GameController does not expose transport.
func microsoftControllerTransport() -> String {
  let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
  IOHIDManagerSetDeviceMatching(manager, [kIOHIDVendorIDKey as String: 0x45e] as CFDictionary)
  IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
  defer { IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone)) }
  guard let devices = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice> else { return "unknown" }
  var sawUsb = false
  var sawBluetooth = false
  for device in devices {
    let transport = (IOHIDDeviceGetProperty(device, kIOHIDTransportKey as CFString) as? String ?? "")
      .lowercased()
    if transport.contains("usb") { sawUsb = true }
    if transport.contains("blue") || transport.contains("wireless") { sawBluetooth = true }
  }
  if sawUsb { return "usb" }
  if sawBluetooth { return "bluetooth" }
  return "unknown"
}

func presencePayload(from controller: GCController) -> [String: Any] {
  var payload: [String: Any] = [
    "kind": "presence",
    "present": true,
    "name": controller.vendorName ?? controller.productCategory,
    "category": controller.productCategory,
    "transport": microsoftControllerTransport(),
    "batteryState": "unknown",
  ]
  if let battery = controller.battery {
    payload["batteryState"] = batteryStateName(battery.batteryState)
    let level = battery.batteryLevel
    if level >= 0 && level <= 1 {
      payload["batteryPercentage"] = Int((Double(level) * 100).rounded())
    }
  }
  return payload
}

final class XboxGamepadReporter {
  private var observed: GCController?
  /// nil until the first refresh, so an empty device list still gets logged once.
  private var lastSeenSummary: String?
  private var lastPresenceSignature = ""

  func start() {
    if #available(macOS 11.3, *) {
      GCController.shouldMonitorBackgroundEvents = true
    }
    NotificationCenter.default.addObserver(
      forName: .GCControllerDidConnect,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.refresh()
    }
    NotificationCenter.default.addObserver(
      forName: .GCControllerDidDisconnect,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.refresh()
    }
    refresh()
  }

  func refresh() {
    let all = GCController.controllers()
    let summary = all
      .map { controller in
        let vendor = controller.vendorName ?? "?"
        let category = controller.productCategory
        let xboxPad = controller.extendedGamepad is GCXboxGamepad
        return "\(vendor)/\(category)/xboxPad=\(xboxPad)"
      }
      .joined(separator: "; ")
    if summary != lastSeenSummary {
      lastSeenSummary = summary
      emit([
        "kind": "log",
        "level": "info",
        "message": summary.isEmpty ? "no GameController devices" : "controllers: \(summary)",
      ])
    }
    let next = all.first(where: isXboxController)
    if next == nil {
      observed = nil
      lastPresenceSignature = ""
      emit(["kind": "presence", "present": false])
      return
    }
    if observed !== next {
      observed = next
      attach(next!)
    }
    emitPresence(from: next!)
    emitFrame(from: next!)
  }

  private func attach(_ controller: GCController) {
    guard let pad = controller.extendedGamepad else { return }
    pad.valueChangedHandler = { [weak self] _, _ in
      self?.emitFrame(from: controller)
    }
  }

  private func emitPresence(from controller: GCController) {
    let payload = presencePayload(from: controller)
    let signature = String(describing: payload)
    if signature == lastPresenceSignature { return }
    lastPresenceSignature = signature
    emit(payload)
  }

  private func emitFrame(from controller: GCController) {
    guard let pad = controller.extendedGamepad else { return }
    let buttons: [String: Any] = [
      "a": pad.buttonA.isPressed,
      "b": pad.buttonB.isPressed,
      "x": pad.buttonX.isPressed,
      "y": pad.buttonY.isPressed,
      "lb": pad.leftShoulder.isPressed,
      "rb": pad.rightShoulder.isPressed,
      "lt": pad.leftTrigger.isPressed,
      "rt": pad.rightTrigger.isPressed,
      "view": pad.buttonOptions?.isPressed ?? false,
      "menu": pad.buttonMenu.isPressed,
      "xbox": homePressed(controller),
      "ls": pad.leftThumbstickButton?.isPressed ?? false,
      "rs": pad.rightThumbstickButton?.isPressed ?? false,
      "dpadUp": pad.dpad.up.isPressed,
      "dpadDown": pad.dpad.down.isPressed,
      "dpadLeft": pad.dpad.left.isPressed,
      "dpadRight": pad.dpad.right.isPressed,
    ]
    let axes: [String: Any] = [
      "lx": Double(pad.leftThumbstick.xAxis.value),
      "ly": Double(pad.leftThumbstick.yAxis.value),
      "rx": Double(pad.rightThumbstick.xAxis.value),
      "ry": Double(pad.rightThumbstick.yAxis.value),
    ]
    emit([
      "kind": "frame",
      "buttons": buttons,
      "axes": axes,
      "ltAnalog": Double(pad.leftTrigger.value),
      "rtAnalog": Double(pad.rightTrigger.value),
    ])
  }
}

let reporter = XboxGamepadReporter()
reporter.start()

DispatchQueue.global(qos: .utility).async {
  while let line = readLine() {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed == "stop" {
      exit(0)
    }
    if trimmed == "probe" {
      DispatchQueue.main.async {
        reporter.refresh()
      }
    }
  }
  exit(0)
}

RunLoop.main.run()
