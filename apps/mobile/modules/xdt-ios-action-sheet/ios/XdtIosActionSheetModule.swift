import ExpoModulesCore
import UIKit

public class XdtIosActionSheetModule: Module {
  private var pendingPromise: Promise?
  /// 每次 present 递增。旧 Sheet 的延迟回调必须对不上代次,不能结算后来的请求。
  private var requestGeneration = 0
  private weak var currentSheet: CindyBottomActionSheetController?

  public func definition() -> ModuleDefinition {
    Name("XdtIosActionSheet")

    AsyncFunction("show") { (options: [String: Any], promise: Promise) in
      DispatchQueue.main.async {
        self.present(options: options, promise: promise)
      }
    }
  }

  private func present(options: [String: Any], promise: Promise) {
    requestGeneration += 1
    let generation = requestGeneration
    if let pendingPromise {
      pendingPromise.resolve(-1)
      self.pendingPromise = nil
    }
    if let currentSheet {
      currentSheet.onPick = nil
      if currentSheet.presentingViewController != nil || currentSheet.isBeingPresented {
        currentSheet.dismiss(animated: false)
      }
      self.currentSheet = nil
    }

    guard let labels = options["options"] as? [String], !labels.isEmpty else {
      promise.reject("ERR_ACTION_SHEET_OPTIONS", "Action sheet options are missing.")
      return
    }
    guard let presenter = presenterViewController() else {
      promise.reject("ERR_ACTION_SHEET_PRESENTER", "No view controller to present action sheet.")
      return
    }

    let cancelButtonIndex = intOption(options["cancelButtonIndex"]) ?? -1
    let sheet = CindyBottomActionSheetController(
      labels: labels,
      cancelButtonIndex: cancelButtonIndex,
      destructiveButtonIndex: intOption(options["destructiveButtonIndex"]),
      titleText: stringOption(options["title"]),
      messageText: stringOption(options["message"])
    )
    sheet.onPick = { [weak self] index in
      guard let self, self.requestGeneration == generation else { return }
      guard let current = self.pendingPromise else { return }
      self.pendingPromise = nil
      self.currentSheet = nil
      current.resolve(index)
    }

    if let style = options["userInterfaceStyle"] as? String {
      if style == "dark" {
        sheet.overrideUserInterfaceStyle = .dark
      } else if style == "light" {
        sheet.overrideUserInterfaceStyle = .light
      }
    }

    sheet.modalPresentationStyle = .pageSheet
    if let presentation = sheet.sheetPresentationController {
      presentation.detents = [.medium(), .large()]
      presentation.selectedDetentIdentifier = .medium
      presentation.prefersGrabberVisible = true
      presentation.prefersScrollingExpandsWhenScrolledToEdge = true
      presentation.prefersEdgeAttachedInCompactHeight = true
      presentation.widthFollowsPreferredContentSizeWhenEdgeAttached = true
    }

    pendingPromise = promise
    currentSheet = sheet
    presenter.present(sheet, animated: true)
  }

  private func presenterViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
    var controller = window?.rootViewController
    while let presented = controller?.presentedViewController, !presented.isBeingDismissed {
      controller = presented
    }
    return controller ?? appContext?.utilities?.currentViewController()
  }

  private func intOption(_ value: Any?) -> Int? {
    if let number = value as? NSNumber {
      return number.intValue
    }
    if let number = value as? Int {
      return number
    }
    if let number = value as? Double {
      return Int(number)
    }
    return nil
  }

  private func stringOption(_ value: Any?) -> String? {
    guard let text = value as? String else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

private final class CindyBottomActionSheetController: UIViewController, UITableViewDelegate, UITableViewDataSource, UIAdaptivePresentationControllerDelegate {
  var onPick: ((Int) -> Void)?

  private let labels: [String]
  private let cancelButtonIndex: Int
  private let destructiveButtonIndex: Int?
  private let titleText: String?
  private let messageText: String?
  private let tableView = UITableView(frame: .zero, style: .insetGrouped)
  private var picked = false

  private var actionIndices: [Int] {
    labels.indices.filter { $0 != cancelButtonIndex }
  }

  init(
    labels: [String],
    cancelButtonIndex: Int,
    destructiveButtonIndex: Int?,
    titleText: String?,
    messageText: String?
  ) {
    self.labels = labels
    self.cancelButtonIndex = cancelButtonIndex
    self.destructiveButtonIndex = destructiveButtonIndex
    self.titleText = titleText
    self.messageText = messageText
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    // iOS 26 的系统 Sheet 自带 Liquid Glass。不透明 grouped 底会把材质盖掉。
    view.isOpaque = false
    view.backgroundColor = .clear
    presentationController?.delegate = self
    tableView.translatesAutoresizingMaskIntoConstraints = false
    tableView.delegate = self
    tableView.dataSource = self
    tableView.isScrollEnabled = true
    tableView.isOpaque = false
    tableView.backgroundColor = .clear
    tableView.backgroundView = nil
    tableView.separatorInset = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
    view.addSubview(tableView)
    NSLayoutConstraint.activate([
      tableView.topAnchor.constraint(equalTo: view.topAnchor, constant: 12),
      tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      tableView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
    ])
  }

  func numberOfSections(in tableView: UITableView) -> Int {
    cancelButtonIndex >= 0 ? 2 : 1
  }

  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
    if section == 0 {
      return actionIndices.count
    }
    return 1
  }

  func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
    section == 0 ? titleText : nil
  }

  func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
    section == 0 ? messageText : nil
  }

  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "row")
      ?? UITableViewCell(style: .default, reuseIdentifier: "row")
    let index = indexPath.section == 0 ? actionIndices[indexPath.row] : cancelButtonIndex
    let label = labels[index]
    var config = cell.defaultContentConfiguration()
    config.text = label
    config.textProperties.alignment = .natural
    config.textProperties.font = .preferredFont(forTextStyle: .body)
    if index == destructiveButtonIndex {
      config.textProperties.color = .systemRed
    } else if index == cancelButtonIndex {
      config.textProperties.font = .preferredFont(forTextStyle: .headline)
      config.textProperties.color = .label
    } else {
      config.textProperties.color = .label
    }
    cell.contentConfiguration = config
    var background = UIBackgroundConfiguration.listGroupedCell()
    background.backgroundColor = .clear
    cell.backgroundConfiguration = background
    cell.selectionStyle = .default
    return cell
  }

  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    tableView.deselectRow(at: indexPath, animated: true)
    let index = indexPath.section == 0 ? actionIndices[indexPath.row] : cancelButtonIndex
    finish(index)
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish(cancelButtonIndex >= 0 ? cancelButtonIndex : -1, alreadyDismissed: true)
  }

  private func finish(_ index: Int, alreadyDismissed: Bool = false) {
    guard !picked else { return }
    picked = true
    if alreadyDismissed {
      onPick?(index)
      return
    }
    dismiss(animated: true) { [weak self] in
      self?.onPick?(index)
    }
  }
}
