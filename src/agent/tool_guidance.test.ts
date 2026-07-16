// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildToolUseGuidance } from "./tool_guidance.js";

const named = (...names: string[]) => names.map((name) => ({ name }));

describe("buildToolUseGuidance", () => {
  it("returns nothing for a leaf with no tools (a pure-inference leaf)", () => {
    expect(buildToolUseGuidance([])).toBe("");
  });

  it("always includes the parallel-calls and stop-when-done lines when any tool is present", () => {
    const out = buildToolUseGuidance(named("read"));
    expect(out).toContain("# Tool-use conventions");
    expect(out).toContain("Work in parallel");
    expect(out).toContain("Reuse what's already in context");
    expect(out).toContain("Stop when the task is done");
  });

  it("adds edit/verify/todo guidance for a full built-in set", () => {
    const out = buildToolUseGuidance(named("read", "edit", "apply_patch", "bash", "todo"));
    expect(out).toContain("Make targeted changes");
    expect(out).toContain("apply_patch to make several edits");
    expect(out).toContain("the match must be exact");
    expect(out).toContain("never leave a placeholder comment");
    expect(out).toContain("Verify your work");
    expect(out).toContain("track it with the todo tool");
    // The confirming-re-read warning appears only when the leaf can edit.
    expect(out).toContain("don't re-read a file just to confirm an edit");
  });

  it("omits capabilities the leaf does not have (read-only leaf)", () => {
    // The read-only set: read/ls/grep/glob/webfetch/web_search/lsp — no edit, bash, apply_patch, todo.
    const out = buildToolUseGuidance(named("read", "ls", "grep", "glob"));
    expect(out).toContain("Work in parallel");
    expect(out).not.toContain("Make targeted changes");
    expect(out).not.toContain("Verify your work");
    expect(out).not.toContain("todo tool");
    // No edit tools → no confirming-re-read clause on the reuse line.
    expect(out).not.toContain("confirm an edit");
  });

  it("adds the pull-in-only-what-you-need line for a reading tool, with the bash clause only when bash is present", () => {
    // read/grep present, no bash: the narrowing line appears without the "prefer over bash" clause.
    const readOnly = buildToolUseGuidance(named("read", "grep"));
    expect(readOnly).toContain("Pull in only what you need");
    expect(readOnly).not.toContain("Prefer the read/grep/glob tools");
    // Adding bash brings in the shell-out clause.
    const withBash = buildToolUseGuidance(named("read", "grep", "bash"));
    expect(withBash).toContain("Prefer the read/grep/glob tools over");
    // A leaf with neither read nor grep gets no such line.
    expect(buildToolUseGuidance(named("bash", "todo"))).not.toContain("Pull in only what you need");
  });

  it("mentions apply_patch only when apply_patch is present, edit-match only when edit is", () => {
    const patchOnly = buildToolUseGuidance(named("apply_patch"));
    expect(patchOnly).toContain("apply_patch to make several edits");
    expect(patchOnly).not.toContain("the match must be exact");

    const editOnly = buildToolUseGuidance(named("edit"));
    expect(editOnly).toContain("the match must be exact");
    expect(editOnly).not.toContain("apply_patch to make several edits");
  });
});
