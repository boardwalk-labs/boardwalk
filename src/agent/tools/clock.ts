// SPDX-License-Identifier: Apache-2.0

// The `clock` built-in: report the current date and time. ENGINE-NATIVE (no host, no workspace, no
// language server) and PURE — it reads the wall clock and formats it. It exists because the leaf is
// given no ambient date: the first message is `preamble + prompt`, with no system `<env>` block, so
// a model that needs "today" must ask for it rather than guess (and guessing is how an agent files
// something for the wrong year). It matters doubly under hold-and-pay: a run can `sleep` for hours
// or days and resume, so any date injected once at the start would be stale — a tool is always
// fresh.
//
// Read-only (it never mutates the workspace), so it joins the `"read-only"` built-in set. The clock
// is injected (`now`) so the tool is deterministic under test.

import { z } from "zod";
import { EngineError } from "../../errors.js";
import type { ExecutableTool } from "../tools.js";

const clockInput = z.object({ timezone: z.string().min(1).optional() });

/**
 * Build the `clock` tool. `now` is injected so tests pin a fixed instant; in production it is the
 * system wall clock. The engine forbids `Date.now()`/`new Date()` only in the orchestration SCRIPT
 * sandbox (determinism for resume) — engine-internal tool code reads the real clock freely.
 */
export function clockTool(now: () => Date = () => new Date()): ExecutableTool {
  return {
    name: "clock",
    description:
      "Return the current date and time: an ISO 8601 UTC timestamp, the Unix epoch in seconds, and " +
      'a human-readable local time. Pass `timezone` (an IANA name like "America/New_York") to ' +
      "render the local time in that zone; it defaults to UTC. Use this whenever you need today's " +
      "date or the current time — do not guess.",
    inputSchema: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description:
            'Optional IANA timezone name (e.g. "America/New_York", "Europe/London", "UTC") for the ' +
            "human-readable local time. Defaults to UTC.",
        },
      },
      additionalProperties: false,
    },
    // Pure + synchronous (like the memory file tools): returns a resolved Promise, and an invalid
    // timezone throws synchronously — the loop awaits execute() inside its tool-failure try/catch.
    execute: (input) => {
      const { timezone } = clockInput.parse(input);
      const tz = timezone ?? "UTC";
      const at = now();

      let local: string;
      try {
        local = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          dateStyle: "full",
          timeStyle: "long",
        }).format(at);
      } catch {
        // An unknown timeZone makes the formatter throw RangeError — surface it as the model's
        // mistake to correct, not an engine fault.
        throw new EngineError(
          "VALIDATION",
          `clock: "${tz}" is not a valid IANA timezone name.`,
          'Use a name like "America/New_York", "Europe/London", or "UTC".',
        );
      }

      return Promise.resolve(
        [
          `${at.toISOString()} (UTC, ISO 8601)`,
          `Unix epoch: ${String(Math.floor(at.getTime() / 1000))} seconds`,
          `${tz}: ${local}`,
        ].join("\n"),
      );
    },
  };
}
