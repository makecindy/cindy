const { withGradleProperties } = require("@expo/config-plugins");

// @react-native-async-storage/async-storage 的安卓后端是 SQLite,默认上限只有 6 MiB,
// 写满后发件箱 / 草稿写入报 SQLITE_FULL,与整机剩余空间无关(#5403)。上限只是允许增长到的
// 最大值,不预占空间。库读取根 gradle.properties 的 AsyncStorage_db_size_in_MB,
// 编译期写进 BuildConfig,所以只随新安装包生效,会改变 runtime fingerprint。
const PROPERTY_KEY = "AsyncStorage_db_size_in_MB";
const DATABASE_SIZE_MB = 64;

function setAsyncStorageDbSize(properties) {
  const value = String(DATABASE_SIZE_MB);
  const existing = properties.find(
    (item) => item.type === "property" && item.key === PROPERTY_KEY,
  );
  if (existing) {
    existing.value = value;
    return properties;
  }
  properties.push({ type: "property", key: PROPERTY_KEY, value });
  return properties;
}

function withAsyncStorageDbSize(config) {
  return withGradleProperties(config, (androidConfig) => {
    androidConfig.modResults = setAsyncStorageDbSize(androidConfig.modResults);
    return androidConfig;
  });
}

module.exports = withAsyncStorageDbSize;
module.exports.setAsyncStorageDbSize = setAsyncStorageDbSize;
module.exports.DATABASE_SIZE_MB = DATABASE_SIZE_MB;
