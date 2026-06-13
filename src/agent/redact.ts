// SPDX-License-Identifier: Apache-2.0

// Secret redaction for the agent() leaf.
//
// The invariant: secret VALUES live only in deterministic program code; everything bound for a
// model — prompts now, tool args/results/MCP traffic/skills/memory later — is scrubbed of every
// known secret value first, so prompt injection has nothing to exfiltrate. "Known" means every
// value the run has actually been handed: secrets.get results and provider API keys.

export class Redactor {
  private readonly values = new Map<string, string>(); // value → label

  /** Register a secret value under a label (its declared name). Short values are ignored —
   *  redacting 1–3 chars would shred ordinary text while protecting nothing. */
  add(label: string, value: string): void {
    if (value.length >= 4) this.values.set(value, label);
  }

  /** Scrub every registered value out of `text`, longest value first so substrings of a longer
   *  secret can't leave recoverable fragments behind. */
  redact(text: string): string {
    if (this.values.size === 0) return text;
    let out = text;
    const byLength = [...this.values.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [value, label] of byLength) {
      out = out.split(value).join(`[redacted:${label}]`);
    }
    return out;
  }
}
