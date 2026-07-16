// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ExecutableTool } from "./tools.js";
import {
  advertisedTools,
  FIND_TOOLS_NAME,
  planToolDisclosure,
  TOOL_DEFER_MIN_CHARS,
  TOOL_DEFER_MIN_COUNT,
} from "./tool_search.js";

/** A deferrable (MCP-shaped) tool whose description is padded to `descChars` so a set of them can be
 *  pushed over/under the char threshold precisely. */
function mcpTool(name: string, descChars = 4000): ExecutableTool {
  return {
    name,
    description: "d".repeat(descChars),
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      additionalProperties: false,
    },
    execute: () => Promise.resolve(`ran ${name}`),
  };
}

/** N deferrable tools, each large enough that the set clears TOOL_DEFER_MIN_CHARS. */
function bigSet(n: number, prefix = "srv__tool"): ExecutableTool[] {
  return Array.from({ length: n }, (_, i) => mcpTool(`${prefix}${String(i)}`));
}

describe("planToolDisclosure — gating", () => {
  it("returns null when there are fewer than TOOL_DEFER_MIN_COUNT tools, however large", () => {
    const deferrable = bigSet(TOOL_DEFER_MIN_COUNT - 1);
    expect(planToolDisclosure({ deferrable, allToolNames: new Set() })).toBeNull();
  });

  it("returns null when the combined schema is below TOOL_DEFER_MIN_CHARS, however many tools", () => {
    // Many tools, but each tiny — combined well under the char threshold.
    const deferrable = Array.from({ length: 20 }, (_, i) => mcpTool(`t${String(i)}`, 10));
    const chars = deferrable.reduce(
      (s, t) => s + t.name.length + t.description.length + JSON.stringify(t.inputSchema).length,
      0,
    );
    expect(chars).toBeLessThan(TOOL_DEFER_MIN_CHARS);
    expect(planToolDisclosure({ deferrable, allToolNames: new Set() })).toBeNull();
  });

  it("engages when the set clears BOTH thresholds", () => {
    const deferrable = bigSet(TOOL_DEFER_MIN_COUNT);
    const plan = planToolDisclosure({ deferrable, allToolNames: new Set() });
    expect(plan).not.toBeNull();
    expect(plan?.deferredNames.size).toBe(TOOL_DEFER_MIN_COUNT);
    expect(plan?.findTool.name).toBe(FIND_TOOLS_NAME);
    expect(plan?.activated.size).toBe(0);
  });

  it("does NOT engage (returns null) when a tool named find_tools already exists — no collision", () => {
    const deferrable = bigSet(TOOL_DEFER_MIN_COUNT);
    const plan = planToolDisclosure({
      deferrable,
      allToolNames: new Set([FIND_TOOLS_NAME, "read"]),
    });
    expect(plan).toBeNull();
  });
});

describe("planToolDisclosure — catalog", () => {
  it("lists every deferred tool name and points at find_tools", () => {
    const deferrable = bigSet(TOOL_DEFER_MIN_COUNT);
    const plan = planToolDisclosure({ deferrable, allToolNames: new Set() });
    const catalog = plan?.catalog ?? "";
    expect(catalog).toContain("<tools>");
    expect(catalog).toContain(FIND_TOOLS_NAME);
    for (const t of deferrable) expect(catalog).toContain(t.name);
  });
});

