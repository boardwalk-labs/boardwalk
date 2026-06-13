#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Thin launcher for `boardwalk-server` (SPEC §5). All real logic lives in compiled,
// type-checked, tested TypeScript (src/server_main.ts) — this shim only exists so npm `bin`
// and the Docker CMD share one entrypoint that resolves dist/ relative to the package.
import("../dist/server_main.js")
  .then((mod) => mod.main())
  .catch((err) => {
    // Boot failures are usually operator config mistakes: print the message (and the
    // EngineError hint when present), never a stack trace into engine internals.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`boardwalk-server: ${message}\n`);
    if (err !== null && typeof err === "object" && typeof err.hint === "string") {
      process.stderr.write(`  hint: ${err.hint}\n`);
    }
    process.exit(1);
  });
