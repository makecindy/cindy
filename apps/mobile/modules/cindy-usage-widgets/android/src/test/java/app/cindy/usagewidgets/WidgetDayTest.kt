package app.cindy.usagewidgets

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class WidgetDayTest {
  // #13283, unit. Decode a stored Mac snapshot through the Android widget reader.
  // A zero quote and a missing quote give the same total but need different labels.
  @Test
  fun readsAcpValueAndCoverageFromCurrentAndLegacySnapshots() {
    fun checkDay(
      quote: Double?, missing: Boolean?, expectedTotal: Double, expectedMissing: Boolean,
      paid: Double = 0.0, tokens: String = "[0,0,0,0,11635]",
    ) {
      val day = JSONObject("""{"money":[0,0,$paid],"paid":$paid,"tokens":$tokens}""")
      if (quote != null) day.put("acpEstimate", quote)
      if (missing != null) day.put("acpMissingPrice", missing)
      val state = JSONObject("""{"kind":"snapshot","receivedAtMs":1,"snapshot":{"usage":{"daily":[$day]}}}""")
      val decoded = (WidgetState.parse(state) as WidgetState.Snapshot).snapshot.usage.daily.single()
      assertEquals(expectedTotal, decoded.total, 1e-12)
      assertEquals(expectedMissing, decoded.hasMissingEstimate)
      assertEquals(paid, decoded.paid, 0.0)
      assertEquals(11635.0, decoded.totalTokens, 0.0)
    }

    checkDay(0.013841, null, 0.013841, false)
    checkDay(0.013841, true, 2.013841, true, paid = 2.0)
    checkDay(0.0, null, 0.0, false)
    checkDay(0.0, true, 0.0, true)
    checkDay(null, true, 0.0, true)
    checkDay(null, null, 0.0, true)
    checkDay(null, null, 2.0, false, paid = 2.0, tokens = "[11635,0,0]")
  }
}
