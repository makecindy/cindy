import UIKit

/** Keeps the same UITextView, selection and undo stack when editing a long draft. */
final class ComposerExpandedController: UIViewController {
  weak var composer: CindyComposerView?
  private var constraints: [NSLayoutConstraint] = []
  init(composer: CindyComposerView) { self.composer = composer; super.init(nibName: nil, bundle: nil) }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
    guard let editor = composer?.editor else { return }
    editor.removeFromSuperview()
    editor.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(editor)
    constraints = [
      editor.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
      editor.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
      editor.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
      editor.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -12),
    ]
    NSLayoutConstraint.activate(constraints)
    editor.isScrollEnabled = true
  }
  override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); composer?.editor.becomeFirstResponder() }
  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    guard navigationController?.isBeingDismissed == true || navigationController?.presentingViewController == nil, let composer else { return }
    NSLayoutConstraint.deactivate(constraints)
    composer.editor.removeFromSuperview()
    composer.editor.translatesAutoresizingMaskIntoConstraints = true
    composer.addSubview(composer.editor)
    composer.expandedController = nil
    composer.setNeedsLayout()
    if composer.window != nil { composer.editor.becomeFirstResponder() }
  }
}

extension CindyComposerView {
  func expand() {
    guard expandedController == nil, window != nil else { return }
    var responder: UIResponder? = self
    while responder != nil, !(responder is UIViewController) { responder = responder?.next }
    guard let presenter = responder as? UIViewController, presenter.presentedViewController == nil else { return }
    let content = ComposerExpandedController(composer: self)
    let navigation = UINavigationController(rootViewController: content)
    navigation.overrideUserInterfaceStyle = overrideUserInterfaceStyle
    navigation.modalPresentationStyle = .pageSheet
    navigation.sheetPresentationController?.detents = [.large()]
    navigation.sheetPresentationController?.prefersGrabberVisible = true
    expandedController = navigation
    presenter.present(navigation, animated: true)
  }
}
