import AppIntents
import WidgetKit

/// A computer a widget can show, or "automatic": the one that answered the app last.
struct ComputerEntity: AppEntity {
  static let autoID = "auto"
  static let automatic = ComputerEntity(id: autoID, name: "")

  let id: String
  let name: String

  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Computer"
  static var defaultQuery = ComputerQuery()

  var displayRepresentation: DisplayRepresentation {
    id == Self.autoID
      ? DisplayRepresentation(title: "Automatic", subtitle: "The computer that answered last")
      : DisplayRepresentation(title: "\(name)")
  }
}

/// The computers the app last listed (other computers that allow remote control).
struct ComputerQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [ComputerEntity] {
    all().filter { identifiers.contains($0.id) }
  }

  func suggestedEntities() async throws -> [ComputerEntity] {
    all()
  }

  func defaultResult() async -> ComputerEntity? {
    .automatic
  }

  private func all() -> [ComputerEntity] {
    [.automatic] + (WidgetStore.load()?.computers.map { ComputerEntity(id: $0.id, name: $0.name) } ?? [])
  }
}

/// "Data source" in the widget's edit sheet.
struct SelectComputerIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Data source"
  static var description = IntentDescription("Choose which computer this widget shows.")

  @Parameter(title: "Computer")
  var computer: ComputerEntity?
}
