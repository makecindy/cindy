package expo.modules.cindyquotawidget

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class QuotaWidgetPresentationTest {
  @Test fun thirdProviderWarningMustNotDisplaceFittingCards() {
    assertEquals(2, QuotaWidgetPresentation.layout(356, 164, 1f, 3).count)
    assertEquals(1, QuotaWidgetPresentation.layout(178, 164, 1f, 3).count)
    assertEquals(2, QuotaWidgetPresentation.layout(178, 328, 1f, 3).count)
  }

  @Test fun hintsOnlyUseSpareSpaceAndNeverReduceCapacity() {
    assertFalse(QuotaWidgetPresentation.layout(356, 164, 1f, 3).showMoreHint)
    assertFalse(QuotaWidgetPresentation.layout(356, 183, 1f, 3).showMoreHint)
    assertTrue(QuotaWidgetPresentation.layout(356, 184, 1f, 3).showMoreHint)
    assertEquals(3, QuotaWidgetPresentation.layout(356, 328, 1f, 3).count)
    for (scale in listOf(1f, 1.3f, 2f)) for (width in listOf(178, 356, 600)) for (height in 100..400) {
      val two = QuotaWidgetPresentation.layout(width, height, scale, 2)
      val three = QuotaWidgetPresentation.layout(width, height, scale, 3)
      assertTrue(three.count >= two.count)
    }
  }

  @Test fun twoProvidersFitACompactPhoneCardWithoutDemoPadding() {
    val layout = QuotaWidgetPresentation.layout(382, 210, 1f, 2)
    assertEquals(2, layout.columns)
    assertEquals(2, layout.count)
    assertFalse(layout.needsSpace)
    assertEquals(2, QuotaWidgetPresentation.layout(382, 164, 1f, 2).count)
  }
  @Test fun resizingAndFontScaleDoNotHideOverflowOrInventRoom() {
    assertEquals(1, QuotaWidgetPresentation.layout(190, 210, 1f, 2).count)
    assertEquals(2, QuotaWidgetPresentation.layout(190, 340, 1f, 2).count)
    assertTrue(QuotaWidgetPresentation.layout(190, 162, 1f, 2).needsSpace)
    assertTrue(QuotaWidgetPresentation.layout(170, 210, 1f, 2).needsSpace)
    assertEquals(1, QuotaWidgetPresentation.layout(382, 250, 1.3f, 2).count)
    assertTrue(QuotaWidgetPresentation.layout(382, 210, 2f, 2).needsSpace)
  }
  private val now = 1800000000000L
  private fun snapshot() = JSONObject("""{"version":2,"source":"demo","connection":"online","rows":[{"platform":"codex","available":true,"status":"ready","observedAtMs":1800000000000,"windows":[{"kind":"primary","minutes":10080,"remainingPercent":0,"observedAtMs":1800000000000,"resetAtMs":1800601200000}]}]}""")
  @Test fun resetCountsRemainUnknownUnlessTheyAreReliableRemainingIntegers() {
    for ((raw, expected) in listOf(JSONObject.NULL to "—", 0 to "0", 3 to "3", -1 to "—", 1.5 to "—", 9_007_199_254_740_992.0 to "—")) {
      val data = snapshot(); data.getJSONArray("rows").getJSONObject(0).put("extraResetsRemaining",raw)
      val row = QuotaSnapshot.sanitize(data.toString()).getJSONArray("rows").getJSONObject(0)
      assertEquals(expected,QuotaWidgetPresentation.extra(row,"online",now))
      assertEquals("—",QuotaWidgetPresentation.extra(row,"offline",now))
      assertEquals("—",QuotaWidgetPresentation.extra(row,"online",now+900000))
    }
    assertEquals("—",QuotaWidgetPresentation.extra(snapshot().getJSONArray("rows").getJSONObject(0),"online",now))
  }
  @Test fun countsHaveTheirOwnFreshnessAndDoNotRequireAQuotaWindow() {
    val row = snapshot().getJSONArray("rows").getJSONObject(0).put("status","no-windows").put("extraResetsRemaining",0)
    assertEquals("0",QuotaWidgetPresentation.extra(row,"online",now))
    row.put("status","unauthorized"); assertEquals("—",QuotaWidgetPresentation.extra(row,"online",now))
    row.put("status","ready").put("observedAtMs",now+60001); assertEquals("—",QuotaWidgetPresentation.extra(row,"online",now))
  }
  @Test fun durationMatchesTheReviewedLowercaseIosBoundaryRules() {
    assertEquals("6d 23h",QuotaWidgetPresentation.duration(now+6*86400000L+23*3600000,now))
    assertEquals("4h 59m",QuotaWidgetPresentation.duration(now+4*3600000L+59*60000,now))
    assertEquals("1d 0h",QuotaWidgetPresentation.duration(now+86400000,now))
    assertEquals("<1m",QuotaWidgetPresentation.duration(now+1000,now))
    assertEquals("—",QuotaWidgetPresentation.duration(now,now))
    assertEquals("—",QuotaWidgetPresentation.duration(JSONObject.NULL,now))
    assertEquals("99d 0h",QuotaWidgetPresentation.duration(now+200*86400000L,now))
  }
  @Test fun zeroUnknownOfflineAndStaleRemainDistinctWithoutAdvancingObservedTime() {
    val row = snapshot().getJSONArray("rows").getJSONObject(0);val window=row.getJSONArray("windows").getJSONObject(0)
    assertEquals("0%",QuotaWidgetPresentation.value(row,window,"online",now))
    assertEquals("—",QuotaWidgetPresentation.value(row,window,"offline",now))
    assertEquals("Offline",QuotaWidgetPresentation.detail(row,window,"offline",now))
    assertEquals("Outdated",QuotaWidgetPresentation.detail(row,window,"online",now+900000))
    assertEquals(now,window.getLong("observedAtMs"))
    window.put("remainingPercent",JSONObject.NULL);assertEquals("—",QuotaWidgetPresentation.value(row,window,"online",now))
  }
  @Test fun codexDoesNotRenderAnUnrequestedFiveHourOrScopedWindow() {
    val row=snapshot().getJSONArray("rows").getJSONObject(0)
    row.getJSONArray("windows").getJSONObject(0).put("minutes",300)
    assertTrue(QuotaWidgetPresentation.windows(row).isEmpty())
    row.getJSONArray("windows").getJSONObject(0).put("minutes",10080).put("kind","scoped").put("scope","Fable")
    assertTrue(QuotaWidgetPresentation.windows(row).isEmpty())
  }
  @Test fun authorizationErrorsHideOldWindowsAndShowReconnect() {
    val row=snapshot().getJSONArray("rows").getJSONObject(0).put("status","unauthorized")
    assertTrue(QuotaWidgetPresentation.windows(row).isEmpty())
    assertEquals("Reconnect",QuotaWidgetPresentation.empty(row))
    row.put("status","unsupported")
    assertEquals("Not supported",QuotaWidgetPresentation.empty(row))
  }
  @Test fun scopedWindowsRequireARealModelScope() {
    val data=snapshot();val row=data.getJSONArray("rows").getJSONObject(0).put("platform","claude")
    row.getJSONArray("windows").getJSONObject(0).put("kind","scoped")
    assertThrows(IllegalArgumentException::class.java){QuotaSnapshot.sanitize(data.toString())}
  }
}
