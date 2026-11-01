import ExpoModulesCore

public final class CindyIncomingShareModule: Module {
  private var group: String {
    get throws {
      guard let value = Bundle.main.object(forInfoDictionaryKey: "ExpoShareIntoAppGroupId") as? String
      else { throw POSIXError(.ENOENT) }
      return value
    }
  }

  public func definition() -> ModuleDefinition {
    Name("CindyIncomingShare")
    let read = { (wait: Bool) throws -> String? in
      try IncomingShareSlot.withDefaults(group: self.group, wait: wait) { defaults in
        IncomingShareSlot.read(defaults.data(forKey: IncomingShareSlot.key)) {
          try IncomingShareSlot.clear($0, from: defaults)
        }.flatMap { String(data: $0, encoding: .utf8) }
      }
    }
    // Foreground receipt can wait on the writer off the JS/UI thread. The
    // synchronous entry remains for atomic account fences and old JS bundles.
    Function("readSnapshot") { () throws -> String? in try read(false) }
    AsyncFunction("readSnapshotAsync") { () throws -> String? in try read(true) }
      .runOnQueue(DispatchQueue(label: "cindy.incoming-share.read"))
    Function("clearSnapshot") { (expected: String) throws -> Bool in
      try IncomingShareSlot.withDefaults(group: self.group, wait: false) { defaults in
        try IncomingShareSlot.clear(Data(expected.utf8), from: defaults)
      }
    }
    Function("rejectUnreadableSnapshot") { () throws -> Void in
      // Deliberately independent of self.group / App Group locks and I/O.
      try IncomingShareSlot.rejectUnreadable()
    }
    Function("discardSnapshot") { (expected: String) throws -> Bool in
      let bytes = Data(expected.utf8)
      return try IncomingShareSlot.discard(bytes) { expected in
        try IncomingShareSlot.withDefaults(group: self.group, wait: false) { defaults in
          try IncomingShareSlot.clear(expected, from: defaults)
        }
      }
    }
  }
}
