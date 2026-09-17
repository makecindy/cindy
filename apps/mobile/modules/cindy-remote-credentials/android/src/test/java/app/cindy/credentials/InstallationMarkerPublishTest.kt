package app.cindy.credentials

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class InstallationMarkerPublishTest {
  private class LinkError(val errno: Int) : Exception()

  private fun errnoOf(error: Throwable): Int? = (error as? LinkError)?.errno

  @Test
  fun hardLinkSuccessDoesNotCallExclusive() {
    var exclusive = false
    publishMarkerAtomically(
      publishHardLink = {},
      publishExclusive = { exclusive = true },
      errnoOf = ::errnoOf,
    )
    assertFalse(exclusive)
  }

  @Test
  fun existingMarkerIsAdopted() {
    var exclusive = false
    publishMarkerAtomically(
      publishHardLink = { throw LinkError(InstallationErrno.EEXIST) },
      publishExclusive = { exclusive = true },
      errnoOf = ::errnoOf,
    )
    assertFalse(exclusive)
  }

  @Test
  fun accessDeniedFallsBackToExclusiveCreate() {
    var exclusive = false
    publishMarkerAtomically(
      publishHardLink = { throw LinkError(InstallationErrno.EACCES) },
      publishExclusive = { exclusive = true },
      errnoOf = ::errnoOf,
    )
    assertTrue(exclusive)
  }

  @Test
  fun exclusiveRaceIsAdopted() {
    publishMarkerAtomically(
      publishHardLink = { throw LinkError(InstallationErrno.EXDEV) },
      publishExclusive = { throw LinkError(InstallationErrno.EEXIST) },
      errnoOf = ::errnoOf,
    )
  }

  @Test
  fun otherLinkFailuresStayUnavailable() {
    try {
      publishMarkerAtomically(
        publishHardLink = { throw LinkError(21) },
        publishExclusive = { fail("exclusive must not run") },
        errnoOf = ::errnoOf,
      )
      fail("expected CredentialFailure")
    } catch (error: CredentialFailure) {
      assertEquals("CREDENTIAL_UNAVAILABLE", error.fixedCode)
    }
  }

  @Test
  fun closeDoesNotInitializeAVault() {
    var cancelled = false
    cancelInitializedVault(false) { cancelled = true }
    assertFalse(cancelled)
    cancelInitializedVault(true) { cancelled = true }
    assertTrue(cancelled)
  }

  @Test
  fun teardownSwallowsInitializationFailure() {
    runCredentialTeardown { throw CredentialFailure("CREDENTIAL_UNAVAILABLE") }
  }

  @Test
  fun isolatedCleanupContinuesAfterAStepFails() {
    var second = false
    runIsolated { throw CredentialFailure("CREDENTIAL_UNAVAILABLE") }
    runIsolated { second = true }
    assertTrue(second)
  }
}
