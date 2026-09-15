import ExpoModulesCore
import UIKit

public class CindyComposerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CindyComposer")
    Constant("available") { true }
    View(CindyComposerView.self) {
      Events("onDocumentChange", "onSelectionChange", "onFocusChange", "onContentHeight", "onPasteText", "onPasteImages")
      Prop("document") { (view: CindyComposerView, value: [String: Any]) in view.apply(value) }
      Prop("colorScheme") { (view: CindyComposerView, value: String) in
        view.overrideUserInterfaceStyle = value == "dark" ? .dark : .light
        view.editor.keyboardAppearance = value == "dark" ? .dark : .light
      }
      AsyncFunction("expand") { (view: CindyComposerView) in view.expand() }
      Prop("placeholder") { (view: CindyComposerView, value: String) in view.placeholder.text = value }
      Prop("editable") { (view: CindyComposerView, value: Bool) in view.editor.isEditable = value }
      Prop("textColor") { (view: CindyComposerView, value: UIColor) in view.foreground = value; view.updateStyle() }
      Prop("caretColor") { (view: CindyComposerView, value: UIColor) in view.editor.tintColor = value }
      Prop("placeholderColor") { (view: CindyComposerView, value: UIColor) in view.placeholder.textColor = value }
      Prop("chipColor") { (view: CindyComposerView, value: UIColor) in view.chipColor = value; view.updateStyle() }
      Prop("inputLabel") { (view: CindyComposerView, value: String) in view.editor.accessibilityLabel = value }
      Prop("inputHint") { (view: CindyComposerView, value: String) in view.editor.accessibilityHint = value }
      Prop("inputID") { (view: CindyComposerView, value: String) in view.editor.accessibilityIdentifier = value }
      AsyncFunction("focus") { (view: CindyComposerView) in view.editor.becomeFirstResponder() }
      AsyncFunction("blur") { (view: CindyComposerView) in view.editor.resignFirstResponder() }
      AsyncFunction("setDocument") { (view: CindyComposerView, value: [String: Any], offset: Int, focus: Bool) in
        guard view.apply(value) else { return }
        view.editor.selectedRange = NSRange(location: min(max(0, offset), view.editor.attributedText.length), length: 0)
        if focus { view.editor.becomeFirstResponder() }
        view.emitSelection()
      }
      AsyncFunction("resolveLink") { (view: CindyComposerView, href: String, semantic: [String: Any]) in view.resolveLink(href, semantic: semantic) }
      AsyncFunction("insertNodes") { (view: CindyComposerView, nodes: [[String: Any]], revision: Int, start: Int, length: Int) in
        // JS paste parsing must never replace text typed after the paste request.
        guard revision < 0 || revision == view.revision else { return false }
        if start >= 0 {
          guard start <= view.editor.attributedText.length, length >= 0, length <= view.editor.attributedText.length - start else { return false }
          guard view.editor.selectedRange == NSRange(location: start + length, length: 0) else { return false }
          view.editor.selectedRange = NSRange(location: start, length: length)
        }
        view.insert(nodes, recordUndo: revision < 0)
        return true
      }
    }
  }
}

private let nodeKey = NSAttributedString.Key("CindyComposerNode")
private let labelKey = NSAttributedString.Key("CindyComposerLabel")
private let slashKey = NSAttributedString.Key("CindyComposerSlash")
private let wireKey = NSAttributedString.Key("CindyComposerWire")

final class ComposerTextView: UITextView {
  // UITextView creates its own manager lazily after keyboard editing. Pasting
  // semantic content must also work as the first edit in an empty composer.
  private let history = UndoManager()
  override var undoManager: UndoManager? { history }
  weak var owner: CindyComposerView?
  override func paste(_ sender: Any?) {
    guard let owner else { return }
    // Read clipboard only from the explicit system Paste action.
    if let images = UIPasteboard.general.images, !images.isEmpty {
      var payload: [String] = []
      var bytes = 0
      for image in images.prefix(20) {
        guard let data = image.pngData(), data.count <= 30_000_000 - bytes else {
          owner.onPasteImages(["images": []]); return
        }
        bytes += data.count
        payload.append(data.base64EncodedString())
      }
      owner.onPasteImages(["images": payload])
    } else if let text = UIPasteboard.general.string {
      guard text.utf16.count <= 4_000_000, selectedTextRange != nil else { return }
      let start = selectedRange.location
      owner.insert([["node": ["type": "text", "text": text], "label": "", "wire": text]])
      owner.onPasteText(["text": text, "revision": owner.revision, "start": start, "length": text.utf16.count])
    } else { super.paste(sender) }
  }
  override func copy(_ sender: Any?) {
    guard selectedRange.length > 0 else { return }
    let part = attributedText.attributedSubstring(from: selectedRange)
    var result = ""
    part.enumerateAttributes(in: NSRange(location: 0, length: part.length)) { attrs, range, _ in
      result += attrs[wireKey] as? String ?? part.attributedSubstring(from: range).string
    }
    UIPasteboard.general.string = result
  }
  override func cut(_ sender: Any?) {
    copy(sender)
    owner?.insert([])
  }
}

