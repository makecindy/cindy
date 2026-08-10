/** Immutable upstream source selected for the Phase 0 compatibility matrix. */
export const WDA_SOURCE_PIN = Object.freeze({
  repository: "https://github.com/appium/WebDriverAgent.git",
  tag: "v15.1.6",
  revision: "5f8280e761dc0b5b9b28368e63a8f0cc8d868346",
  releaseUrl: "https://github.com/appium/WebDriverAgent/releases/tag/v15.1.6",
  archiveUrl:
    "https://codeload.github.com/appium/WebDriverAgent/tar.gz/refs/tags/v15.1.6",
  archiveFileName: "WebDriverAgent-v15.1.6.tar.gz",
  archiveSha256:
    "98c8f7102768aa10530c9b124be39d66a06a146631708416348b88f2db1a56c3",
  license: "BSD-3-Clause",
  licenseSha256:
    "d9910c6ba5e4c29ae415ee3ce875c9e18a60d8bc4d7fe2c2d104db2a718b1bb4",
  pinnedAt: "2026-07-22",
});

export type WdaSourcePin = typeof WDA_SOURCE_PIN;
