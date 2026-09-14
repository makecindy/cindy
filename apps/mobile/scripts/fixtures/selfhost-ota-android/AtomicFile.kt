package android.util

import java.io.File
import java.io.FileOutputStream

// Boundary double only; the actual journal serializes/validates its own state
// and performs real temporary-file writes, fsync and rename in these tests.
class AtomicFile(private val file: File) {
  private val pending = File(file.path + ".new")
  fun readFully(): ByteArray = file.readBytes()
  fun startWrite(): FileOutputStream {
    file.parentFile.mkdirs()
    return FileOutputStream(pending)
  }
  fun finishWrite(stream: FileOutputStream) {
    stream.close()
    check(pending.renameTo(file))
  }
  fun failWrite(stream: FileOutputStream) { stream.close(); pending.delete() }
}
object Log {
  fun w(tag: String, message: String): Int { println("[$tag] $message"); return 0 }
}
