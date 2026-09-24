import Foundation
import ObjectiveC

enum NativeHIDError: Error {
    case symbolsUnavailable
    case clientUnavailable
    case targetUnavailable
    case invalidGesture
    case messageUnavailable
    case deliveryFailed
    case deliveryTimedOut

    var publicMessage: String {
        switch self {
        case .symbolsUnavailable:
            return "Native HID symbols are unavailable."
        case .clientUnavailable:
            return "Native HID is unavailable for the exact simulator."
        case .targetUnavailable:
            return "Native HID screen target is unavailable."
        case .invalidGesture:
            return "Native HID gesture parameters are invalid."
        case .messageUnavailable:
            return "Native HID rejected a gesture sample."
        case .deliveryFailed:
            return "Native HID could not send a gesture sample."
        case .deliveryTimedOut:
            return "Native HID gesture delivery timed out."
        }
    }
}

/// Mirror SimulatorKit's screen-addressed digitizer routing, not a version
/// allowlist. Legacy SimulatorKit used the fixed main-display target 0x32.
/// Screen-based SimulatorKit uses 0x40000000 | screenID (or target 1 for
/// indirect displays). Missing modern metadata must not fall back to 0x32:
/// the legacy client can accept that message without delivering any touches.
func nativeHIDTarget(
    screenClass: AnyClass?,
    screen: AnyObject?,
    expectedScreenID: UInt32?
) throws -> UInt32 {
    let screenSelector = NSSelectorFromString("screen")
    guard let screenClass else { throw NativeHIDError.targetUnavailable }
    guard class_getInstanceMethod(screenClass, screenSelector) != nil else {
        return 0x32
    }
    let propertiesSelector = NSSelectorFromString("screenProperties")
    let idSelector = NSSelectorFromString("screenID")
    let typeSelector = NSSelectorFromString("screenType")
    guard let expectedScreenID,
          let screen = screen as? NSObject,
          let connected = screen.perform(screenSelector)?.takeUnretainedValue() as? NSObject,
          connected.responds(to: propertiesSelector),
          let properties = connected.perform(propertiesSelector)?.takeUnretainedValue() as? NSObject,
          properties.responds(to: idSelector),
          properties.responds(to: typeSelector) else {
        throw NativeHIDError.targetUnavailable
    }
    typealias ScreenIDGetter = @convention(c) (AnyObject, Selector) -> UInt32
    typealias ScreenTypeGetter = @convention(c) (AnyObject, Selector) -> UInt
    let getID = unsafeBitCast(properties.method(for: idSelector), to: ScreenIDGetter.self)
    let getType = unsafeBitCast(properties.method(for: typeSelector), to: ScreenTypeGetter.self)
    let screenID = getID(properties, idSelector)
    guard screenID == expectedScreenID, screenID < 0x40000000 else {
        throw NativeHIDError.targetUnavailable
    }
    let screenType = getType(properties, typeSelector)
    return screenType == 1 || screenType == 2 ? 1 : 0x40000000 | screenID
}

/// The framework completes asynchronously, even though the helper's wire
/// commands are synchronous. Keep the result alive after a bounded timeout,
/// and never leak framework NSError payloads into the Host protocol.
final class PendingHIDDelivery {
    private let condition = NSCondition()
    private var completed = false
    private var failed = false

    func complete(error: NSError?) {
        condition.lock()
        defer { condition.unlock() }
        guard !completed else { return }
        failed = error != nil
        completed = true
        condition.broadcast()
    }

    func wait(timeout: TimeInterval = 1) throws {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date(timeIntervalSinceNow: timeout)
        while !completed {
            guard condition.wait(until: deadline) || completed else {
                throw NativeHIDError.deliveryTimedOut
            }
        }
        if failed { throw NativeHIDError.deliveryFailed }
    }
}

/// Own construction through completion, including callers queued behind a
/// failed send. A timeout leaves delivery/contact state unknown, so only a new
/// helper may re-arm input; a late callback cannot make this sequence safe.
final class NativeHIDDeliverySequence {
    private let lock = NSLock()
    private var timedOut = false

    func send(
        timeout: TimeInterval = 1,
        enqueue: (PendingHIDDelivery) throws -> Void
    ) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !timedOut else { throw NativeHIDError.deliveryTimedOut }
        let pending = PendingHIDDelivery()
        try enqueue(pending)
        do {
            try pending.wait(timeout: timeout)
        } catch NativeHIDError.deliveryTimedOut {
            // Latch before releasing the lock, even if completion races timeout.
            timedOut = true
            throw NativeHIDError.deliveryTimedOut
        }
    }
}
