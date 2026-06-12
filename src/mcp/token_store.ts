// PARENT-side MCP OAuth token persistence. Tokens live with the engine — never in the run
// process beyond the single brokered value a request needs — in one JSON file under the data
// dir, mode 0600 (they are credentials; CODE_QUALITY §7.4 treats them like secrets: values
// never logged). Zod-validated on every read because a disk file is a trust boundary even
// when we wrote it.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { EngineError } from "../errors.js";

/** Where the store lives under the engine data dir (engine + supervisor must agree). */
export const MCP_TOKENS_FILENAME = "mcp_tokens.json";

const entrySchema = z.strictObject({
  /** The dynamically-registered OAuth client id this server's grants belong to. */
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** Epoch ms. Absent ⇒ the AS declared no expiry; the token is used until rejected. */
  expiresAt: z.number().int().positive().optional(),
  // Why these two travel with the tokens: silent refresh runs headless in the supervisor; it
  // must not depend on re-running discovery (a transient discovery failure would break runs
  // that hold a perfectly good refresh token).
  tokenEndpoint: z.string().min(1).optional(),
  /** The RFC 8707 resource indicator the grant was issued for. */
  resource: z.string().min(1).optional(),
});
export type McpTokenEntry = z.infer<typeof entrySchema>;

const fileSchema = z.record(z.string(), entrySchema);

/**
 * Canonicalize an MCP server URL for keying token state: the same server written with a
 * default port, trailing slash, or different case must hit the same entry — otherwise an
 * authorize under one spelling is invisible to a run using another.
 */
export function canonicalServerUrl(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new EngineError("VALIDATION", `"${serverUrl}" is not a valid MCP server URL.`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  // URL already lowercases the host and drops default ports from `host`.
  return `${url.protocol}//${url.host}${path}`;
}

export class McpTokenStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** The stored entry for a server, or null. `serverUrl` may be any spelling of the URL. */
  get(serverUrl: string): McpTokenEntry | null {
    return this.readAll()[canonicalServerUrl(serverUrl)] ?? null;
  }

  set(serverUrl: string, entry: McpTokenEntry): void {
    const all = this.readAll();
    all[canonicalServerUrl(serverUrl)] = entry;
    this.writeAll(all);
  }

  delete(serverUrl: string): void {
    const all = this.readAll();
    const key = canonicalServerUrl(serverUrl);
    if (key in all) {
      delete all[key];
      this.writeAll(all);
    }
  }

  private readAll(): Record<string, McpTokenEntry> {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return {}; // no file yet — nothing authorized
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw this.corruptError();
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) throw this.corruptError();
    return parsed.data;
  }

  private writeAll(all: Record<string, McpTokenEntry>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    // writeFileSync only applies `mode` on create — re-assert on every write so a file that
    // predates this code (or was touched externally) ends up locked down too.
    chmodSync(this.path, 0o600);
  }

  private corruptError(): EngineError {
    return new EngineError(
      "INTERNAL",
      `The MCP token store at ${this.path} is corrupt.`,
      "Delete the file and re-authorize the affected servers with engine.authorizeMcpServer.",
    );
  }
}
