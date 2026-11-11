import AppKit
import Foundation

private struct Command: Decodable {
    let type: String
    let token: Int64?
}

private func emit(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    FileHandle.standardOutput.write(Data(line.utf8))
}

/// A tiny, listen-only AppKit process used only while Cindy owns a task drag.
/// It never records positions or input contents; it reports one matching
/// left-button release and immediately removes both event monitors.
private final class DragReleaseListener {
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var armedToken: Int64?

    func arm(token: Int64) {
        disarm()
        armedToken = token
        let mask: NSEvent.EventTypeMask = [.leftMouseUp]
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] _ in
            self?.released()
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            self?.released()
            return event
        }
        if globalMonitor == nil && localMonitor == nil {
            armedToken = nil
            emit(["type": "unavailable", "token": token])
        }
    }

    func disarm() {
        if let monitor = globalMonitor {
            NSEvent.removeMonitor(monitor)
            globalMonitor = nil
        }
        if let monitor = localMonitor {
            NSEvent.removeMonitor(monitor)
            localMonitor = nil
        }
        armedToken = nil
    }

    private func released() {
        guard let token = armedToken else { return }
        disarm()
        emit(["type": "mouse-up", "token": token])
    }
}

private final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    private let listener = DragReleaseListener()
    private var inputBuffer = Data()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        beginReadingCommands()
        emit(["type": "ready"])
    }

    func applicationWillTerminate(_ notification: Notification) {
        FileHandle.standardInput.readabilityHandler = nil
        listener.disarm()
    }

    private func beginReadingCommands() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                DispatchQueue.main.async { NSApp.terminate(nil) }
                return
            }
            DispatchQueue.main.async { self?.consume(data) }
        }
    }

    private func consume(_ data: Data) {
        inputBuffer.append(data)
        while let newline = inputBuffer.firstIndex(of: 0x0A) {
            let line = inputBuffer.prefix(upTo: newline)
            inputBuffer.removeSubrange(...newline)
            guard !line.isEmpty,
                  let command = try? JSONDecoder().decode(Command.self, from: line) else { continue }
            switch command.type {
            case "arm":
                guard let token = command.token else { continue }
                listener.arm(token: token)
            case "disarm":
                listener.disarm()
            default:
                break
            }
        }
    }
}

private let application = NSApplication.shared
private let delegate = ApplicationDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.finishLaunching()
application.run()
