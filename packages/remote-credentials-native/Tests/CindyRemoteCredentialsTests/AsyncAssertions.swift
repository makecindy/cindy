import XCTest

func assertThrowsAsync<T>(_ operation: @autoclosure () async throws -> T,
  file: StaticString = #filePath, line: UInt = #line) async {
  do { _ = try await operation(); XCTFail("Expected failure", file: file, line: line) }
  catch { }
}
