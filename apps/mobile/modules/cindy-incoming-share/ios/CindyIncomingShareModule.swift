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
    Function("readSnapshot") { () throws -> String? in
      try IncomingShareSlot.withDefaults(group: self.group) { defaults in
        defaults.data(forKey: IncomingShareSlot.key).flatMap { String(data: $0, encoding: .utf8) }
      }
    }
    Function("clearSnapshot") { (expected: String) throws -> Bool in
      try IncomingShareSlot.withDefaults(group: self.group) { defaults in
        try IncomingShareSlot.clear(Data(expected.utf8), from: defaults)
      }
    }
  }
}
