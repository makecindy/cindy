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

func isSupportedGamepad(_ controller: GCController) -> Bool {
  controller.extendedGamepad != nil
}

func resolveGamepadFamily(from controller: GCController) -> String {
  if controller.extendedGamepad is GCXboxGamepad { return "xbox" }
  if controller.extendedGamepad is GCDualShockGamepad { return "playstation" }
  let vendor = controller.vendorName?.lowercased() ?? ""
  let category = controller.productCategory.lowercased()
  let haystack = vendor + " " + category
  if haystack.contains("dualsense")
    || haystack.contains("dualshock")
    || haystack.contains("playstation")
    || haystack.contains("sony")
    || haystack.range(of: #"\bps[45]\b"#, options: .regularExpression) != nil
  {
    return "playstation"
  }
  if haystack.contains("nintendo")
    || haystack.contains("switch")
    || haystack.contains("joy-con")
    || haystack.contains("joycon")
  {
    return "nintendo"
  }
  // Wired Xbox pads often advertise USB product "Controller" and vendor Microsoft.
  if haystack.contains("xbox")
    || haystack.contains("elite")
    || haystack.contains("microsoft")
    || vendor == "controller"
  {
    return "xbox"
  }
  return "generic"
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
func controllerTransport(for controller: GCController) -> String {
  let controllerTokens = transportMatchTokens(controller.vendorName, controller.productCategory)
  if controllerTokens.isEmpty { return "unknown" }

  let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
  let matching = [
    [kIOHIDVendorIDKey as String: 0x045E],
    [kIOHIDVendorIDKey as String: 0x054C],
    [kIOHIDVendorIDKey as String: 0x057E],
  ] as CFArray
  IOHIDManagerSetDeviceMatchingMultiple(manager, matching)
  IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
  defer { IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone)) }
  guard let devices = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice> else { return "unknown" }

  var matched = Set<String>()
  for device in devices {
    let deviceTokens = transportMatchTokens(
      IOHIDDeviceGetProperty(device, kIOHIDProductKey as CFString) as? String,
      IOHIDDeviceGetProperty(device, kIOHIDManufacturerKey as CFString) as? String
    )
    guard deviceTokens.contains(where: { controllerTokens.contains($0) }) else { continue }
    if let transport = hidTransportName(device) {
      matched.insert(transport)
    }
  }
  if matched.count == 1 { return matched.first! }
  return "unknown"
}

func transportMatchTokens(_ values: String?...) -> Set<String> {
  var tokens = Set<String>()
  for value in values {
    let lowered = (value ?? "").lowercased()
    for part in lowered.split(whereSeparator: { !$0.isLetter && !$0.isNumber }) {
      let token = String(part)
      if token.count >= 3 { tokens.insert(token) }
    }
  }
  // Generic Microsoft HID tokens would match keyboards, mice, and dongles.
  tokens.subtract([
    "usb", "hid", "device", "microsoft", "sony", "nintendo", "controller",
    "interactive", "entertainment",
  ])
  return tokens
}

func hidTransportName(_ device: IOHIDDevice) -> String? {
  let transport = (IOHIDDeviceGetProperty(device, kIOHIDTransportKey as CFString) as? String ?? "")
    .lowercased()
  if transport.contains("usb") { return "usb" }
  if transport.contains("blue") || transport.contains("wireless") { return "bluetooth" }
  return nil
}

