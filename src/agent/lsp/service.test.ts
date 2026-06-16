// SPDX-License-Identifier: Apache-2.0

// LspService unit tests using a FAKE session (no real language server, so this runs in CI). They
// cover: extension→server routing, availability gating (binary absent → clean unavailable),
// session reuse across files, the workspace-wide diagnostics list, and close() shutting every
// session down.

import { describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "./client.js";
import type { LanguageServer } from "./registry.js";
import { LspService } from "./service.js";
import type { LspSession, SyncResult } from "./session.js";

/** A LspSession test double whose diagnostics are scripted; tracks open/close calls. */
class FakeSession {
  closed = false;
  syncs: string[] = [];
  constructor(private readonly scripted: Diagnostic[]) {}
  diagnostics(absolutePath: string): Promise<SyncResult> {
    this.syncs.push(absolutePath);
    return Promise.resolve({ available: true, diagnostics: this.scripted });
  }
  urisWithDiagnostics(): string[] {
    return this.scripted.length > 0 ? this.syncs.map((p) => `file://${p}`) : [];
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const ERROR_DIAG: Diagnostic = { line: 3, severity: "error", message: "boom", source: "ts 2304" };

function serviceWith(
  diagnostics: Diagnostic[],
  opts: { available?: boolean } = {},
): { service: LspService; created: FakeSession[] } {
  const created: FakeSession[] = [];
  const service = new LspService({
    workspaceDir: "/ws",
    isAvailable: () => opts.available ?? true,
    createSession: (_server: LanguageServer): LspSession => {
      const fake = new FakeSession(diagnostics);
      created.push(fake);
      // The service only calls diagnostics/urisWithDiagnostics/close — structurally compatible.
      return fake as unknown as LspSession;
    },
  });
  return { service, created };
}

describe("LspService", () => {
  it("supports() is true for a handled, installed extension and false otherwise", () => {
    const { service } = serviceWith([ERROR_DIAG]);
    expect(service.supports("/ws/a.ts")).toBe(true);
    expect(service.supports("/ws/notes.md")).toBe(false); // unhandled extension
  });

  it("supports() is false when the server binary is absent (best-effort gate)", () => {
    const { service } = serviceWith([ERROR_DIAG], { available: false });
    expect(service.supports("/ws/a.ts")).toBe(false);
  });

  it("returns diagnostics for a handled file", async () => {
    const { service } = serviceWith([ERROR_DIAG]);
    const result = await service.diagnostics("/ws/a.ts");
    expect(result.available).toBe(true);
    expect(result.diagnostics).toEqual([ERROR_DIAG]);
  });

  it("reports unavailable (never spawning) for an unhandled extension", async () => {
    const { service, created } = serviceWith([ERROR_DIAG]);
    const result = await service.diagnostics("/ws/notes.md");
    expect(result).toEqual({ available: false, diagnostics: [] });
    expect(created).toHaveLength(0);
  });

  it("reports unavailable when the server binary is absent — no session spawned", async () => {
    const { service, created } = serviceWith([ERROR_DIAG], { available: false });
    const result = await service.diagnostics("/ws/a.ts");
    expect(result).toEqual({ available: false, diagnostics: [] });
    expect(created).toHaveLength(0);
  });

  it("reuses ONE session across multiple files of the same language", async () => {
    const { service, created } = serviceWith([ERROR_DIAG]);
    await service.diagnostics("/ws/a.ts");
    await service.diagnostics("/ws/b.ts");
    expect(created).toHaveLength(1);
    expect(created[0]?.syncs).toEqual(["/ws/a.ts", "/ws/b.ts"]);
  });

  it("lists the workspace files the server currently reports diagnostics for", async () => {
    const { service } = serviceWith([ERROR_DIAG]);
    await service.diagnostics("/ws/a.ts");
    expect(service.filesWithDiagnostics("/ws/a.ts")).toEqual(["file:///ws/a.ts"]);
  });

  it("close() shuts every session down and is idempotent; later queries are unavailable", async () => {
    const { service, created } = serviceWith([ERROR_DIAG]);
    await service.diagnostics("/ws/a.ts");
    await service.close();
    await service.close(); // idempotent
    expect(created[0]?.closed).toBe(true);
    expect(await service.diagnostics("/ws/a.ts")).toEqual({ available: false, diagnostics: [] });
  });

  it("a session close failure never propagates out of the service close (best-effort teardown)", async () => {
    const service = new LspService({
      workspaceDir: "/ws",
      isAvailable: () => true,
      createSession: (): LspSession => {
        const stub = {
          diagnostics: () => Promise.resolve({ available: true, diagnostics: [] }),
          urisWithDiagnostics: () => [],
          close: vi.fn(() => Promise.reject(new Error("server stuck"))),
        };
        return stub as unknown as LspSession;
      },
    });
    await service.diagnostics("/ws/a.ts");
    await expect(service.close()).resolves.toBeUndefined();
  });
});
