import ExpoModulesCore
import PhotosUI
import UniformTypeIdentifiers
import ImageIO

/// PHPicker's selection callback precedes iCloud loading. Keep the item providers
/// until the existing attachment queue consumes or abandons each selection.
public final class CindyPhotoPickerModule: Module {
  private var picker: PHPickerViewController?
  private var pickerDelegate: PhotoPickerDelegate?
  private var pickerPromise: Promise?
  private var selections: [String: NSItemProvider] = [:]
  private var loads: [String: PhotoLoad] = [:]

  public func definition() -> ModuleDefinition {
    Name("CindyPhotoPicker")
    AsyncFunction("pick") { (limit: Int, promise: Promise) in
      self.present(limit: limit, promise: promise)
    }.runOnQueue(.main)
    AsyncFunction("load") { (id: String, promise: Promise) in
      self.load(id: id, promise: promise)
    }.runOnQueue(.main)
    AsyncFunction("cancel") { (id: String) in
      self.cancel(id: id)
    }.runOnQueue(.main)
    AsyncFunction("release") { (id: String) in
      self.selections.removeValue(forKey: id)
      self.cancel(id: id)
    }.runOnQueue(.main)
    OnDestroy {
      DispatchQueue.main.async {
        self.pickerPromise?.resolve([])
        self.pickerPromise = nil
        self.picker?.dismiss(animated: false)
        self.picker = nil
        self.pickerDelegate = nil
        self.selections.removeAll()
        for id in Array(self.loads.keys) { self.cancel(id: id) }
      }
    }
  }

  private func present(limit: Int, promise: Promise) {
    guard picker == nil else {
      promise.reject("ERR_PHOTO_PICKER_BUSY", "Photo picker is already open.")
      return
    }
    guard let presenter = appContext?.utilities?.currentViewController() else {
      promise.reject("ERR_PHOTO_PICKER_PRESENTER", "No view controller for photo picker.")
      return
    }
    var configuration = PHPickerConfiguration(photoLibrary: .shared())
    configuration.filter = .images
    configuration.selection = .ordered
    configuration.selectionLimit = max(1, limit)
    configuration.preferredAssetRepresentationMode = .current
    let picker = PHPickerViewController(configuration: configuration)
    let delegate = PhotoPickerDelegate { [weak self, weak picker] results in
      guard let self, let picker, self.picker === picker else { return }
      let selected = results.enumerated().map { index, result -> [String: Any] in
        let id = UUID().uuidString
        self.selections[id] = result.itemProvider
        var value: [String: Any] = [
          "id": id,
          "name": result.itemProvider.suggestedName ?? "photo-\(index + 1)",
          "previewUri": ""
        ]
        // Read only a small LOCAL thumbnail. Never wait for an original or ask
        // for broader library permission just to preview a selected photo.
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if (status == .authorized || status == .limited), let assetID = result.assetIdentifier,
           let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetID], options: nil).firstObject {
          value["width"] = asset.pixelWidth
          value["height"] = asset.pixelHeight
          let options = PHImageRequestOptions()
          options.isNetworkAccessAllowed = false
          options.isSynchronous = true
          options.deliveryMode = .fastFormat
          options.resizeMode = .fast
          PHImageManager.default().requestImage(
            for: asset, targetSize: CGSize(width: 216, height: 216),
            contentMode: .aspectFit, options: options
          ) { image, _ in
            if let data = image?.jpegData(compressionQuality: 0.7) {
              value["previewUri"] = "data:image/jpeg;base64,\(data.base64EncodedString())"
            }
          }
        }
        return value
      }
      // Resolve before dismissal so the composer already has the selection on
      // its first visible frame. No file representation is requested here.
      self.pickerPromise?.resolve(selected)
      self.pickerPromise = nil
      self.picker = nil
      self.pickerDelegate = nil
      picker.dismiss(animated: true)
    }
    picker.delegate = delegate
    picker.presentationController?.delegate = delegate
    self.picker = picker
    pickerDelegate = delegate
    pickerPromise = promise
    presenter.present(picker, animated: true)
    picker.presentationController?.delegate = delegate
  }

  private func load(id: String, promise: Promise) {
    guard let provider = selections[id] else {
      promise.reject("ERR_PHOTO_SELECTION_RELEASED", "Photo selection is no longer available.")
      return
    }
    guard loads[id] == nil else {
      promise.reject("ERR_PHOTO_LOAD_BUSY", "Photo is already loading.")
      return
    }
    let load = PhotoLoad(promise: promise)
    loads[id] = load
    // NSItemProvider preserves the picker grant even for a photo outside the
    // limited library. This also keeps edits, GIFs and the current representation.
    load.progress = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] url, error in
      var copy: URL?
      var failure = error
      if let url, failure == nil {
        do {
          let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ImagePicker", isDirectory: true)
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          let target = directory.appendingPathComponent("cindy-photo-\(UUID().uuidString)")
            .appendingPathExtension(url.pathExtension)
          // The provider's URL is valid only inside this callback.
          do {
            try FileManager.default.copyItem(at: url, to: target)
          } catch {
            try? FileManager.default.removeItem(at: target)
            throw error
          }
          copy = target
        } catch { failure = error }
      }
      let copied = copy
      let loadError = failure
      DispatchQueue.main.async {
        guard let self, self.loads[id] === load else {
          if let copied { try? FileManager.default.removeItem(at: copied) }
          return
        }
        self.loads.removeValue(forKey: id)
        guard let copied, loadError == nil else {
          load.promise.reject("ERR_PHOTO_LOAD", loadError?.localizedDescription ?? "Unable to read photo.")
          return
        }
        let type = UTType(filenameExtension: copied.pathExtension)
        let name = provider.suggestedName.map { URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent }
          ?? "photo"
        let size = (try? copied.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        var result: [String: Any] = [
          "uri": copied.absoluteString,
          "fileName": copied.pathExtension.isEmpty ? name : "\(name).\(copied.pathExtension)",
          "mimeType": type?.preferredMIMEType ?? "application/octet-stream",
          "fileSize": size
        ]
        // Read dimensions without decoding full pixels. Limited-library photos
        // have no PHAsset metadata, and edits can change the original dimensions.
        if let source = CGImageSourceCreateWithURL(copied as CFURL, nil),
           let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let width = properties[kCGImagePropertyPixelWidth] as? Int,
           let height = properties[kCGImagePropertyPixelHeight] as? Int {
          let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
          let rotated = (5...8).contains(orientation)
          result["width"] = rotated ? height : width
          result["height"] = rotated ? width : height
        }
        load.promise.resolve(result)
      }
    }
  }

  private func cancel(id: String) {
    guard let load = loads.removeValue(forKey: id) else { return }
    load.progress?.cancel()
    load.promise.reject("ERR_PHOTO_CANCELLED", "Photo loading was cancelled.")
    // Keep the provider for the existing failed-card retry. Late callbacks are
    // identified by PhotoLoad identity and dispose only their own file copy.
  }
}

private final class PhotoLoad {
  let promise: Promise
  var progress: Progress?
  init(promise: Promise) { self.promise = promise }
}

private final class PhotoPickerDelegate: NSObject, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  let onResults: ([PHPickerResult]) -> Void
  init(onResults: @escaping ([PHPickerResult]) -> Void) { self.onResults = onResults }
  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    onResults(results)
  }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    onResults([])
  }
}
