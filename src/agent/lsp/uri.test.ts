// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { fileUriToPath } from "./uri.js";

describe("fileUriToPath", () => {
  it("decodes a file URI to a path, including percent-encoded segments", () => {
    expect(fileUriToPath("file:///ws/a.ts")).toBe("/ws/a.ts");
    expect(fileUriToPath("file:///ws/my%20dir/a.ts")).toBe("/ws/my dir/a.ts");
  });

  it("passes through anything that is not a file URI", () => {
    // Rendering the server's raw string beats rendering nothing when it sends something unexpected.
    expect(fileUriToPath("untitled:Untitled-1")).toBe("untitled:Untitled-1");
    expect(fileUriToPath("")).toBe("");
  });

  it("returns the input unchanged when the URI will not parse", () => {
    expect(fileUriToPath("file://[bad")).toBe("file://[bad");
  });
});
