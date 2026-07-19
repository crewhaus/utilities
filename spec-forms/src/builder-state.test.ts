import { describe, expect, test } from "bun:test";
import {
  type BuilderSnapshot,
  createBuilderState,
  DEFAULT_HISTORY_LIMIT,
  type ParseSpec,
} from "./builder-state";

// A tiny injected "parse": records calls, throws on the marker text — the
// state machine never knows YAML exists (spec-model stays uninvolved, per the
// module's independence discipline).
function trackingParse(): { parse: ParseSpec; calls: string[] } {
  const calls: string[] = [];
  const parse: ParseSpec = (text) => {
    calls.push(text);
    if (text.includes("BOOM")) throw new Error("bad yaml: BOOM");
    return { parsed: text };
  };
  return { parse, calls };
}

describe("initial state", () => {
  test("initialText behaves like a first load: parsed, clean, empty history", () => {
    const { parse, calls } = trackingParse();
    const state = createBuilderState({ initialText: "name: a", parse });
    const snap = state.get();
    expect(snap.text).toBe("name: a");
    expect(snap.model).toEqual({ parsed: "name: a" });
    expect(snap.parseError).toBeUndefined();
    expect(snap.selection).toBeNull();
    expect(snap.dirty).toBe(false);
    expect(snap.canUndo).toBe(false);
    expect(snap.canRedo).toBe(false);
    expect(calls).toEqual(["name: a"]);
  });

  test("without an injected parse the model stays undefined (text-only state)", () => {
    const state = createBuilderState({ initialText: "x" });
    expect(state.get().model).toBeUndefined();
    expect(state.get().parseError).toBeUndefined();
  });

  test("an initial text that fails to parse surfaces parseError with no model", () => {
    const { parse } = trackingParse();
    const state = createBuilderState({ initialText: "BOOM", parse });
    expect(state.get().model).toBeUndefined();
    expect(state.get().parseError).toBe("bad yaml: BOOM");
  });
});

describe("load", () => {
  test("replaces the document and resets history, dirty, and selection", () => {
    const { parse } = trackingParse();
    const state = createBuilderState({ initialText: "a", parse });
    state.select("perceive");
    state.commitEdit("b");
    expect(state.get().dirty).toBe(true);
    state.load("fresh");
    const snap = state.get();
    expect(snap.text).toBe("fresh");
    expect(snap.model).toEqual({ parsed: "fresh" });
    expect(snap.selection).toBeNull();
    expect(snap.dirty).toBe(false);
    expect(snap.canUndo).toBe(false);
    expect(snap.canRedo).toBe(false);
  });

  test("a bad load does NOT keep the previous document's model", () => {
    const { parse } = trackingParse();
    const state = createBuilderState({ initialText: "good", parse });
    expect(state.get().model).toEqual({ parsed: "good" });
    state.load("BOOM");
    expect(state.get().model).toBeUndefined();
    expect(state.get().parseError).toBe("bad yaml: BOOM");
  });
});

describe("select", () => {
  test("sets and clears the selection, notifying only on change", () => {
    const state = createBuilderState({ initialText: "a" });
    const seen: Array<string | null> = [];
    state.subscribe((s) => seen.push(s.selection));
    state.select("act");
    state.select("act"); // unchanged — no notification
    state.select(null);
    expect(seen).toEqual(["act", null]);
  });

  test("selection survives edits but not loads", () => {
    const state = createBuilderState({ initialText: "a" });
    state.select("stop");
    state.commitEdit("b");
    expect(state.get().selection).toBe("stop");
    state.load("c");
    expect(state.get().selection).toBeNull();
  });
});

describe("commitEdit / dirty", () => {
  test("commits new text, reparses, sets dirty, and records one undo entry", () => {
    const { parse } = trackingParse();
    const state = createBuilderState({ initialText: "v1", parse });
    state.commitEdit("v2");
    const snap = state.get();
    expect(snap.text).toBe("v2");
    expect(snap.model).toEqual({ parsed: "v2" });
    expect(snap.dirty).toBe(true);
    expect(snap.canUndo).toBe(true);
    expect(snap.canRedo).toBe(false);
  });

  test("committing identical text is a no-op (no history, no dirt, no notify)", () => {
    const state = createBuilderState({ initialText: "same" });
    let notifications = 0;
    state.subscribe(() => {
      notifications += 1;
    });
    state.commitEdit("same");
    expect(notifications).toBe(0);
    expect(state.get().dirty).toBe(false);
    expect(state.get().canUndo).toBe(false);
  });

  test("a parse failure mid-edit keeps the LAST-GOOD model and sets parseError", () => {
    const { parse } = trackingParse();
    const state = createBuilderState({ initialText: "good", parse });
    state.commitEdit("BOOM");
    expect(state.get().parseError).toBe("bad yaml: BOOM");
    expect(state.get().model).toEqual({ parsed: "good" }); // canvas stays up
    state.commitEdit("good again");
    expect(state.get().parseError).toBeUndefined();
    expect(state.get().model).toEqual({ parsed: "good again" });
  });

  test("undoing back to the loaded text clears dirty", () => {
    const state = createBuilderState({ initialText: "base" });
    state.commitEdit("edited");
    expect(state.get().dirty).toBe(true);
    state.undo();
    expect(state.get().text).toBe("base");
    expect(state.get().dirty).toBe(false);
  });
});

