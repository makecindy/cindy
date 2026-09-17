package app.cindy.credentials

/** Linux/Android errno values used by installation marker publish. */
internal object InstallationErrno {
  const val EPERM = 1
  const val EACCES = 13
  const val EEXIST = 17
  const val EXDEV = 18
  const val ENOSYS = 38
  const val ENOTSUP = 95
}

private val linkFallbackErrnos = setOf(
  InstallationErrno.EPERM,
  InstallationErrno.EACCES,
  InstallationErrno.EXDEV,
  InstallationErrno.ENOSYS,
  InstallationErrno.ENOTSUP,
)

/**
 * Publish a fully written marker. Prefer an exclusive hard link; if the
 * filesystem refuses the link, fall back to exclusive rename of that complete
 * file. Any other failure becomes CREDENTIAL_UNAVAILABLE so teardown cannot
 * abort the process.
 */
internal fun publishMarkerAtomically(
  publishHardLink: () -> Unit,
  publishExclusive: () -> Unit,
  errnoOf: (Throwable) -> Int?,
) {
  try {
    publishHardLink()
  } catch (error: Throwable) {
    val errno = errnoOf(error) ?: throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
    if (errno == InstallationErrno.EEXIST) return
    if (errno !in linkFallbackErrnos) throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
    try {
      publishExclusive()
    } catch (fallback: Throwable) {
      if (errnoOf(fallback) != InstallationErrno.EEXIST) {
        throw CredentialFailure("CREDENTIAL_UNAVAILABLE")
      }
    }
  }
}

internal fun cancelInitializedVault(initialized: Boolean, cancel: () -> Unit) {
  if (initialized) cancel()
}

internal fun runIsolated(action: () -> Unit) {
  try {
    action()
  } catch (_: Exception) {
  }
}

internal fun runCredentialTeardown(action: () -> Unit) {
  try {
    action()
  } catch (_: Exception) {
  }
}