final class CindyComposerView: ExpoView, UITextViewDelegate {
  let onDocumentChange = EventDispatcher()
  let onSelectionChange = EventDispatcher()
  let onFocusChange = EventDispatcher()
  let onContentHeight = EventDispatcher()
  let onPasteText = EventDispatcher()
  let onPasteImages = EventDispatcher()
  let editor = ComposerTextView()
  let placeholder = UILabel()
  var expandedController: UIViewController?
  var revision = 0
  var foreground = UIColor.label
  var chipColor = UIColor.secondarySystemFill
  private var applying = false
  private var lastHeight: CGFloat = 0
  private var deferred: [String: Any]?
  private var textFont: UIFont { UIFont.preferredFont(forTextStyle: .body) }
  private var typingStyle: [NSAttributedString.Key: Any] { [.font: textFont, .foregroundColor: foreground] }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    editor.attributedText = NSAttributedString(string: "")
    editor.owner = self
    editor.delegate = self
    editor.backgroundColor = .clear
    editor.textContainerInset = UIEdgeInsets(top: 3, left: 0, bottom: 3, right: 0)
    editor.textContainer.lineFragmentPadding = 0
    editor.adjustsFontForContentSizeCategory = true
    editor.keyboardDismissMode = .interactive
    editor.alwaysBounceVertical = false
    placeholder.numberOfLines = 1
    placeholder.isUserInteractionEnabled = false
    placeholder.isAccessibilityElement = false
    addSubview(editor)
    editor.addSubview(placeholder)
    updateStyle()
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    guard expandedController == nil else { return }
    editor.frame = bounds
    placeholder.frame = CGRect(x: 0, y: 3, width: bounds.width, height: textFont.lineHeight)
    measure()
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { expandedController?.dismiss(animated: false) }
  }
  func updateStyle() {
    guard editor.markedTextRange == nil else { return }
    applying = true
    let range = NSRange(location: 0, length: editor.textStorage.length)
    editor.textStorage.addAttributes(typingStyle, range: range)
    editor.textStorage.enumerateAttribute(nodeKey, in: range, options: .reverse) { value, span, _ in
      guard let node = value as? [String: Any] else { return }
      let label = editor.textStorage.attribute(labelKey, at: span.location, effectiveRange: nil) as? String ?? ""
      let wire = editor.textStorage.attribute(wireKey, at: span.location, effectiveRange: nil) as? String ?? ""
      editor.textStorage.replaceCharacters(in: span, with: makeText([["node": node, "label": label, "wire": wire]]))
    }
    applying = false
    editor.typingAttributes = typingStyle
    placeholder.font = textFont
  }
  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory || traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) { updateStyle(); measure() }
  }
  private func makeText(_ nodes: [[String: Any]]) -> NSAttributedString {
    let result = NSMutableAttributedString(string: "")
    for item in nodes {
      guard let node = item["node"] as? [String: Any] else { continue }
      if node["type"] as? String == "text" {
        var attributes = typingStyle
        if let slash = node["slashCommand"] as? String { attributes[slashKey] = slash }
        result.append(NSAttributedString(string: node["text"] as? String ?? "", attributes: attributes))
      } else {
        let label = item["label"] as? String ?? ""
        let font = UIFont.preferredFont(forTextStyle: .subheadline)
        let size = CGSize(width: min(240, max(30, (label as NSString).size(withAttributes: [.font: font]).width + 16)), height: font.lineHeight + 6)
        let image = UIGraphicsImageRenderer(size: size).image { context in
          chipColor.setFill()
          UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: size.height / 2).fill()
          let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byTruncatingTail
          (label as NSString).draw(in: CGRect(x: 8, y: 3, width: size.width - 16, height: font.lineHeight), withAttributes: [.font: font, .foregroundColor: foreground, .paragraphStyle: paragraph])
        }
        let attachment = NSTextAttachment(); attachment.image = image; attachment.accessibilityLabel = label
        attachment.bounds = CGRect(x: 0, y: textFont.descender - 3, width: size.width, height: size.height)
        let atom = NSMutableAttributedString(attachment: attachment)
        atom.addAttributes([nodeKey: node, labelKey: label, wireKey: item["wire"] as? String ?? ""], range: NSRange(location: 0, length: 1))
        result.append(atom)
      }
    }
    return result
  }
  @discardableResult func apply(_ value: [String: Any]) -> Bool {
    guard (value["ack"] as? Int ?? 0) >= revision else { return false }
    if editor.markedTextRange != nil { deferred = value; return false }
    guard let nodes = value["nodes"] as? [[String: Any]] else { return false }
    let next = makeText(nodes)
    if NSArray(array: documentNodes()).isEqual(to: nodes.compactMap { $0["node"] as? [String: Any] }) { return true }
    applying = true
    let range = editor.selectedRange
    let wasEmpty = editor.attributedText.length == 0
    editor.attributedText = next
    editor.typingAttributes = typingStyle
    editor.selectedRange = wasEmpty ? NSRange(location: next.length, length: 0) : NSRange(location: min(range.location, next.length), length: min(range.length, max(0, next.length - range.location)))
    applying = false
    emitSelection()
    measure()
    return true
  }
  func resolveLink(_ href: String, semantic: [String: Any]) {
    guard editor.markedTextRange == nil else { return }
    let text = NSMutableAttributedString(attributedString: editor.attributedText)
    var changed = false
    text.enumerateAttribute(nodeKey, in: NSRange(location: 0, length: text.length), options: .reverse) { value, range, _ in
      guard var node = value as? [String: Any], node["type"] as? String == "session-link", node["href"] as? String == href, node["titled"] as? Bool != true else { return }
      changed = true
      for (key, value) in semantic { node[key] = value }
      node["titled"] = true
      let wire = text.attribute(wireKey, at: range.location, effectiveRange: nil) as? String ?? href
      text.replaceCharacters(in: range, with: makeText([["node": node, "label": semantic["label"] as? String ?? href, "wire": wire]]))
    }
    if changed { restore(text, selection: editor.selectedRange, recordUndo: false) }
  }
  func insert(_ nodes: [[String: Any]], recordUndo: Bool = true) {
    let next = NSMutableAttributedString(attributedString: editor.attributedText)
    let range = editor.selectedRange
    let inserted = makeText(nodes)
    next.replaceCharacters(in: range, with: inserted)
    restore(next, selection: NSRange(location: range.location + inserted.length, length: 0), recordUndo: recordUndo)
  }
  private func restore(_ text: NSAttributedString, selection: NSRange, recordUndo: Bool = true) {
    let old = NSAttributedString(attributedString: editor.attributedText)
    let oldSelection = editor.selectedRange
    applying = true
    editor.textStorage.setAttributedString(text)
    editor.selectedRange = selection
    editor.typingAttributes = typingStyle
    applying = false
    if recordUndo { editor.undoManager?.registerUndo(withTarget: self) { target in target.restore(old, selection: oldSelection) } }
    textViewDidChange(editor)
  }
  private func documentNodes() -> [[String: Any]] {
    var nodes: [[String: Any]] = []
    let text = editor.attributedText ?? NSAttributedString(string: "")
    text.enumerateAttributes(in: NSRange(location: 0, length: text.length)) { attrs, range, _ in
      if let node = attrs[nodeKey] as? [String: Any] { nodes.append(node) }
      else {
        let value = text.attributedSubstring(from: range).string
        if let slash = attrs[slashKey] as? String, slash == value {
          nodes.append(["type": "text", "text": value, "slashCommand": slash])
        } else if let last = nodes.last, last["slashCommand"] == nil, last["type"] as? String == "text", let before = last["text"] as? String {
          nodes[nodes.count - 1] = ["type": "text", "text": before + value]
        } else { nodes.append(["type": "text", "text": value]) }
      }
    }
    return nodes
  }
  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    // A selected slash command is a mark on its existing letters, never on new typing.
    textView.typingAttributes = typingStyle
    return true
  }
  func textViewDidChange(_ textView: UITextView) {
    guard !applying else { return }
    revision += 1
    onDocumentChange(["document": ["version": 1, "nodes": documentNodes()], "revision": revision])
    emitSelection()
    measure()
    if editor.markedTextRange == nil, let value = deferred { deferred = nil; apply(value) }
  }
  func textViewDidChangeSelection(_ textView: UITextView) { if !applying { emitSelection() } }
  func emitSelection() {
    onSelectionChange(["start": editor.selectedRange.location, "end": NSMaxRange(editor.selectedRange), "revision": revision])
  }
  func textViewDidBeginEditing(_ textView: UITextView) { onFocusChange(["focused": true]) }
  func textViewDidEndEditing(_ textView: UITextView) { onFocusChange(["focused": false]) }
  private func measure() {
    placeholder.isHidden = editor.attributedText.length > 0
    guard expandedController == nil, bounds.width > 0 else { return }
    let height = ceil(editor.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height)
    editor.isScrollEnabled = height > bounds.height + 1
    if height != lastHeight { lastHeight = height; onContentHeight(["height": height]) }
  }
}
