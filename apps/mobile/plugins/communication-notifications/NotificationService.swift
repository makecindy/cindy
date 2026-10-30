import Intents
import UIKit
import UserNotifications

/// Native communication notifications for teammate replies and group messages.
/// No network or access to the app's account storage.
final class NotificationService: UNNotificationServiceExtension {
  private let completionLock = NSLock()
  private var handler: ((UNNotificationContent) -> Void)?
  private var original: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    completionLock.lock()
    handler = contentHandler
    original = request.content
    completionLock.unlock()

    let content = request.content
    let category = content.userInfo["category"] as? String
    let isChat = category == "chat-message"
    let isGroup = isChat && (content.userInfo["conversationKind"] as? String) != "direct"
    guard ["session-done", "session-error", "session-needs-reply"].contains(category ?? "") || isChat,
          let senderData = content.userInfo["sender"] as? [String: Any],
          let id = senderData["id"] as? String, !id.isEmpty, id.utf8.count <= 128,
          !content.title.isEmpty, !content.threadIdentifier.isEmpty else {
      finish(content)
      return
    }
    let senderName = isChat ? (content.userInfo["senderName"] as? String ?? "") : content.title
    guard !senderName.isEmpty else { finish(content); return }
    let prefix = senderName + ": "
    let message = isChat && content.body.hasPrefix(prefix) ? String(content.body.dropFirst(prefix.count)) : content.body
    let sender = INPerson(
      personHandle: INPersonHandle(value: id, type: .unknown),
      nameComponents: nil,
      displayName: senderName,
      image: Self.avatar(senderData["avatar"], name: senderName),
      contactIdentifier: nil,
      customIdentifier: id
    )
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: message,
      speakableGroupName: isGroup ? INSpeakableString(spokenPhrase: content.title) : nil,
      conversationIdentifier: content.threadIdentifier,
      serviceName: nil,
      sender: sender,
      attachments: nil
    )
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { [weak self] error in
      guard let self else { return }
      guard error == nil else { self.finish(content); return }
      do {
        self.finish(try content.updating(from: intent))
      } catch {
        self.finish(content)
      }
    }
  }

  override func serviceExtensionTimeWillExpire() {
    completionLock.lock()
    let fallback = original
    completionLock.unlock()
    if let fallback { finish(fallback) }
  }

  /// Donation can finish concurrently with expiry. Deliver exactly once in either case.
  private func finish(_ content: UNNotificationContent) {
    completionLock.lock()
    let callback = handler
    handler = nil
    original = nil
    completionLock.unlock()
    callback?(content)
  }

  static func avatar(_ input: Any?, name: String) -> INImage? {
    let avatar = input as? [String: String]
    let value = avatar?["value"] ?? ""
    if avatar?["kind"] == "jpeg", value.utf8.count <= 2048,
       let data = Data(base64Encoded: value),
       let image = UIImage(data: data), image.size.width <= 128, image.size.height <= 128 {
      return INImage(imageData: data)
    }
    if avatar?["kind"] == "preset", ["cindy", "dash", "lizi"].contains(value),
       let image = UIImage(named: "teammate-" + value), let data = image.pngData() {
      return INImage(imageData: data)
    }
    let symbol = avatar?["kind"] == "symbol" && value.count == 1 && value.utf16.count <= 32
      ? value : String(name.prefix(1)).uppercased()
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let image = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 80), format: format).image { context in
      UIColor.systemGray5.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 80, height: 80))
      let text = symbol as NSString
      let attributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: 44), .foregroundColor: UIColor.label,
      ]
      let size = text.size(withAttributes: attributes)
      text.draw(at: CGPoint(x: (80 - size.width) / 2, y: (80 - size.height) / 2), withAttributes: attributes)
    }
    return image.pngData().map { INImage(imageData: $0) }
  }
}
