import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offscreen macOS SwiftUI review only. Never presented as an iOS simulator/device screenshot.
const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = process.argv[2];
if (!destination) throw new Error('Pass a destination PNG path');
const medium = process.argv.includes('--medium');
const scenarios = process.argv.includes('--compact') ? ['longest'] : ['longest', 'partial', 'zero', 'unknown', 'outdated', 'offline', 'no windows', 'unauthorized', 'no plan', 'no reset', 'only session', 'no Fable', 'no extra resets', 'zero extra resets'];
const temporary = mkdtempSync(join(tmpdir(), 'cindy-quota-preview-'));
try {
  const source = readFileSync(join(mobile, 'modules/cindy-quota-widget/widget/CindySubscriptionWidget.swift'), 'utf8');
  const view = join(temporary, 'QuotaWidgetView.swift');
  // A command-line macOS process has no iOS asset catalog bundle. Resolve the same SVGs
  // through AppKit only in this diagnostic; all provider view/layout code stays unchanged.
  writeFileSync(view, 'import AppKit\n' + source.slice(0, source.indexOf('struct QuotaWidgetView: View'))
    .replace('Image(platform)', 'Image(nsImage: NSImage(named: NSImage.Name(platform))!)'));
  const renderer = join(temporary, 'QuotaWidgetPreview.swift');
  writeFileSync(renderer, `import AppKit
import SwiftUI
import WidgetKit
@main struct Preview {
  @MainActor static func main() throws {
    let now: Double = 1800000000000
    for name in ["claude", "codex", "xai"] {
      let path = CommandLine.arguments[2] + "/" + name + ".imageset/" + name + ".svg"
      guard let icon = NSImage(contentsOfFile: path) else { fatalError("Missing provider artwork: " + name) }
      icon.setName(NSImage.Name(name))
    }
    let image = ImageRenderer(content: VStack(alignment: .leading, spacing: 16) {
      Text("Subscription widgets · implementation review").font(.system(size: 20, weight: .semibold))
      Text("DEMO DATA · macOS offscreen SwiftUI · NOT iOS / Android runtime").font(.system(size: 12))
      ForEach([false, true], id: \\.self) { dark in
        Text(dark ? "Dark · ${medium ? "medium columns" : "158 pt cards"}" : "Light · ${medium ? "medium columns" : "158 pt cards"}").font(.system(size: 16, weight: .medium))
        ForEach(${JSON.stringify(scenarios)}, id: \\.self) { scenario in
          VStack(alignment: .leading, spacing: 6) {
            Text(scenario.capitalized).font(.system(size: 12))
            HStack(spacing: 12) {
              ForEach(["claude", "codex", "xai"], id: \\.self) { platform in
                let missing = scenario == "no windows" || scenario == "unauthorized"
                let percent: Double? = scenario == "unknown" ? nil : scenario == "zero" ? 0 : scenario == "partial" ? 76 : 100
                let observed = scenario == "outdated" ? now - QuotaSnapshot.maximumAge : now
                let week = QuotaWindow(kind: platform == "claude" ? "sevenDay" : "week", observedAtMs: observed, minutes: 10080, remainingPercent: percent, resetAtMs: scenario == "no reset" ? nil : now + 6*86400000 + 23*3600000)
                let hours = QuotaWindow(kind: "fiveHour", observedAtMs: observed, minutes: 300, remainingPercent: percent, resetAtMs: now + 4*3600000 + 59*60000)
                let scoped = QuotaWindow(kind: "scoped", scope: "Fable", observedAtMs: observed, minutes: 10080, remainingPercent: percent, resetAtMs: nil)
                let row = QuotaRow(plan: scenario == "no plan" ? nil : platform == "claude" ? "Max" : platform == "codex" ? "Pro" : "SuperGrok Heavy", extraResetsRemaining: platform == "codex" ? (scenario == "no extra resets" ? nil : scenario == "zero extra resets" ? 0 : 2) : nil, status: scenario == "unauthorized" ? "unauthorized" : missing ? "no-windows" : "ready", platform: platform, observedAtMs: observed, available: !missing, windows: missing ? [] : platform == "claude" ? (scenario == "only session" ? [hours] : scenario == "no Fable" ? [week,hours] : [week,hours,scoped]) : [week])
                let snapshot = QuotaSnapshot(version: 2, source: "demo", connection: scenario == "offline" ? "offline" : "online", rows: [row])
                QuotaProviderView(platform: platform, row: row, entry: QuotaEntry(date: Date(timeIntervalSince1970: now/1000), snapshot: snapshot), dark: dark, medium: ${medium})
                  .frame(width: 158, height: 158)
                  .background(QuotaWidgetResources.color("widgetSurface", dark: dark))
                  .clipShape(RoundedRectangle(cornerRadius: 22))
              }
            }
          }
        }
      }
    }.padding(24).foregroundStyle(Color.black).background(Color(red: 0.92, green: 0.92, blue: 0.92)).environment(\\.colorScheme, .light))
    image.scale = 2
    guard let cg = image.cgImage else { fatalError("No image rendered") }
    let bitmap = NSBitmapImageRep(cgImage: cg)
    guard let data = bitmap.representation(using: .png, properties: [:]) else { fatalError("No PNG encoded") }
    try data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
  }
}
`);
  const binary = join(temporary, 'quota-widget-preview');
  execFileSync('swiftc', ['-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`,
    join(mobile, 'modules/cindy-quota-widget/ios/QuotaSnapshot.swift'), join(mobile, 'modules/cindy-quota-widget/widget/QuotaWidgetResources.swift'), view, renderer, '-o', binary], { stdio: 'inherit' });
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  execFileSync(binary, [resolve(destination), join(mobile, 'modules/cindy-quota-widget/widget/Assets.xcassets')], { stdio: 'inherit' });
  console.log(`SwiftUI synthetic preview: ${resolve(destination)}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
