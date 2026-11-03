import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

type PropertiesItem =
  | { type: "property"; key: string; value: string }
  | { type: "comment"; value: string };
const require = createRequire(import.meta.url);
const { setAsyncStorageDbSize, DATABASE_SIZE_MB } =
  require("../../plugins/with-async-storage-db-size.js") as {
    setAsyncStorageDbSize: (properties: PropertiesItem[]) => PropertiesItem[];
    DATABASE_SIZE_MB: number;
  };

describe("with-async-storage-db-size config plugin", () => {
  it("raises the Android AsyncStorage limit from the 6 MiB default to 64 MiB", () => {
    expect(DATABASE_SIZE_MB).toBe(64);
    const properties = setAsyncStorageDbSize([
      { type: "property", key: "newArchEnabled", value: "true" },
    ]);
    expect(properties).toEqual([
      { type: "property", key: "newArchEnabled", value: "true" },
      {
        type: "property",
        key: "AsyncStorage_db_size_in_MB",
        value: String(DATABASE_SIZE_MB),
      },
    ]);
  });

  it("overwrites an existing value instead of appending a duplicate on incremental prebuild", () => {
    const properties = setAsyncStorageDbSize([
      { type: "comment", value: "kept" },
      { type: "property", key: "AsyncStorage_db_size_in_MB", value: "6" },
    ]);
    expect(properties).toEqual([
      { type: "comment", value: "kept" },
      {
        type: "property",
        key: "AsyncStorage_db_size_in_MB",
        value: String(DATABASE_SIZE_MB),
      },
    ]);
  });

  it("is registered in app.json", () => {
    const appJson = JSON.parse(
      readFileSync(resolve(__dirname, "../../app.json"), "utf8"),
    );
    expect(appJson.expo.plugins).toContain(
      "./plugins/with-async-storage-db-size",
    );
  });
});
