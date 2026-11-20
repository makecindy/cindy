// Unit: the icon names exchanged with iOS (setAlternateIconName / alternateIconName).
// Rule: the built-in icon is `null` on the wire, and a name from an icon removed in a
// later version must fall back to it rather than leave the setting without a selection.
// Gap: new module. Minimal failing input: a stored name that is no longer in the list.
import { expect, it } from "vitest";
import { APP_ICONS, appIconAlternateName, appIconFromAlternateName, isAppIcon } from "../appIcons";

it("round-trips every choice through its iOS name and reads unknown names as the built-in icon", () => {
  expect(appIconAlternateName(APP_ICONS[0])).toBeNull();
  for (const icon of APP_ICONS) {
    expect(appIconFromAlternateName(appIconAlternateName(icon))).toBe(icon);
  }
  for (const name of [undefined, "", "AppIcon-retired", "AppIcon-default", "cat"]) {
    expect(appIconFromAlternateName(name)).toBe(APP_ICONS[0]);
  }
  expect(isAppIcon("retired")).toBe(false);
});
