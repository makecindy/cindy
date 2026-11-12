package expo.modules.updates.db.entity

import expo.modules.updates.db.enums.UpdateStatus
import java.net.URI
import java.util.Date
import java.util.UUID

data class UpdateEntity(
  val id: UUID,
  val runtimeVersion: String,
  val scopeKey: String,
  val status: UpdateStatus,
  val url: URI?,
  val requestHeaders: Map<String, String>?,
  val commitTime: Date,
  var successfulLaunchCount: Int = 0,
  var failedLaunchCount: Int = 0
)
