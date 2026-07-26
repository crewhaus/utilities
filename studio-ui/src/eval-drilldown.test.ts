/**
 * E53 — the studio's per-sample eval drill-down + annotation control.
 *
 * The client bundle is a STRING assembled inside a template literal, so a
 * stray backtick or an unescaped newline escape produces JS that only fails in
 * a browser. The first test therefore runs the emitted bundle through a real
 * JS parser (Bun's transpiler, which throws on a syntax error and never
 * executes the source) before any content assertion — that gate is what
 * catches the class of bug the earlier studio work hit twice.
 */
import { describe, expect, test } from "bun:test";
import { getStudioJs, renderStudioHtml } from "./index.js";

/** Parse-check the emitted bundle without executing it. */
function assertParses(js: string): void {
  new Bun.Transpiler({ loader: "js" }).transformSync(js);
}

describe("studio client bundle (E53)", () => {
  test("the emitted JS still parses after the drill-down additions", () => {
    expect(() => assertParses(getStudioJs())).not.toThrow();
  });

  test("newline escapes survive the template-literal assembly", () => {
    const js = getStudioJs();
    // The source writes '\\n' so the EMITTED bundle carries the two-character
    // escape. A literal newline inside those single-quoted strings would be a
    // syntax error — the parse check above is the real guard, this pins intent.
    expect(js).toContain("parts.join('\\n')");
    expect(js).toContain("lines.join('\\n\\n')");
  });

  test("run list drills into a run, and a run drills into a sample", () => {
    const js = getStudioJs();
    expect(js).toContain("renderEvalRunDetail");
    expect(js).toContain("renderEvalSampleDetail");
    expect(js).toContain("'/api/evals/' + encodeURIComponent(runId)");
    expect(js).toContain("encodeURIComponent(sampleId)");
    // The run table gained a drill affordance and keeps its read-only columns.
    expect(js).toContain("'samples'");
    expect(js).toContain("'inspect'");
  });

  test("the sample view renders per-grader verdicts, rationale and the transcript", () => {
    const js = getStudioJs();
    expect(js).toContain("perGrader");
    expect(js).toContain("rationale");
    expect(js).toContain("Grader verdicts");
    expect(js).toContain("eval-transcript");
    expect(js).toContain("evalLineText");
  });

  test("the annotation control posts a verdict to the annotate endpoint", () => {
    const js = getStudioJs();
    expect(js).toContain("renderEvalAnnotateForm");
    expect(js).toContain("/annotate");
    expect(js).toContain("verdict: verdict");
    expect(js).toContain("'mark pass'");
    expect(js).toContain("'mark fail'");
    // The optional fields the FeedbackRecord carries.
    expect(js).toContain("correction");
    expect(js).toContain("adjudicate");
    expect(js).toContain("rater");
    // The response tells the reviewer where the record landed.
    expect(js).toContain("feedbackPath");
    expect(js).toContain("reviewAdded");
  });

  test("the annotate copy does not promise a distill hop the join cannot make", () => {
    const js = getStudioJs();
    // `crewhaus distill` joins on (sessionId, turnNumber) over
    // `.crewhaus/sessions`, where an eval sample never writes — see
    // studio-server/src/eval-drilldown.ts. The UI must not say otherwise.
    expect(js).not.toContain("becomes expected_output at distill");
    expect(js).not.toContain("at distill)");
  });

  test("every class the drill-down emits carries a stylesheet rule", () => {
    const html = renderStudioHtml();
    // Without these, `<pre class="eval-transcript">` scrolls the whole panel
    // horizontally and the annotate inputs render as bare inline fields.
    for (const cls of [
      "eval-drill",
      "eval-back",
      "eval-transcript",
      "eval-annotate",
      "eval-annotate-adjudicate",
      "eval-annotate-pass",
      "eval-annotate-fail",
      "eval-annotate-status",
    ]) {
      expect(html).toContain(`.${cls} `);
    }
    // The transcript must wrap and scroll inside its own box.
    expect(html).toContain("white-space: pre-wrap");
    expect(html).toContain("max-height: 40vh");
  });
});