describe("advertisedTools", () => {
  it("is identity when there is no disclosure", () => {
    const tools = [mcpTool("a"), mcpTool("b")];
    expect(advertisedTools(tools, undefined)).toBe(tools);
  });

  it("hides deferred-and-unactivated tools but keeps non-deferred ones", () => {
    const deferrable = bigSet(TOOL_DEFER_MIN_COUNT);
    const plan = planToolDisclosure({ deferrable, allToolNames: new Set() });
    expect(plan).not.toBeNull();
    const core: ExecutableTool = {
      name: "read",
      description: "read a file",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve("x"),
    };
    // The full executable set the loop holds: core + deferred + find_tools.
    const full = [core, ...deferrable, plan?.findTool].filter(
      (t): t is ExecutableTool => t !== undefined,
    );
    const advertised = advertisedTools(full, plan ?? undefined).map((t) => t.name);
    expect(advertised).toContain("read");
    expect(advertised).toContain(FIND_TOOLS_NAME);
    for (const t of deferrable) expect(advertised).not.toContain(t.name);
  });

  it("reveals a tool once find_tools has activated it", async () => {
    const deferrable = bigSet(TOOL_DEFER_MIN_COUNT);
    const plan = planToolDisclosure({ deferrable, allToolNames: new Set() });
    const target = deferrable[0]?.name ?? "";
    await plan?.findTool.execute({ query: target });
    const advertised = advertisedTools(
      [...deferrable, plan?.findTool].filter((t): t is ExecutableTool => t !== undefined),
      plan ?? undefined,
    ).map((t) => t.name);
    expect(advertised).toContain(target);
    // Only the searched one is revealed; the rest stay deferred.
    expect(advertised).not.toContain(deferrable[1]?.name);
  });
});

describe("find_tools tool", () => {
  it("matches by name substring, activates the match, and returns its schema", async () => {
    const deferrable = [
      mcpTool("github__create_issue"),
      mcpTool("github__list_prs"),
      mcpTool("slack__post_message"),
      mcpTool("slack__list_channels"),
      mcpTool("jira__create_ticket"),
    ];
    const plan = planToolDisclosure({ deferrable, allToolNames: new Set() });
    const out = await plan?.findTool.execute({ query: "slack" });
    expect(out).toContain("slack__post_message");
    expect(out).toContain("slack__list_channels");
    expect(out).toContain("input schema");
    expect(out).not.toContain("github__create_issue");
    // Activation is a side effect on the shared set the loop reads.
    expect(plan?.activated.has("slack__post_message")).toBe(true);
    expect(plan?.activated.has("github__create_issue")).toBe(false);
  });

  it("matches by description substring", async () => {
    const deferrable = bigSet(TOOL_DEFER_MIN_COUNT);
    // Rename one description to carry a searchable keyword.
    deferrable[2] = {
      ...mcpTool("srv__weird"),
      description: "d".repeat(4000) + " kubernetes deploy",
    };
    const plan = planToolDisclosure({ deferrable, allToolNames: new Set() });
    const out = await plan?.findTool.execute({ query: "kubernetes" });
    expect(out).toContain("srv__weird");
    expect(plan?.activated.has("srv__weird")).toBe(true);
  });

  it("an empty query lists (and activates) all tools", async () => {
    const deferrable = bigSet(TOOL_DEFER_MIN_COUNT);
    const plan = planToolDisclosure({ deferrable, allToolNames: new Set() });
    await plan?.findTool.execute({});
    for (const t of deferrable) expect(plan?.activated.has(t.name)).toBe(true);
  });

  it("reports no match without activating anything", async () => {
    const deferrable = bigSet(TOOL_DEFER_MIN_COUNT);
    const plan = planToolDisclosure({ deferrable, allToolNames: new Set() });
    const out = await plan?.findTool.execute({ query: "no-such-tool-xyz" });
    expect(out).toContain("No tools matched");
    expect(plan?.activated.size).toBe(0);
  });

  it("caps how many tools one broad search loads and says how many more matched", async () => {
    // 15 matching tools, each big enough that the set clears the char threshold.
    const deferrable = Array.from({ length: 15 }, (_, i) => mcpTool(`srv__t${String(i)}`, 1300));
    const plan = planToolDisclosure({ deferrable, allToolNames: new Set() });
    const out = (await plan?.findTool.execute({ query: "srv" })) ?? "";
    // The cap is 12; the remaining 3 are reported, not silently dropped.
    expect(plan?.activated.size).toBe(12);
    expect(out).toContain("3 more");
  });
});
