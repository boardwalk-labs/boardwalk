// SPDX-License-Identifier: Apache-2.0

// The desktop-tier built-ins: screenshot/click/type/key/scroll/drag. Session-gated host-backed
// tools (the host supplies the desktop* hooks only for a leaf with a bound desktop session), raw
// screen coordinates only — grounding is the model's own trained GUI grounding, enforced per call
// by the platform's model gate, not by these tools.

import { EngineError } from "../../errors.js";
import type { ExecutableTool } from "../tools.js";
import type { ToolHost } from "./host_tools.js";

/** Names of the desktop-tier built-ins (whether or not a backend is present). */
export const DESKTOP_TOOL_NAMES: readonly string[] = [
  "screenshot",
  "click",
  "type",
  "key",
  "scroll",
  "drag",
];

const MOUSE_BUTTONS: readonly string[] = ["left", "right", "middle"];

/** Build the desktop tools whose hook the host actually provides (others stay unregistered). */
export function desktopTools(host: ToolHost | undefined): Map<string, ExecutableTool> {
  const tools = new Map<string, ExecutableTool>();
  if (host?.desktopScreenshot !== undefined) tools.set("screenshot", screenshotTool(host));
  if (host?.desktopClick !== undefined) tools.set("click", clickTool(host));
  if (host?.desktopType !== undefined) tools.set("type", typeTool(host));
  if (host?.desktopKey !== undefined) tools.set("key", keyTool(host));
  if (host?.desktopScroll !== undefined) tools.set("scroll", scrollTool(host));
  if (host?.desktopDrag !== undefined) tools.set("drag", dragTool(host));
  return tools;
}

function screenshotTool(host: ToolHost): ExecutableTool {
  const screenshot = host.desktopScreenshot;
  if (screenshot === undefined) throw unreachable("screenshot");
  return {
    name: "screenshot",
    description:
      "Capture the desktop screen and see it. Click/scroll/drag coordinates are pixels in this " +
      "image (origin top-left). Take a fresh screenshot after actions that change the screen.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const shot = await screenshot();
      const caption = `Screenshot captured (${String(shot.width)}x${String(shot.height)}).`;
      return {
        llmText: caption,
        content: [
          { type: "text", text: caption },
          { type: "file", file: { mimeType: "image/png", data: shot.data } },
        ],
        event: {
          kind: "screenshot",
          humanSummary: `screenshot ${String(shot.width)}x${String(shot.height)}`,
          data: {
            width: shot.width,
            height: shot.height,
            ...(shot.artifact !== undefined
              ? { artifactId: shot.artifact.id, name: shot.artifact.name, url: shot.artifact.url }
              : {}),
          },
        },
      };
    },
  };
}

function clickTool(host: ToolHost): ExecutableTool {
  const click = host.desktopClick;
  if (click === undefined) throw unreachable("click");
  return {
    name: "click",
    description: "Click at (x, y) on the screen (pixels from the latest screenshot).",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X pixel coordinate (origin top-left)." },
        y: { type: "number", description: "Y pixel coordinate (origin top-left)." },
        button: {
          type: "string",
          enum: [...MOUSE_BUTTONS],
          description: "Mouse button (default left).",
        },
        clicks: { type: "number", enum: [1, 2], description: "1 = single (default), 2 = double." },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const x = requireCoordinate(input, "x");
      const y = requireCoordinate(input, "y");
      const button = optionalButton(input["button"]);
      const clicks = optionalClicks(input["clicks"]);
      await click({
        x,
        y,
        ...(button !== undefined ? { button } : {}),
        ...(clicks !== undefined ? { clicks } : {}),
      });
      const verb = clicks === 2 ? "double-clicked" : `${button ?? "left"}-clicked`;
      return `${verb} (${String(x)}, ${String(y)})`;
    },
  };
}

function typeTool(host: ToolHost): ExecutableTool {
  const type = host.desktopType;
  if (type === undefined) throw unreachable("type");
  return {
    name: "type",
    description:
      "Type text at the current focus (click the target field first). `submit: true` presses Enter after.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to type." },
        submit: { type: "boolean", description: "Press Enter after typing (default false)." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const text = requireString(input, "text");
      const submit = optionalBoolean(input["submit"], "submit");
      await type({ text, ...(submit !== undefined ? { submit } : {}) });
      return `typed ${String(text.length)} character${text.length === 1 ? "" : "s"}${submit === true ? ", pressed Enter" : ""}`;
    },
  };
}

