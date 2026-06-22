// SPDX-License-Identifier: Apache-2.0

// The ambient `<env>` context block prepended to the leaf preamble so the model knows "today"
// without spending a tool round-trip on the common case (scheduling, "is this overdue?", relative
// dates). It rides the SAME preamble channel as AGENTS.md/skills, so secret redaction covers it.
//
// CACHE-SAFE BY CONSTRUCTION:
//  - The leaf is append-only: the first user message (preamble + prompt) is built once and is the
//    stable cache prefix for the whole tool loop, so this date — fixed for the run's lifetime — is
//    byte-identical across every iteration. No intra-run cache churn.
//  - It is the LAST preamble block (placed adjacent to the already-volatile prompt), so the maximal
//    stable content (AGENTS.md/skills/memory) precedes it — forward-safe if the gateway ever splits
//    the message into per-block cache breakpoints.
//  - COARSE on purpose (calendar date, UTC, no time-of-day): stable for 24h and it never implies a
//    precision the run-start snapshot doesn't have. Precise/zoned time is the `clock` tool's job.
//
// Captured at run start: a held run that resumes days later carries a stale date here — which is
// exactly why `clock` exists (always fresh). The block points the model there when clock is present.

/** Render the ambient `<env>` block for a run starting at `now`. `hasClock` adds a pointer to the
 *  `clock` tool (only when that tool is actually in the call's tool set). Kept to one content line
 *  so it costs ~25 prompt tokens. */
export function buildEnvContext(now: Date, opts: { hasClock: boolean }): string {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(
    now,
  );
  const isoDate = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const dateLine = `Today's date is ${weekday}, ${isoDate} (UTC).`;
  const line = opts.hasClock
    ? `${dateLine} For the precise current time or another timezone, use the \`clock\` tool.`
    : dateLine;
  return `<env>\n${line}\n</env>`;
}
