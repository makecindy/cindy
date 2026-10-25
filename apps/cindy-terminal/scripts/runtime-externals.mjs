// SDKs may resolve package metadata or worker entry points relative to their
// own CommonJS files. Ship them intact instead of flattening them into ESM.
export const imRuntimePackages = ['@larksuiteoapi/node-sdk', 'discord.js', '@wecom/aibot-node-sdk', 'dingtalk-stream'];
// React must precede Ink so all renderer peers share one singleton.
export const runtimePackages = ['react', 'ink', '@roamhq/wrtc', 'better-sqlite3', 'sharp', 'node-pty', 'ssh2', 'ws', 'playwright-core', 'semver', 'trash', 'silk-wasm', '@napi-rs/canvas', 'pdfjs-dist'];