function keyTool(host: ToolHost): ExecutableTool {
  const key = host.desktopKey;
  if (key === undefined) throw unreachable("key");
  return {
    name: "key",
    description: 'Press a key or chord, e.g. "Enter", "Escape", "Meta+a", "Control+Shift+t".',
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "string", description: "Key name, or a +-joined chord." },
      },
      required: ["keys"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const keys = requireString(input, "keys");
      if (keys.trim() === "") {
        throw new EngineError("VALIDATION", `Tool input "keys" must be a non-empty key or chord.`);
      }
      await key(keys);
      return `pressed ${keys}`;
    },
  };
}

function scrollTool(host: ToolHost): ExecutableTool {
  const scroll = host.desktopScroll;
  if (scroll === undefined) throw unreachable("scroll");
  return {
    name: "scroll",
    description:
      "Scroll by (dx, dy) pixels — positive dy scrolls down. Optionally at a point (x, y).",
    inputSchema: {
      type: "object",
      properties: {
        dx: { type: "number", description: "Horizontal scroll amount (default 0)." },
        dy: { type: "number", description: "Vertical scroll amount (positive = down, default 0)." },
        x: { type: "number", description: "Optional pointer X before scrolling." },
        y: { type: "number", description: "Optional pointer Y before scrolling." },
      },
      additionalProperties: false,
    },
    execute: async (input) => {
      const dx = optionalDelta(input["dx"], "dx") ?? 0;
      const dy = optionalDelta(input["dy"], "dy") ?? 0;
      if (dx === 0 && dy === 0) {
        throw new EngineError("VALIDATION", "scroll: provide a non-zero `dx` and/or `dy`.");
      }
      const x = optionalCoordinate(input["x"], "x");
      const y = optionalCoordinate(input["y"], "y");
      await scroll({
        dx,
        dy,
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
      });
      return `scrolled (${String(dx)}, ${String(dy)})`;
    },
  };
}

function dragTool(host: ToolHost): ExecutableTool {
  const drag = host.desktopDrag;
  if (drag === undefined) throw unreachable("drag");
  return {
    name: "drag",
    description: "Press at `from`, move to `to`, release (pixels from the latest screenshot).",
    inputSchema: {
      type: "object",
      properties: {
        from: pointSchema("Start point."),
        to: pointSchema("End point."),
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const from = requirePoint(input, "from");
      const to = requirePoint(input, "to");
      await drag({ from, to });
      return `dragged (${String(from.x)}, ${String(from.y)}) to (${String(to.x)}, ${String(to.y)})`;
    },
  };
}

function pointSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: { x: { type: "number" }, y: { type: "number" } },
    required: ["x", "y"],
    additionalProperties: false,
  };
}

function unreachable(tool: string): EngineError {
  // desktopTools only builds a tool when its hook exists — belt-and-suspenders, like host_tools.
  return new EngineError("INTERNAL", `Built-in "${tool}" was built without its desktop backend.`);
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new EngineError("VALIDATION", `Tool input "${key}" must be a string.`);
  }
  return value;
}

/** A screen coordinate: a finite number ≥ 0 (fractional pixels are accepted and floored by drivers). */
function requireCoordinate(input: Record<string, unknown>, key: string): number {
  const value = optionalCoordinate(input[key], key);
  if (value === undefined) {
    throw new EngineError("VALIDATION", `Tool input "${key}" must be a number.`);
  }
  return value;
}

function optionalCoordinate(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new EngineError("VALIDATION", `Tool input "${key}" must be a number >= 0.`);
  }
  return value;
}

function optionalDelta(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EngineError("VALIDATION", `Tool input "${key}" must be a finite number.`);
  }
  return value;
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new EngineError("VALIDATION", `Tool input "${key}" must be a boolean.`);
  }
  return value;
}

function optionalButton(value: unknown): "left" | "right" | "middle" | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !MOUSE_BUTTONS.includes(value)) {
    throw new EngineError(
      "VALIDATION",
      `Tool input "button" must be one of ${MOUSE_BUTTONS.join(", ")}.`,
    );
  }
  return value as "left" | "right" | "middle";
}

function optionalClicks(value: unknown): 1 | 2 | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== 1 && value !== 2) {
    throw new EngineError("VALIDATION", `Tool input "clicks" must be 1 or 2.`);
  }
  return value;
}

function requirePoint(input: Record<string, unknown>, key: string): { x: number; y: number } {
  const value = input[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("VALIDATION", `Tool input "${key}" must be an object with x and y.`);
  }
  const record = value as Record<string, unknown>;
  return { x: pointCoordinate(record, key, "x"), y: pointCoordinate(record, key, "y") };
}

function pointCoordinate(record: Record<string, unknown>, parent: string, axis: "x" | "y"): number {
  const value = optionalCoordinate(record[axis], `${parent}.${axis}`);
  if (value === undefined) {
    throw new EngineError("VALIDATION", `Tool input "${parent}.${axis}" must be a number.`);
  }
  return value;
}
