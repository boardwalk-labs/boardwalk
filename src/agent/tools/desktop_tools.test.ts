// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { EngineError } from "../../errors.js";
import type { RichToolResult } from "../tools.js";
import type { ToolHost } from "./host_tools.js";
import { desktopTools, DESKTOP_TOOL_NAMES } from "./desktop_tools.js";

function fullDesktopHost(): ToolHost {
  return {
    desktopScreenshot: vi.fn().mockResolvedValue({
      data: "cGl4ZWxz",
      width: 1280,
      height: 800,
      artifact: { id: "art_1", name: "shot.png", url: "https://cdn/shot.png" },
    }),
    desktopClick: vi.fn().mockResolvedValue(undefined),
    desktopType: vi.fn().mockResolvedValue(undefined),
    desktopKey: vi.fn().mockResolvedValue(undefined),
    desktopScroll: vi.fn().mockResolvedValue(undefined),
    desktopDrag: vi.fn().mockResolvedValue(undefined),
  };
}

function tool(host: ToolHost, name: string) {
  const built = desktopTools(host).get(name);
  if (built === undefined) throw new Error(`tool ${name} not built`);
  return built;
}

describe("desktopTools gating", () => {
  it("no hooks (or no host) builds nothing", () => {
    expect(desktopTools(undefined).size).toBe(0);
    expect(desktopTools({}).size).toBe(0);
  });

  it("each tool registers iff its hook is present", () => {
    const host = fullDesktopHost();
    expect([...desktopTools(host).keys()].sort()).toEqual([...DESKTOP_TOOL_NAMES].sort());
    const partial: ToolHost = {
      desktopScreenshot: () => Promise.resolve({ data: "", width: 1, height: 1 }),
    };
    expect([...desktopTools(partial).keys()]).toEqual(["screenshot"]);
  });
});

describe("screenshot", () => {
  it("returns image content for the model + the artifact ref in event.data", async () => {
    const host = fullDesktopHost();
    const raw = (await tool(host, "screenshot").execute({})) as RichToolResult;
    expect(raw.llmText).toContain("1280x800");
    expect(raw.content).toEqual([
      { type: "text", text: "Screenshot captured (1280x800)." },
      { type: "file", file: { mimeType: "image/png", data: "cGl4ZWxz" } },
    ]);
    expect(raw.event.kind).toBe("screenshot");
    expect(raw.event.data).toEqual({
      width: 1280,
      height: 800,
      artifactId: "art_1",
      name: "shot.png",
      url: "https://cdn/shot.png",
    });
  });

  it("omits artifact fields when the host does not dual-sink", async () => {
    const host: ToolHost = {
      desktopScreenshot: vi.fn().mockResolvedValue({ data: "eA==", width: 10, height: 5 }),
    };
    const raw = (await tool(host, "screenshot").execute({})) as RichToolResult;
    expect(raw.event.data).toEqual({ width: 10, height: 5 });
  });
});

describe("click", () => {
  it("forwards coordinates and defaults, and reports the action", async () => {
    const host = fullDesktopHost();
    await expect(tool(host, "click").execute({ x: 10, y: 20 })).resolves.toBe(
      "left-clicked (10, 20)",
    );
    expect(host.desktopClick).toHaveBeenCalledWith({ x: 10, y: 20 });
    await expect(
      tool(host, "click").execute({ x: 1, y: 2, button: "right", clicks: 2 }),
    ).resolves.toBe("double-clicked (1, 2)");
    expect(host.desktopClick).toHaveBeenCalledWith({ x: 1, y: 2, button: "right", clicks: 2 });
  });

  it("rejects missing/negative coordinates, bad buttons, bad clicks", async () => {
    const host = fullDesktopHost();
    await expect(tool(host, "click").execute({ y: 3 })).rejects.toThrow(/"x" must be a number/);
    await expect(tool(host, "click").execute({ x: -1, y: 3 })).rejects.toThrow(/>= 0/);
    await expect(tool(host, "click").execute({ x: 1, y: 2, button: "back" })).rejects.toThrow(
      /left, right, middle/,
    );
    await expect(tool(host, "click").execute({ x: 1, y: 2, clicks: 3 })).rejects.toThrow(
      /must be 1 or 2/,
    );
    expect(host.desktopClick).not.toHaveBeenCalled();
  });
});

describe("type", () => {
  it("forwards text (+ submit) and reports a length, never echoing the text", async () => {
    const host = fullDesktopHost();
    await expect(tool(host, "type").execute({ text: "hunter2", submit: true })).resolves.toBe(
      "typed 7 characters, pressed Enter",
    );
    expect(host.desktopType).toHaveBeenCalledWith({ text: "hunter2", submit: true });
  });

  it("rejects a non-string text and a non-boolean submit", async () => {
    const host = fullDesktopHost();
    await expect(tool(host, "type").execute({})).rejects.toThrow(/"text" must be a string/);
    await expect(tool(host, "type").execute({ text: "a", submit: "yes" })).rejects.toThrow(
      /"submit" must be a boolean/,
    );
  });
});

describe("key", () => {
  it("forwards a chord", async () => {
    const host = fullDesktopHost();
    await expect(tool(host, "key").execute({ keys: "Control+Shift+t" })).resolves.toBe(
      "pressed Control+Shift+t",
    );
    expect(host.desktopKey).toHaveBeenCalledWith("Control+Shift+t");
  });

  it("rejects an empty chord", async () => {
    const host = fullDesktopHost();
    await expect(tool(host, "key").execute({ keys: "  " })).rejects.toThrow(/non-empty/);
  });
});

describe("scroll", () => {
  it("defaults the missing delta to 0 and forwards the optional point", async () => {
    const host = fullDesktopHost();
    await expect(tool(host, "scroll").execute({ dy: 120, x: 5, y: 6 })).resolves.toBe(
      "scrolled (0, 120)",
    );
    expect(host.desktopScroll).toHaveBeenCalledWith({ dx: 0, dy: 120, x: 5, y: 6 });
  });

  it("rejects a zero/absent scroll and non-finite deltas", async () => {
    const host = fullDesktopHost();
    await expect(tool(host, "scroll").execute({})).rejects.toThrow(/non-zero/);
    await expect(tool(host, "scroll").execute({ dx: 0, dy: 0 })).rejects.toThrow(/non-zero/);
    await expect(tool(host, "scroll").execute({ dy: Infinity })).rejects.toThrow(/finite/);
  });
});

describe("drag", () => {
  it("forwards both points", async () => {
    const host = fullDesktopHost();
    await expect(
      tool(host, "drag").execute({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }),
    ).resolves.toBe("dragged (1, 2) to (3, 4)");
    expect(host.desktopDrag).toHaveBeenCalledWith({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
  });

  it("rejects malformed points with the dotted path in the message", async () => {
    const host = fullDesktopHost();
    await expect(
      tool(host, "drag").execute({ from: { x: 1 }, to: { x: 3, y: 4 } }),
    ).rejects.toThrow(/"from\.y" must be a number/);
    await expect(tool(host, "drag").execute({ from: [1, 2], to: { x: 3, y: 4 } })).rejects.toThrow(
      /"from" must be an object/,
    );
  });

  it("validation failures are EngineError VALIDATION", async () => {
    const host = fullDesktopHost();
    try {
      await tool(host, "drag").execute({});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      expect(err instanceof EngineError ? err.code : "").toBe("VALIDATION");
    }
  });
});
