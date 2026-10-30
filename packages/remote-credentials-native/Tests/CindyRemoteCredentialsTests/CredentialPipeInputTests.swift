#if os(macOS)
import XCTest
@testable import CindyRemoteCredentials

final class CredentialPipeInputTests: XCTestCase {
  func testShortRequestArrivesBeforeWriterCloses() throws {
    let pipe = Pipe()
    defer {
      try? pipe.fileHandleForWriting.close()
      try? pipe.fileHandleForReading.close()
    }
    let received = expectation(description: "short request while writer is open")
    let request = Data("{\"id\":\"test\",\"method\":\"status\"}\n".utf8)
    DispatchQueue(label: "credential.pipe.test").async {
      do {
        XCTAssertEqual(try CredentialPipeInput.readChunk(from: pipe.fileHandleForReading.fileDescriptor), request)
      } catch { XCTFail("pipe read failed") }
      received.fulfill()
    }
    try pipe.fileHandleForWriting.write(contentsOf: request)
    wait(for: [received], timeout: 2)
  }

  func testEOFAndInvalidDescriptor() throws {
    let pipe = Pipe()
    defer { try? pipe.fileHandleForReading.close() }
    try pipe.fileHandleForWriting.close()
    XCTAssertNil(try CredentialPipeInput.readChunk(from: pipe.fileHandleForReading.fileDescriptor))
    XCTAssertThrowsError(try CredentialPipeInput.readChunk(from: -1))
  }
}
#endif
