import UIKit
import UserNotifications
import UserNotificationsUI

/// The expanded view of a question alert: the task, the whole question however
/// long, and what each option means. The buttons under it are the system's own,
/// set here when the alert is opened, so nothing has to be registered ahead of
/// time; pressing one is forwarded to the app, which answers the computer in the
/// background. Each option's row and its button carry the same number, so the
/// explanation in the card and the button below read as one choice.
/// iPhone and iPad only: Apple Watch does not run this extension and shows the
/// alert's ordinary buttons.
final class NotificationViewController: UIViewController, UNNotificationContentExtension {
  static let optionPrefix = "option:"

  /// The app's neutral palette (apps/mobile/src/theme/tokens.ts): black and white, no accent.
  private enum Palette {
    static func pair(_ light: UInt32, _ dark: UInt32) -> UIColor {
      UIColor { traits in
        let value = traits.userInterfaceStyle == .dark ? dark : light
        return UIColor(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                       blue: CGFloat(value & 0xFF) / 255, alpha: 1)
      }
    }
    static let surface = pair(0xF9F9F6, 0x121212)
    static let border = pair(0xCCCCC8, 0x383838)
    static let textPrimary = pair(0x0F0F0F, 0xEDEDED)
    static let textSecondary = pair(0x4D4D4A, 0xBDBDBD)
    static let textTertiary = pair(0x686864, 0x999999)
  }

  /// The app's text roles (mobile-design-guide §3), scaled with the system text size.
  private enum Role {
    case kicker, question, option, note

