// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "./errors.js";
import { loadWorkflowPackage } from "./workflow_package.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function makePackage(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-wfpkg-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const DESCRIPTOR = `{
  // identity
  "slug": "hello",
  "triggers": [{ "kind": "manual" },],
}`;

const PROGRAM = `export default async function run() { return "hi"; }`;

function expectValidation(fn: () => unknown, match: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(EngineError);
  if (thrown instanceof EngineError) {
    expect(thrown.code).toBe("VALIDATION");
    expect(`${thrown.message} ${thrown.hint ?? ""}`).toMatch(match);
  }
}

describe("loadWorkflowPackage", () => {
  it("loads descriptor (JSONC), default entry, skills dir, and AGENTS.md", () => {
    const dir = makePackage({
      "workflow.jsonc": DESCRIPTOR,
      "index.mjs": PROGRAM,
      "skills/greet/SKILL.md": "# greet",
      "AGENTS.md": "Be terse.",
    });
    const pkg = loadWorkflowPackage(dir);
    expect(pkg.descriptor.slug).toBe("hello");
    expect(pkg.program).toBe(PROGRAM);
    expect(pkg.entryFile).toBe("index.mjs");
    expect(pkg.skillsSourceDir).toBe(join(dir, "skills"));
    expect(pkg.agentsMd).toBe("Be terse.");
    expect(pkg.descriptorText).toBe(DESCRIPTOR);
  });

  it("accepts strict-JSON workflow.json and omits absent artifacts", () => {
    const dir = makePackage({
      "workflow.json": JSON.stringify({ slug: "plain", triggers: [{ kind: "manual" }] }),
      "index.js": PROGRAM,
    });
    const pkg = loadWorkflowPackage(dir);
    expect(pkg.descriptor.slug).toBe("plain");
    expect(pkg.entryFile).toBe("index.js");
    expect(pkg.skillsSourceDir).toBeUndefined();
    expect(pkg.agentsMd).toBeUndefined();
  });

  it("prefers index.mjs over index.js when both exist", () => {
    const dir = makePackage({
      "workflow.jsonc": DESCRIPTOR,
      "index.mjs": PROGRAM,
      "index.js": "export default async function run() { return 'wrong file'; }",
    });
    expect(loadWorkflowPackage(dir).entryFile).toBe("index.mjs");
  });

  it("resolves a declared entry path", () => {
    const dir = makePackage({
      "workflow.jsonc": JSON.stringify({
        slug: "nested",
        entry: "dist/main.mjs",
        triggers: [{ kind: "manual" }],
      }),
      "dist/main.mjs": PROGRAM,
    });
    const pkg = loadWorkflowPackage(dir);
    expect(pkg.entryFile).toBe("dist/main.mjs");
    expect(pkg.program).toBe(PROGRAM);
  });

  it("both workflow.jsonc AND workflow.json is an error", () => {
    const dir = makePackage({
      "workflow.jsonc": DESCRIPTOR,
      "workflow.json": DESCRIPTOR,
      "index.mjs": PROGRAM,
    });
    expectValidation(() => loadWorkflowPackage(dir), /BOTH workflow\.jsonc and workflow\.json/);
  });

  it("a missing descriptor is an error naming the file to add", () => {
    const dir = makePackage({ "index.mjs": PROGRAM });
    expectValidation(() => loadWorkflowPackage(dir), /workflow\.jsonc/);
  });

  it("a malformed descriptor is a VALIDATION error naming the directory", () => {
    const dir = makePackage({
      "workflow.jsonc": JSON.stringify({ slug: "bad", triggers: [], nonsense: 1 }),
      "index.mjs": PROGRAM,
    });
    expectValidation(() => loadWorkflowPackage(dir), /descriptor validation/);
  });

  it("a missing entry module is an error pointing at boardwalk build", () => {
    const dir = makePackage({ "workflow.jsonc": DESCRIPTOR });
    expectValidation(() => loadWorkflowPackage(dir), /index\.mjs/);
  });

  it("a declared entry that does not exist is an error", () => {
    const dir = makePackage({
      "workflow.jsonc": JSON.stringify({
        slug: "ghost-entry",
        entry: "dist/main.mjs",
        triggers: [{ kind: "manual" }],
      }),
      "index.mjs": PROGRAM,
    });
    expectValidation(() => loadWorkflowPackage(dir), /does not exist/);
  });

  it("a source (.ts) entry is refused — this engine runs built programs only", () => {
    const dir = makePackage({
      "workflow.jsonc": JSON.stringify({
        slug: "src-entry",
        entry: "src/index.ts",
        triggers: [{ kind: "manual" }],
      }),
      "src/index.ts": "export default async function run() {}",
    });
    expectValidation(() => loadWorkflowPackage(dir), /built/i);
  });
});
