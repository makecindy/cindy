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

/// An account the quota widget can list: one of the sources a computer sent. The id carries the
/// logo and name too (`AccountKey`), so a choice still finds the account on another computer.
struct AccountEntity: AppEntity {
  let key: AccountKey

  var id: String { key.encoded }

  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Account"
  static var defaultQuery = AccountQuery()

  var displayRepresentation: DisplayRepresentation {
    let image = key.logo.map { DisplayRepresentation.Image(named: "logo-\($0)") }
    return DisplayRepresentation(title: "\(key.name)", image: image)
  }
}

/// The accounts of the widget's chosen computer, in that computer's order. Hidden ones on the
/// computer are not sent, so they are not offered either.
struct AccountQuery: EntityQuery {
  @IntentParameterDependency<QuotaWidgetIntent>(\.$computer)
  var config

  func entities(for identifiers: [String]) async throws -> [AccountEntity] {
    identifiers.map { AccountEntity(key: AccountKey(encoded: $0)) }
  }

  func suggestedEntities() async throws -> [AccountEntity] {
    let sources = WidgetState.load(computer: config?.computer.id).snapshot?.sources ?? []
    return sources.map { AccountEntity(key: AccountKey(source: $0)) }
  }
}

/// What a widget's edit sheet chose; nil or empty means the defaults.
protocol UsageWidgetConfiguration: WidgetConfigurationIntent {
  var computerID: String? { get }
  /// Accounts placed first, in this order (`AccountKey` strings).
  var pinnedAccounts: [String]? { get }
  /// Accounts left out (`AccountKey` strings).
  var hiddenAccounts: [String]? { get }
}

/// "Data source" in the daily usage widget's edit sheet.
struct SelectComputerIntent: UsageWidgetConfiguration {
  static var title: LocalizedStringResource = "Data source"
  static var description = IntentDescription("Choose which computer this widget shows.")

  @Parameter(title: "Computer")
  var computer: ComputerEntity?

  var computerID: String? { computer?.id }
  var pinnedAccounts: [String]? { nil }
  var hiddenAccounts: [String]? { nil }
}

/// The quota widget's edit sheet, like the Mac menu bar's settings: accounts placed first and
/// accounts hidden; every other account, including ones added later, follows in the computer's
/// order.
struct QuotaWidgetIntent: UsageWidgetConfiguration {
  static var title: LocalizedStringResource = "Data source"
  static var description = IntentDescription(
    "Choose which computer this widget shows, which accounts come first and which to hide. Other accounts, including ones added later, follow in that computer's order."
  )

  @Parameter(title: "Computer")
  var computer: ComputerEntity?

  /// Up to what each size shows; a plain number would mean exactly that many, with no way to
  /// remove one or clear the choice.
  @Parameter(title: "Accounts first", size: [
    .systemSmall: IntentCollectionSize(min: 0, max: 4),
    .systemMedium: IntentCollectionSize(min: 0, max: 6),
    .systemLarge: IntentCollectionSize(min: 0, max: 7),
  ])
  var pinned: [AccountEntity]?

  @Parameter(title: "Hidden accounts")
  var hidden: [AccountEntity]?

  var computerID: String? { computer?.id }
  var pinnedAccounts: [String]? { pinned?.map(\.id) }
  var hiddenAccounts: [String]? { hidden?.map(\.id) }
}
