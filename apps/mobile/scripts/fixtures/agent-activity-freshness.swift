import Foundation

@main
struct ActivityFreshnessTests {
  static func main() throws {
    let legacy = Data(#"{"status":"attention","title":"Example","detail":"Waiting","count":3,"runningCount":2,"attentionCount":1,"url":"cindy:///","staleDetail":"Old error wording"}"#.utf8)
    var state = try JSONDecoder().decode(CindyAgentActivityAttributes.ContentState.self, from: legacy)
    precondition(state.confirmedAt == nil, "Old push content must decode without inventing a timestamp")
    precondition(state.noticeCount == 1)
    precondition(state.freshnessInterval == 15 * 60, "A waiting headline must not hide running-task freshness")
    state.runningCount = 0
    precondition(state.freshnessInterval == 60 * 60)
    state.attentionCount = 0
    for status in ["completed", "error"] {
      state.status = status
      precondition(state.freshnessInterval == 4 * 60 * 60)
    }
    state.status = "future-status"
    precondition(state.freshnessInterval == 180, "Unknown states remain conservative")
    state.confirmedAt = 1_794_355_200
    let roundtrip = try JSONDecoder().decode(CindyAgentActivityAttributes.ContentState.self, from: JSONEncoder().encode(state))
    precondition(roundtrip == state, "Confirmation time survives ActivityKit Codable round trips")
    print("PASS: legacy decoding, mixed-task freshness, waiting/results policy, timestamp round trip")
  }
}
