// SPDX-License-Identifier: Apache-2.0

// Build dist/ ONCE before any test worker starts: integration tests spawn the compiled child
// entry (dist/run/child.js) as a real process, and per-file builds in beforeAll race each
// other when vitest runs files in parallel workers.
import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  execSync("pnpm build", { cwd: dirname(fileURLToPath(import.meta.url)), stdio: "pipe" });
}
