// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import { chatBedrock } from "./bedrock.js";
import type { ChatArgs, ProviderIo } from "./providers.js";

const AWS: ChatArgs["aws"] = {
  region: "us-east-1",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

function baseArgs(overrides: Partial<ChatArgs> = {}): ChatArgs {
  return {
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    apiKey: null,
    headers: {},
    model: "anthropic.claude-sonnet-4-5-v1:0",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    aws: AWS,
    ...overrides,
  };
}

/** Capture the request the adapter makes, scripting one or more responses in order. */
function recordingFetch(responses: Response[]): {
  io: ProviderIo;
  requests: { url: string; headers: Headers; body: string }[];
} {
  const requests: { url: string; headers: Headers; body: string }[] = [];
  let call = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    const res = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (res === undefined) throw new Error("no response scripted");
    // Response bodies are single-use; clone so a retry can read its own copy.
    return Promise.resolve(res.clone());
  };
  return { io: { fetchImpl, sleepImpl: () => Promise.resolve() }, requests };
}

function anthropicJson(body: object): Response {
  return Response.json(body);
}

describe("chatBedrock", () => {
  it("posts an InvokeModel request: URL has the encoded model id, SigV4 headers are present", async () => {
    const { io, requests } = recordingFetch([
      anthropicJson({
        content: [{ type: "text", text: "hi there" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 4 },
      }),
    ]);
    const deltas: string[] = [];
    const turn = await chatBedrock(baseArgs(), { ...io, onDelta: (t) => deltas.push(t) });

    expect(requests).toHaveLength(1);
    const req = requests[0];
    if (req === undefined) throw new Error("no request recorded");
    // Model id rides in the path, percent-encoded (the colon in the id must not break the URL).
    expect(req.url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/" +
        "anthropic.claude-sonnet-4-5-v1%3A0/invoke",
    );
    // SigV4: a well-formed Authorization with the bedrock service scope, plus the timestamp header.
    const auth = req.headers.get("authorization") ?? "";
    expect(auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=\S+, Signature=[0-9a-f]{64}$/,
    );
    expect(auth).toContain("SignedHeaders=content-type;host;x-amz-date");
    expect(req.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(req.headers.get("content-type")).toBe("application/json");
    // No security token header when none is configured.
    expect(req.headers.get("x-amz-security-token")).toBeNull();
    // Body is the Anthropic Messages body WITHOUT model and WITH the bedrock anthropic_version.
    const parsedBody: unknown = JSON.parse(req.body);
    expect(parsedBody).toMatchObject({
      anthropic_version: "bedrock-2023-05-31",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    expect(parsedBody).not.toHaveProperty("model");

    // Response parses into the ChatTurn; text is emitted once via onDelta (v1 non-streaming).
    expect(turn.text).toBe("hi there");
    expect(turn.toolCalls).toEqual([]);
    expect(turn.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
    expect(turn.wantsTools).toBe(false);
    expect(deltas).toEqual(["hi there"]);
  });

  it("surfaces a thinking block via onReasoningDelta, keeping it out of the answer text", async () => {
    const { io } = recordingFetch([
      anthropicJson({
        content: [
          { type: "thinking", thinking: "weighing the options" },
          { type: "text", text: "the answer" },
        ],
        stop_reason: "end_turn",
      }),
    ]);
    const deltas: string[] = [];
    const reasoning: string[] = [];
    const turn = await chatBedrock(baseArgs(), {
      ...io,
      onDelta: (t) => deltas.push(t),
      onReasoningDelta: (t) => reasoning.push(t),
    });
    expect(turn.text).toBe("the answer");
    expect(deltas).toEqual(["the answer"]);
    expect(reasoning).toEqual(["weighing the options"]);
  });

  it("signs in the session token when temporary credentials are present", async () => {
    const { io, requests } = recordingFetch([
      anthropicJson({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
    ]);
    await chatBedrock(
      baseArgs({ aws: { ...AWS, sessionToken: "FwoGZXIvYXdz-EXAMPLE-TOKEN" } }),
      io,
    );
    const req = requests[0];
    if (req === undefined) throw new Error("no request recorded");
    expect(req.headers.get("x-amz-security-token")).toBe("FwoGZXIvYXdz-EXAMPLE-TOKEN");
    expect(req.headers.get("authorization")).toContain(
      "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token",
    );
  });

  it("parses a tool_use response into ChatTurn tool calls with usage and wantsTools", async () => {
    const { io } = recordingFetch([
      anthropicJson({
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "toolu_1", name: "search", input: { query: "weather" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 30, output_tokens: 9 },
      }),
    ]);
    const turn = await chatBedrock(
      baseArgs({
        tools: [{ name: "search", description: "search the web", inputSchema: { type: "object" } }],
      }),
      io,
    );
    expect(turn.text).toBe("let me check");
    expect(turn.toolCalls).toEqual([
      { id: "toolu_1", name: "search", input: { query: "weather" } },
    ]);
    expect(turn.usage).toEqual({ inputTokens: 30, outputTokens: 9 });
    expect(turn.wantsTools).toBe(true);
  });

  it("maps a non-OK Bedrock response to a PROVIDER_ERROR (4xx does not retry)", async () => {
    const { io } = recordingFetch([
      new Response("AccessDeniedException: not authorized", { status: 403 }),
    ]);
    await expect(chatBedrock(baseArgs(), io)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  it("malformed (non-Anthropic-shaped) JSON fails with PROVIDER_ERROR", async () => {
    const { io } = recordingFetch([anthropicJson({ content: [{ type: 1 }] })]);
    await expect(chatBedrock(baseArgs(), io)).rejects.toBeInstanceOf(EngineError);
  });

  it("fails INTERNAL if invoked without AWS credentials (a wiring bug, not user input)", async () => {
    const { io } = recordingFetch([anthropicJson({ content: [] })]);
    await expect(chatBedrock(baseArgs({ aws: undefined }), io)).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });
});
