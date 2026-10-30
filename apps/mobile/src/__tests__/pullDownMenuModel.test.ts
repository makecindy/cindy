import { describe, expect, it } from "vitest";
import {
  buildPullDownMenuSections,
  resolvePullDownSubmenu,
} from "@/platform/chrome/pullDownMenuModel";

describe("pull-down menu model", () => {
  it("turns inline groups into titled sections and keeps loose rows together", () => {
    const sections = buildPullDownMenuSections([
      { id: "all", title: "All" },
      { id: "team", title: "Teammates" },
      {
        id: "group.sort",
        title: "Sort",
        displayInline: true,
        subactions: [
          { id: "sort.a", title: "A" },
          {
            id: "nested",
            title: "",
            displayInline: true,
            subactions: [{ id: "sort.b", title: "B" }],
          },
        ],
      },
      {
        id: "group.blank",
        title: "  ",
        displayInline: true,
        subactions: [{ id: "x", title: "X" }],
      },
      { id: "tail", title: "Tail" },
    ]);
    expect(
      sections.map((section) => [
        section.title,
        section.rows.map((row) => row.id),
      ]),
    ).toEqual([
      [undefined, ["all", "team"]],
      ["Sort", ["sort.a", "sort.b"]],
      [undefined, ["x"]],
      [undefined, ["tail"]],
    ]);
  });

  it("resolves submenu paths through inline groups and drops stale paths", () => {
    const actions = [
      {
        id: "group",
        title: "Group",
        displayInline: true,
        subactions: [
          {
            id: "more",
            title: "More",
            subactions: [
              {
                id: "deep",
                title: "Deep",
                subactions: [{ id: "leaf", title: "Leaf" }],
              },
            ],
          },
        ],
      },
    ];
    expect(resolvePullDownSubmenu(actions, ["more"])?.id).toBe("more");
    expect(resolvePullDownSubmenu(actions, ["more", "deep"])?.id).toBe("deep");
    expect(resolvePullDownSubmenu(actions, ["missing"])).toBeNull();
  });
});