func presencePayload(from controller: GCController) -> [String: Any] {
  var payload: [String: Any] = [
    "kind": "presence",
    "present": true,
    "name": controller.vendorName ?? controller.productCategory,
    "category": controller.productCategory,
    "family": resolveGamepadFamily(from: controller),
    "transport": controllerTransport(for: controller),
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

let GAMEPAD_FAMILIES = ["xbox", "playstation", "nintendo", "generic"]

final class XboxGamepadReporter {
  private var observed: [String: GCController] = [:]
  /// nil until the first refresh, so an empty device list still gets logged once.
  private var lastSeenSummary: String?
  private var lastPresenceSignature: [String: String] = [:]
  private var switch2UsbWanted = false

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
    Timer.scheduledTimer(withTimeInterval: 0.008, repeats: true) { [weak self] _ in
      self?.refreshSwitch2IfNeeded()
    }
    refresh()
  }

  func setSwitch2UsbWanted(_ wanted: Bool) {
    if switch2UsbWanted == wanted { return }
    switch2UsbWanted = wanted
    if wanted {
      _ = switch2_usb_ensure()
      refreshSwitch2IfNeeded()
      return
    }
    switch2_usb_shutdown()
    if observed["nintendo"] == nil, lastPresenceSignature["nintendo"] != "absent" {
      lastPresenceSignature["nintendo"] = "absent"
      emit(["kind": "presence", "present": false, "family": "nintendo"])
    }
  }

  func refresh() {
    let all = GCController.controllers()
    let summary = all
      .map { controller in
        let vendor = controller.vendorName ?? "?"
        let category = controller.productCategory
        let family = resolveGamepadFamily(from: controller)
        return "\(vendor)/\(category)/family=\(family)"
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

    var next: [String: GCController] = [:]
    for controller in all where isSupportedGamepad(controller) {
      let family = resolveGamepadFamily(from: controller)
      if next[family] == nil { next[family] = controller }
    }

    for family in GAMEPAD_FAMILIES {
      guard let controller = next[family] else {
        if family == "nintendo" {
          observed[family] = nil
          if switch2UsbWanted {
            continue
          }
        }
        if observed[family] != nil || lastPresenceSignature[family] != "absent" {
          observed[family] = nil
          lastPresenceSignature[family] = "absent"
          emit(["kind": "presence", "present": false, "family": family])
        }
        continue
      }
      if observed[family] !== controller {
        observed[family] = controller
        attach(controller)
      }
      emitPresence(from: controller, family: family)
      emitFrame(from: controller, family: family)
    }
    if next["nintendo"] == nil {
      refreshSwitch2IfNeeded()
    }
  }

  private func refreshSwitch2IfNeeded() {
    if !switch2UsbWanted { return }
    if observed["nintendo"] != nil { return }
    var state = Switch2UsbState()
    switch2_usb_copy_state(&state)
    if !state.present {
      if lastPresenceSignature["nintendo"] != "absent" {
        lastPresenceSignature["nintendo"] = "absent"
        emit(["kind": "presence", "present": false, "family": "nintendo"])
      }
      return
    }
    emitSwitch2(state)
  }

  private func emitSwitch2(_ state: Switch2UsbState) {
    let payload: [String: Any] = [
      "kind": "presence",
      "present": true,
      "name": "Pro Controller",
      "category": "Nintendo Switch 2",
      "family": "nintendo",
      "transport": "usb",
      "batteryState": "unknown",
    ]
    let signature = "switch2-usb:Pro Controller"
    if signature != lastPresenceSignature["nintendo"] {
      lastPresenceSignature["nintendo"] = signature
      emit(payload)
      emit([
        "kind": "log",
        "level": "info",
        "message": "controllers: Nintendo/Pro Controller/family=nintendo (switch2-usb)",
      ])
    }
    emit([
      "kind": "frame",
      "family": "nintendo",
      "buttons": [
        "a": state.a,
        "b": state.b,
        "x": state.x,
        "y": state.y,
        "lb": state.lb,
        "rb": state.rb,
        "lt": state.lt,
        "rt": state.rt,
        "view": state.view,
        "menu": state.menu,
        "xbox": state.xbox,
        "ls": state.ls,
        "rs": state.rs,
        "dpadUp": state.dpad_up,
        "dpadDown": state.dpad_down,
        "dpadLeft": state.dpad_left,
        "dpadRight": state.dpad_right,
      ],
      "axes": [
        "lx": state.lx,
        "ly": state.ly,
        "rx": state.rx,
        "ry": state.ry,
      ],
      "ltAnalog": state.lt ? 1.0 : 0.0,
      "rtAnalog": state.rt ? 1.0 : 0.0,
    ])
  }

  private func attach(_ controller: GCController) {
    guard let pad = controller.extendedGamepad else { return }
    pad.valueChangedHandler = { [weak self] _, _ in
      let family = resolveGamepadFamily(from: controller)
      self?.emitFrame(from: controller, family: family)
    }
  }

  private func emitPresence(from controller: GCController, family: String) {
    var payload = presencePayload(from: controller)
    payload["family"] = family
    let signature = String(describing: payload)
    if signature == lastPresenceSignature[family] { return }
    lastPresenceSignature[family] = signature
    emit(payload)
  }

  private func emitFrame(from controller: GCController, family: String) {
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
      "family": family,
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
    if trimmed == "switch2-usb on" {
      DispatchQueue.main.async {
        reporter.setSwitch2UsbWanted(true)
      }
    }
    if trimmed == "switch2-usb off" {
      DispatchQueue.main.async {
        reporter.setSwitch2UsbWanted(false)
      }
    }
  }
  exit(0)
}

RunLoop.main.run()