describe("undo / redo", () => {
  test("walks the edit history both ways", () => {
    const state = createBuilderState({ initialText: "a" });
    state.commitEdit("b");
    state.commitEdit("c");
    expect(state.undo()).toBe(true);
    expect(state.get().text).toBe("b");
    expect(state.undo()).toBe(true);
    expect(state.get().text).toBe("a");
    expect(state.get().canUndo).toBe(false);
    expect(state.redo()).toBe(true);
    expect(state.get().text).toBe("b");
    expect(state.redo()).toBe(true);
    expect(state.get().text).toBe("c");
    expect(state.get().canRedo).toBe(false);
  });

  test("returns false (and does not notify) when there is nothing to step", () => {
    const state = createBuilderState({ initialText: "a" });
    let notifications = 0;
    state.subscribe(() => {
      notifications += 1;
    });
    expect(state.undo()).toBe(false);
    expect(state.redo()).toBe(false);
    expect(notifications).toBe(0);
  });

  test("a new committed edit clears the redo stack", () => {
    const state = createBuilderState({ initialText: "a" });
    state.commitEdit("b");
    state.undo();
    expect(state.get().canRedo).toBe(true);
    state.commitEdit("b2");
    expect(state.get().canRedo).toBe(false);
    expect(state.get().text).toBe("b2");
    state.undo();
    expect(state.get().text).toBe("a");
  });

  test("undo/redo reparse so the model tracks the text", () => {
    const { parse } = trackingParse();
    const state = createBuilderState({ initialText: "a", parse });
    state.commitEdit("b");
    state.undo();
    expect(state.get().model).toEqual({ parsed: "a" });
    state.redo();
    expect(state.get().model).toEqual({ parsed: "b" });
  });
});

describe("beginEdit transactions (coalescing)", () => {
  test("many commits inside one transaction record ONE undo entry", () => {
    const state = createBuilderState({ initialText: "a" });
    state.beginEdit();
    state.commitEdit("ab");
    state.commitEdit("abc");
    state.commitEdit("abcd");
    expect(state.get().text).toBe("abcd");
    expect(state.undo()).toBe(true);
    expect(state.get().text).toBe("a"); // straight back to the transaction base
    expect(state.get().canUndo).toBe(false);
  });

  test("each beginEdit starts a fresh transaction (one entry per burst)", () => {
    const state = createBuilderState({ initialText: "a" });
    state.beginEdit();
    state.commitEdit("b");
    state.commitEdit("bb");
    state.beginEdit();
    state.commitEdit("c");
    state.commitEdit("cc");
    state.undo();
    expect(state.get().text).toBe("bb");
    state.undo();
    expect(state.get().text).toBe("a");
  });

  test("undo ends an open transaction; the next commit records normally", () => {
    const state = createBuilderState({ initialText: "a" });
    state.beginEdit();
    state.commitEdit("b");
    state.undo(); // back to "a", transaction closed
    state.commitEdit("c");
    expect(state.get().text).toBe("c");
    state.undo();
    expect(state.get().text).toBe("a");
  });

  test("commitEdit without beginEdit is single-shot (one entry each)", () => {
    const state = createBuilderState({ initialText: "a" });
    state.commitEdit("b");
    state.commitEdit("c");
    state.undo();
    expect(state.get().text).toBe("b");
    state.undo();
    expect(state.get().text).toBe("a");
  });
});

describe("bounded history ring", () => {
  test("drops the oldest entry beyond historyLimit", () => {
    const state = createBuilderState({ initialText: "v0", historyLimit: 3 });
    for (let i = 1; i <= 5; i += 1) state.commitEdit(`v${i}`);
    // Only the last 3 entries survive: v4, v3, v2.
    const walked: string[] = [];
    while (state.undo()) walked.push(state.get().text);
    expect(walked).toEqual(["v4", "v3", "v2"]);
    expect(state.get().canUndo).toBe(false);
    // dirty is still true — v2 is not the loaded text (v0 fell off the ring).
    expect(state.get().dirty).toBe(true);
  });

  test("the default limit is 100", () => {
    expect(DEFAULT_HISTORY_LIMIT).toBe(100);
    const state = createBuilderState({ initialText: "v0" });
    for (let i = 1; i <= 120; i += 1) state.commitEdit(`v${i}`);
    let undos = 0;
    while (state.undo()) undos += 1;
    expect(undos).toBe(100);
    expect(state.get().text).toBe("v20");
  });
});

describe("subscribe", () => {
  test("listeners get the full snapshot on every mutation until unsubscribed", () => {
    const { parse } = trackingParse();
    const state = createBuilderState({ initialText: "a", parse });
    const seen: BuilderSnapshot[] = [];
    const unsubscribe = state.subscribe((s) => seen.push(s));
    state.commitEdit("b");
    state.select("safety");
    state.undo();
    expect(seen.map((s) => [s.text, s.selection, s.dirty])).toEqual([
      ["b", null, true],
      ["b", "safety", true],
      ["a", "safety", false],
    ]);
    unsubscribe();
    state.commitEdit("c");
    expect(seen.length).toBe(3);
  });

  test("a throwing listener cannot starve the others or break the transition", () => {
    const state = createBuilderState({ initialText: "a" });
    const seen: string[] = [];
    state.subscribe(() => {
      throw new Error("listener bug");
    });
    state.subscribe((s) => seen.push(s.text));
    state.commitEdit("b");
    expect(seen).toEqual(["b"]);
    expect(state.get().text).toBe("b");
  });

  test("subscribe does not replay the current snapshot (read get() first)", () => {
    const state = createBuilderState({ initialText: "a" });
    let called = 0;
    state.subscribe(() => {
      called += 1;
    });
    expect(called).toBe(0);
    expect(state.get().text).toBe("a");
  });
});
