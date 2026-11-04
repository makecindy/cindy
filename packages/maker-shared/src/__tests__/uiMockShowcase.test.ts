import { describe, expect, it } from "vitest";
import { buildUiMockRows, UI_MOCK_PROJECTS, UI_MOCK_TASKS } from "../uiMock";
import { UI_MOCK_SHOWCASE_TASKS } from "../uiMockShowcase";
import {
  RichAnswerStream,
  richChart,
  richLabel,
  richResolvedValues,
  richVisualStyle,
  splitRichAnswer,
} from "../richAnswer";

const documentFor = (id: string) => {
  const task = UI_MOCK_TASKS.find((item) => item.id === id)!;
  const message = task.messages.find((item) => item.role === "assistant")!;
  if (!("text" in message)) throw new Error("Missing showcase answer");
  const part = splitRichAnswer(message.text).find(
    (item) => item.kind === "rich",
  )!;
  const doc = new RichAnswerStream().update(part.source, part.complete);
  expect(doc.issues).toBe(0);
  return doc;
};

describe("shared full-client showcase data", () => {
  it("keeps deterministic task identities and valid project references on both path styles", () => {
    expect(new Set(UI_MOCK_TASKS.map((task) => task.id)).size).toBe(
      UI_MOCK_TASKS.length,
    );
    for (const projectRoot of ["/demo/Projects", "C:\\Demo\\Projects"]) {
      const rows = buildUiMockRows({ now: 1_800_000_000_000, projectRoot });
      for (const task of UI_MOCK_SHOWCASE_TASKS) {
        expect(
          UI_MOCK_PROJECTS.some((project) => project.name === task.project),
        ).toBe(true);
        expect(rows.sessions.find((row) => row.id === task.id)).toBeDefined();
      }
      expect(buildUiMockRows({ now: 1_800_000_000_000, projectRoot })).toEqual(
        rows,
      );
    }
  });

  it.each(["zh", "en"])(
    "uses the CSV numbers in the %s report and renders safe local controls",
    (locale) => {
      const project = UI_MOCK_PROJECTS.find(
        (item) => item.name === `orbit-garden-${locale}`,
      )!;
      const counts = project.files["data/feedback.csv"]
        .trim()
        .split("\n")
        .slice(1)
        .map((row) => Number(row.split(",")[1]));
      const trend = project.files["data/completion.csv"]
        .trim()
        .split("\n")
        .slice(1)
        .map((row) => Number(row.split(",")[1]));
      const report = documentFor(`ui-mock-showcase-feedback-${locale}`);
      const values = richResolvedValues(report);
      expect(richLabel(report.nodes.get("feedback")!, values)).toBe(
        String(counts.reduce((a, b) => a + b, 0)),
      );
      expect(
        richChart(report.nodes.get("trend")!, values).map((item) => item.value),
      ).toEqual(trend);
      expect(richLabel(report.nodes.get("improvement")!, values)).toBe("+24");
      const plan = documentFor(`ui-mock-showcase-plan-${locale}`);
      for (const doc of [report, plan]) {
        // DESIGN §3: both clients render the same supported title size and weight.
        expect(richVisualStyle(doc.nodes.get("heading")!)).toMatchObject({
          fontSize: 24,
          fontWeight: "600",
        });
      }
      const defaults = richResolvedValues(plan);
      expect(defaults.hours).toBe(36);
      expect(defaults.days).toBe(3);
      const adjusted = richResolvedValues(plan, {
        team: 4,
        exploration: true,
        haptics: true,
      });
      expect(adjusted.hours).toBe(48);
      expect(adjusted.days).toBe(2);
      for (const node of plan.nodes.values())
        expect(node.props.send).toBeUndefined();
    },
  );
});
