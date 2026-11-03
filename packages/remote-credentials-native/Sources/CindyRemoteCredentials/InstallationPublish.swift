import Darwin

enum InstallationPublish {
  enum Decision {
    case adoptedExisting
    /// Exclusive rename of a complete temporary file onto the marker path.
    case createExclusive
    case unavailable
  }

  static func decide(errno code: Int32) -> Decision {
    if code == EEXIST { return .adoptedExisting }
    if code == EACCES || code == EPERM || code == EXDEV || code == ENOSYS
      || code == ENOTSUP || code == EOPNOTSUPP {
      return .createExclusive
    }
    return .unavailable
  }
}