    var font: UIFont {
      switch self {
      case .kicker: return UIFontMetrics(forTextStyle: .footnote).scaledFont(for: .systemFont(ofSize: 13, weight: .semibold))
      case .question: return UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17, weight: .regular))
      case .option: return UIFontMetrics(forTextStyle: .callout).scaledFont(for: .systemFont(ofSize: 16, weight: .medium))
      case .note: return UIFontMetrics(forTextStyle: .footnote).scaledFont(for: .systemFont(ofSize: 13, weight: .regular))
      }
    }
    /// Line height at the current text size: the role's ratio, never tighter than the font's own.
    var lineHeight: CGFloat {
      let (size, height): (CGFloat, CGFloat)
      switch self {
      case .kicker, .note: (size, height) = (13, 18)
      case .question: (size, height) = (17, 26)
      case .option: (size, height) = (16, 22)
      }
      let font = self.font
      return max(height * font.pointSize / size, font.lineHeight)
    }
    var color: UIColor {
      switch self {
      case .kicker: return Palette.textTertiary
      case .question, .option: return Palette.textPrimary
      case .note: return Palette.textSecondary
      }
    }
  }

  private static let inset = CGSize(width: 16, height: 14)
  private let stack = UIStackView()
  private let task = NotificationViewController.label(lines: 1)
  private let question = NotificationViewController.label()
  private let options = UIStackView()

  private static func label(lines: Int = 0) -> UILabel {
    let label = UILabel()
    label.numberOfLines = lines
    return label
  }

  /// Text in its role's font, colour and line height.
  private static func set(_ text: String, on label: UILabel, as role: Role) {
    let font = role.font
    let height = role.lineHeight
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = height
    paragraph.maximumLineHeight = height
    paragraph.lineBreakMode = label.numberOfLines == 1 ? .byTruncatingTail : .byWordWrapping
    label.attributedText = NSAttributedString(string: text, attributes: [
      .font: font, .foregroundColor: role.color, .paragraphStyle: paragraph,
      // Centre the glyphs in the taller line instead of leaving all the extra space above.
      .baselineOffset: (height - font.lineHeight) / 4,
    ])
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = Palette.surface
    options.axis = .vertical
    [task, question, options].forEach(stack.addArrangedSubview)
    stack.axis = .vertical
    stack.spacing = 4
    stack.setCustomSpacing(10, after: question)
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    // No bottom constraint: the system sizes this view from `preferredContentSize`, and a view
    // that is momentarily too short must not squeeze the text.
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: view.topAnchor, constant: Self.inset.height),
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Self.inset.width),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Self.inset.width),
    ])
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    fitContent()
  }

  /// Asks for exactly the height the text needs at the width the system gave.
  private func fitContent() {
    let width = view.bounds.width
    guard width > 0 else { return }
    let text = stack.systemLayoutSizeFitting(
      CGSize(width: width - 2 * Self.inset.width, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
    // The rows end on their own padding, so the bottom needs less than the top.
    let bottom = options.arrangedSubviews.isEmpty ? Self.inset.height : 4
    let height = ceil(text.height) + Self.inset.height + bottom
    if abs(preferredContentSize.height - height) > 0.5 || preferredContentSize.width != width {
      preferredContentSize = CGSize(width: width, height: height)
    }
  }

  func didReceive(_ notification: UNNotification) {
    let content = notification.request.content
    let action = content.userInfo["action"] as? [String: Any]
    let labels = (action?["options"] as? [String] ?? []).filter { !$0.isEmpty }
    let details = action?["details"] as? [String] ?? []
    Self.set(content.title, on: task, as: .kicker)
    task.isHidden = content.title.isEmpty
    // The alert text is shortened to fit a push and lists the options; the question travels beside it.
    let whole = (action?["question"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    Self.set(whole ?? Self.questionOnly(content.body, options: labels), on: question, as: .question)

    options.arrangedSubviews.forEach { $0.removeFromSuperview() }
    // The buttons below already name every option. The card repeats them only to say what they
    // mean; with nothing to add, the question stands alone.
    if details.contains(where: { !$0.isEmpty }) {
      for (index, label) in labels.enumerated() {
        options.addArrangedSubview(Self.separator())
        options.addArrangedSubview(Self.optionRow(number: index + 1, label: label,
                                                  detail: index < details.count ? details[index] : ""))
      }
    }

    let answers = labels.prefix(8).enumerated().map { index, label in
      UNNotificationAction(identifier: Self.optionPrefix + String(index), title: label, options: [],
                           icon: UNNotificationActionIcon(systemImageName: "\(index + 1).circle"))
    }
    // Keep the alert's own buttons ("Reply", "Open task", in the app's language) after the options.
    UNUserNotificationCenter.current().getNotificationCategories { [weak self] categories in
      let own = categories.first { $0.identifier == content.categoryIdentifier }?.actions ?? []
      DispatchQueue.main.async { self?.extensionContext?.notificationActions = answers + own.map(Self.withIcon) }
    }
    view.setNeedsLayout()
    view.layoutIfNeeded()
    fitContent()
  }

  func didReceive(_ response: UNNotificationResponse,
                  completionHandler completion: @escaping (UNNotificationContentExtensionResponseOption) -> Void) {
    completion(.dismissAndForwardAction)
  }

  /// The alert body is the question followed by "1. …" lines; the card shows those as rows or buttons.
  private static func questionOnly(_ body: String, options: [String]) -> String {
    var lines = body.components(separatedBy: "\n")
    for (index, label) in options.enumerated().reversed() where lines.last == "\(index + 1). \(label)" {
      lines.removeLast()
    }
    let text = lines.joined(separator: "\n")
    return text.isEmpty ? body : text
  }

  private static func withIcon(_ action: UNNotificationAction) -> UNNotificationAction {
    if let input = action as? UNTextInputNotificationAction {
      return UNTextInputNotificationAction(
        identifier: input.identifier, title: input.title, options: input.options,
        icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left"),
        textInputButtonTitle: input.textInputButtonTitle, textInputPlaceholder: input.textInputPlaceholder)
    }
    return UNNotificationAction(identifier: action.identifier, title: action.title, options: action.options,
                                icon: UNNotificationActionIcon(systemImageName: "arrow.up.forward.app"))
  }

  private static func separator() -> UIView {
    let line = UIView()
    line.backgroundColor = Palette.border
    line.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale).isActive = true
    return line
  }

  private static func optionRow(number: Int, label: String, detail: String) -> UIView {
    let badge = UIImageView(image: UIImage(systemName: "\(number).circle",
                                           withConfiguration: UIImage.SymbolConfiguration(font: Role.option.font)))
    badge.tintColor = Palette.textTertiary
    badge.setContentHuggingPriority(.required, for: .horizontal)
    badge.setContentCompressionResistancePriority(.required, for: .horizontal)
    badge.isAccessibilityElement = false

    let title = Self.label()
    Self.set(label, on: title, as: .option)
    let text = UIStackView(arrangedSubviews: [title])
    text.axis = .vertical
    text.spacing = 2
    if !detail.isEmpty {
      let note = Self.label()
      Self.set(detail, on: note, as: .note)
      text.addArrangedSubview(note)
    }
    let row = UIStackView(arrangedSubviews: [badge, text])
    row.axis = .horizontal
    // The symbol is drawn for the label's font, so sharing a baseline centres the number on the label.
    row.alignment = .firstBaseline
    row.spacing = 10
    row.isLayoutMarginsRelativeArrangement = true
    row.layoutMargins = UIEdgeInsets(top: 10, left: 0, bottom: 10, right: 0)
    row.isAccessibilityElement = true
    row.accessibilityLabel = detail.isEmpty ? "\(number). \(label)" : "\(number). \(label), \(detail)"
    return row
  }
}
