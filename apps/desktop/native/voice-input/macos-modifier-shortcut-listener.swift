import ApplicationServices
import Foundation

func emitJson(_ payload: [String: Any]) {
  do {
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    if let line = String(data: data, encoding: .utf8) {
      print(line)
      fflush(stdout)
    }
  } catch {
    fputs("{\"type\":\"error\",\"message\":\"Could not encode listener event.\"}\n", stderr)
    fflush(stderr)
  }
}

func preflightListenEventAccess() -> Bool {
  if #available(macOS 10.15, *) {
    return CGPreflightListenEventAccess()
  }
  return true
}

func requestListenEventAccess() -> Bool {
  if #available(macOS 10.15, *) {
    return CGRequestListenEventAccess()
  }
  return true
}

if CommandLine.arguments.contains("--preflight-listen-event-access") {
  let granted = preflightListenEventAccess()
  emitJson(["type": "permission", "permission": "input-monitoring", "granted": granted])
  exit(0)
}

if CommandLine.arguments.contains("--request-listen-event-access") {
  let granted = requestListenEventAccess()
  emitJson(["type": "permission", "permission": "input-monitoring", "granted": granted])
  exit(0)
}

let keyCodeNames: [Int64: String] = [
  55: "MetaLeft",
  54: "MetaRight",
  58: "AltLeft",
  61: "AltRight",
  59: "ControlLeft",
  62: "ControlRight",
  56: "ShiftLeft",
  60: "ShiftRight",
  63: "Fn",
]

let modifierGroups: [String: CGEventFlags] = [
  "MetaLeft": .maskCommand,
  "MetaRight": .maskCommand,
  "AltLeft": .maskAlternate,
  "AltRight": .maskAlternate,
  "ControlLeft": .maskControl,
  "ControlRight": .maskControl,
  "ShiftLeft": .maskShift,
  "ShiftRight": .maskShift,
  "Fn": .maskSecondaryFn,
]

let modifierGroupMembers: [UInt64: Set<String>] = [
  CGEventFlags.maskCommand.rawValue: ["MetaLeft", "MetaRight"],
  CGEventFlags.maskAlternate.rawValue: ["AltLeft", "AltRight"],
  CGEventFlags.maskControl.rawValue: ["ControlLeft", "ControlRight"],
  CGEventFlags.maskShift.rawValue: ["ShiftLeft", "ShiftRight"],
  CGEventFlags.maskSecondaryFn.rawValue: ["Fn"],
]

enum ListenerState {
  static var pressedKeys = Set<String>()
  static var lastEmittedKeys: [String] = []

  // Keep this helper intentionally dumb: it emits snapshots of keys currently
  // held down. Tap/hold timing and voice-input business state stay in the
  // TypeScript layer where they are easier to test and evolve.
  static func emit(_ payload: [String: Any]) {
    emitJson(payload)
  }

  static func emitKeysIfChanged() {
    let keys = pressedKeys.sorted()
    if keys == lastEmittedKeys {
      return
    }
    lastEmittedKeys = keys
    emit(["type": "keys", "keys": keys])
  }

  static func handleModifierChanged(keyName: String, flags: CGEventFlags) {
    guard let group = modifierGroups[keyName] else {
      return
    }
    if flags.contains(group) {
      // CGEventFlags only exposes aggregate modifier groups. When both left
      // and right keys in the same group are held, releasing one side still
      // leaves the group flag enabled. Use the changed key plus our snapshot
      // to keep side-specific state correct.
      let groupPeers = modifierGroupMembers[group.rawValue] ?? []
      let anotherPeerIsDown = groupPeers.contains { $0 != keyName && pressedKeys.contains($0) }
      if pressedKeys.contains(keyName) && anotherPeerIsDown {
        pressedKeys.remove(keyName)
      } else {
        pressedKeys.insert(keyName)
      }
    } else {
      pressedKeys.remove(keyName)
    }
    emitKeysIfChanged()
  }

  static func handleNonModifierKey(keyCode: Int64, down: Bool) {
    let name = "KeyCode:\(keyCode)"
    if down {
      pressedKeys.insert(name)
    } else {
      pressedKeys.remove(name)
    }
    emitKeysIfChanged()
  }

  static func eventTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
  ) -> Unmanaged<CGEvent>? {
    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    if type == .flagsChanged {
      if let keyName = keyCodeNames[keyCode] {
        handleModifierChanged(keyName: keyName, flags: event.flags)
      }
    } else if type == .keyDown || type == .keyUp {
      if keyCodeNames[keyCode] == nil {
        handleNonModifierKey(keyCode: keyCode, down: type == .keyDown)
      }
    }
    return Unmanaged.passUnretained(event)
  }
}

let eventMask =
  (1 << CGEventType.flagsChanged.rawValue) |
  (1 << CGEventType.keyDown.rawValue) |
  (1 << CGEventType.keyUp.rawValue)

guard let eventTap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: CGEventMask(eventMask),
  callback: { proxy, type, event, refcon in
    ListenerState.eventTapCallback(proxy: proxy, type: type, event: event, refcon: refcon)
  },
  userInfo: nil
) else {
  ListenerState.emit([
    "type": "error",
    // 这条 message 只进日志：用户可见的引导由 renderer 按 errorCode 出 i18n 文案。
    "message": "Could not listen for modifier shortcuts. Enable Input Monitoring for Cindy.",
  ])
  exit(3)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: eventTap, enable: true)
ListenerState.emit(["type": "ready"])
CFRunLoopRun()
