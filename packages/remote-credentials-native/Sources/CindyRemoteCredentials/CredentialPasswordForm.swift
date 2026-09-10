#if os(iOS)
import UIKit

private final class CredentialResourceAnchor: NSObject {}

struct CredentialLabels {
  private let values: [String: String]
  init(locale: String) throws {
    #if SWIFT_PACKAGE
    let bundle = Bundle.module
    #else
    let parent = Bundle(for: CredentialResourceAnchor.self)
    guard let url = parent.url(forResource: "CindyRemoteCredentialsResources", withExtension: "bundle"),
      let bundle = Bundle(url: url) else { throw CredentialError.unavailable }
    #endif
    guard let url = bundle.url(forResource: "credentials", withExtension: "json"),
      let catalog = try? JSONDecoder().decode([String: [String: String]].self, from: Data(contentsOf: url)),
      let values = catalog[locale] ?? catalog["en"] else { throw CredentialError.unavailable }
    self.values = values
  }
  subscript(_ key: String) -> String { values[key] ?? key }
}

/// Password entry never creates an RN/Expo field or a JavaScript string.
@MainActor
final class CredentialPasswordForm: UIViewController, UIAdaptivePresentationControllerDelegate, UITextFieldDelegate {
  private let labels: CredentialLabels
  private let account: String
  private let target: String
  private let completion: (Result<(Data, Bool), CredentialError>) -> Void
  private let password = UITextField()
  private let remember = UISwitch()
  private var finished = false
  private let saveRequired: Bool

  init(labels: CredentialLabels, account: String, target: String, saveRequired: Bool = false,
    completion: @escaping (Result<(Data, Bool), CredentialError>) -> Void) {
    self.labels = labels; self.account = account; self.target = target; self.completion = completion
    self.saveRequired = saveRequired
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .pageSheet
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    view.tintColor = .label
    let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false
    let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(scroll); scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
    ])
    func label(_ text: String, secondary: Bool = false) -> UILabel {
      let value = UILabel(); value.text = text; value.numberOfLines = 0
      value.font = .preferredFont(forTextStyle: .body); value.adjustsFontForContentSizeCategory = true
      value.textColor = secondary ? .secondaryLabel : .label
      return value
    }
    stack.addArrangedSubview(label(labels["title"]))
    stack.addArrangedSubview(label(account + "\n" + target, secondary: true))
    password.isSecureTextEntry = true; password.textContentType = .password
    password.autocorrectionType = .no; password.autocapitalizationType = .none
    password.placeholder = labels["password"]; password.accessibilityLabel = labels["password"]
    password.borderStyle = .roundedRect; password.returnKeyType = .done; password.delegate = self
    password.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    stack.addArrangedSubview(password)
    let row = UIStackView(arrangedSubviews: [label(labels["remember"]), remember]); row.spacing = 16
    remember.accessibilityLabel = labels["remember"]; remember.onTintColor = .label
    row.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    if !saveRequired { stack.addArrangedSubview(row) }
    stack.addArrangedSubview(label(labels["explanation"], secondary: true))
    for (text, action) in [(labels["verify"], #selector(submit)), (labels["cancel"], #selector(cancel))] {
      let button = UIButton(type: .system); button.setTitle(text, for: .normal)
      button.titleLabel?.font = .preferredFont(forTextStyle: .body)
      button.titleLabel?.adjustsFontForContentSizeCategory = true
      button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
      button.addTarget(self, action: action, for: .touchUpInside); stack.addArrangedSubview(button)
    }
    presentationController?.delegate = self
  }
  override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); password.becomeFirstResponder() }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { cancel() }
  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    guard textField.markedTextRange == nil else { return false }
    submit(); return true
  }
  @objc private func submit() {
    guard let text = password.text, !text.isEmpty, text.utf8.count <= 4096, password.markedTextRange == nil else { return }
    finish(.success((Data(text.utf8), remember.isOn)))
  }
  @objc func cancel() { finish(.failure(.cancelled)) }
  private func finish(_ result: Result<(Data, Bool), CredentialError>) {
    guard !finished else { return }; finished = true
    password.text = nil; password.resignFirstResponder()
    dismiss(animated: true)
    completion(result)
  }
}
#endif
