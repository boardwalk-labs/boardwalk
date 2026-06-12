import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import { canonicalServerUrl, McpTokenStore, type McpTokenEntry } from "./token_store.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempStore(): { store: McpTokenStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "bw-mcp-tokens-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "mcp_tokens.json");
  return { store: new McpTokenStore(path), path };
}

const ENTRY: McpTokenEntry = {
  clientId: "client-1",
  accessToken: "at-abc",
  refreshToken: "rt-def",
  expiresAt: 1_900_000_000_000,
  tokenEndpoint: "https://as.example.com/token",
  resource: "https://mcp.example.com/mcp",
};

describe("canonicalServerUrl", () => {
  it("normalizes case, default ports, and trailing slashes to one key", () => {
    const canonical = "https://mcp.example.com/v1/mcp";
    expect(canonicalServerUrl("HTTPS://MCP.Example.COM:443/v1/mcp/")).toBe(canonical);
    expect(canonicalServerUrl("https://mcp.example.com/v1/mcp")).toBe(canonical);
    // A NON-default port is identity-relevant and must survive.
    expect(canonicalServerUrl("https://mcp.example.com:8443/v1/mcp")).toBe(
      "https://mcp.example.com:8443/v1/mcp",
    );
  });

  it("rejects a non-URL loudly", () => {
    expect(() => canonicalServerUrl("not a url")).toThrowError(EngineError);
  });
});

describe("McpTokenStore", () => {
  it("round-trips an entry, keyed canonically (any URL spelling hits the same entry)", () => {
    const { store } = tempStore();
    store.set("https://MCP.Example.com:443/mcp/", ENTRY);
    expect(store.get("https://mcp.example.com/mcp")).toEqual(ENTRY);

    store.delete("https://mcp.example.com/mcp");
    expect(store.get("https://mcp.example.com/mcp")).toBeNull();
  });

  it("writes the file mode 0600 — tokens are credentials", () => {
    const { store, path } = tempStore();
    store.set("https://mcp.example.com/mcp", ENTRY);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // And keeps it 0600 across rewrites.
    store.set("https://other.example.com/mcp", { clientId: "c2", accessToken: "at-2" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("returns null for unknown servers and an empty store (no file yet)", () => {
    const { store } = tempStore();
    expect(store.get("https://mcp.example.com/mcp")).toBeNull();
  });

  it("a corrupt file fails loudly with a delete-and-reauthorize hint", () => {
    const { store, path } = tempStore();
    writeFileSync(path, "{ not json", "utf8");
    expect(() => store.get("https://mcp.example.com/mcp")).toThrow(/corrupt/);

    writeFileSync(path, JSON.stringify({ "https://x.example.com": { wrong: "shape" } }), "utf8");
    const error: unknown = (() => {
      try {
        store.get("https://mcp.example.com/mcp");
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(EngineError);
    expect(error instanceof EngineError ? (error.hint ?? "") : "").toContain("authorizeMcpServer");
  });
});
