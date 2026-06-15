// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildCanonicalRequest,
  buildStringToSign,
  credentialScope,
  deriveSigningKey,
  signRequest,
  toAmzDate,
  type SigningContext,
} from "./sigv4.js";

// The AWS-published SigV4 test suite "get-vanilla" vector — the canonical correctness anchor for
// any hand-rolled signer. Region/service/keys/date are the documented example values; the
// intermediate strings and final signature below are AWS's own known-good output.
const EXAMPLE_KEY_ID = "AKIDEXAMPLE";
const EXAMPLE_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const EXAMPLE_REGION = "us-east-1";
const EXAMPLE_SERVICE = "service";
const EXAMPLE_DATE = new Date("2015-08-30T12:36:00Z");
const EXAMPLE_AMZ_DATE = "20150830T123600Z";

describe("SigV4 — AWS get-vanilla test vectors", () => {
  it("formats the x-amz-date in ISO basic UTC", () => {
    expect(toAmzDate(EXAMPLE_DATE)).toBe(EXAMPLE_AMZ_DATE);
  });

  it("derives the documented credential scope", () => {
    expect(credentialScope("20150830", EXAMPLE_REGION, EXAMPLE_SERVICE)).toBe(
      "20150830/us-east-1/service/aws4_request",
    );
  });

  it("builds the canonical request matching the AWS example", () => {
    const url = new URL("https://example.amazonaws.com/");
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest("GET", url, {
      headers: { host: "example.amazonaws.com", "x-amz-date": EXAMPLE_AMZ_DATE },
      body: "",
    });
    expect(signedHeaders).toBe("host;x-amz-date");
    expect(canonicalRequest).toBe(
      "GET\n" +
        "/\n" +
        "\n" +
        "host:example.amazonaws.com\n" +
        "x-amz-date:20150830T123600Z\n" +
        "\n" +
        "host;x-amz-date\n" +
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("builds the string-to-sign matching the AWS example", () => {
    const url = new URL("https://example.amazonaws.com/");
    const { canonicalRequest } = buildCanonicalRequest("GET", url, {
      headers: { host: "example.amazonaws.com", "x-amz-date": EXAMPLE_AMZ_DATE },
      body: "",
    });
    const stringToSign = buildStringToSign(
      EXAMPLE_AMZ_DATE,
      credentialScope("20150830", EXAMPLE_REGION, EXAMPLE_SERVICE),
      canonicalRequest,
    );
    expect(stringToSign).toBe(
      "AWS4-HMAC-SHA256\n" +
        "20150830T123600Z\n" +
        "20150830/us-east-1/service/aws4_request\n" +
        "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
    );
  });

  it("derives the documented signing key", () => {
    const key = deriveSigningKey(EXAMPLE_SECRET, "20150830", EXAMPLE_REGION, EXAMPLE_SERVICE);
    expect(key.toString("hex")).toBe(
      "9b3b06ce6b6366f283a9b9503888627337a037c7f2f66b419fbb30538acee4fb",
    );
  });

  it("produces the documented final signature + Authorization header via signRequest", () => {
    const ctx: SigningContext = {
      region: EXAMPLE_REGION,
      service: EXAMPLE_SERVICE,
      credentials: { accessKeyId: EXAMPLE_KEY_ID, secretAccessKey: EXAMPLE_SECRET },
      date: EXAMPLE_DATE,
    };
    const signed = signRequest(
      { method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: "" },
      ctx,
    );
    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 " +
        "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=ea21d6f05e96a897f6000a1a293f0a5bf0f92a00343409e820dce329ca6365ea",
    );
    // signRequest fills in the headers the signature commits to, so a caller can send them as-is.
    expect(signed.headers.host).toBe("example.amazonaws.com");
    expect(signed.headers["x-amz-date"]).toBe(EXAMPLE_AMZ_DATE);
    expect(signed.headers.authorization).toBe(signed.authorization);
  });
});

describe("SigV4 — Bedrock-shaped POST", () => {
  const ctx: SigningContext = {
    region: "us-east-1",
    service: "bedrock",
    credentials: { accessKeyId: EXAMPLE_KEY_ID, secretAccessKey: EXAMPLE_SECRET },
    date: EXAMPLE_DATE,
  };

  it("signs a POST body: content-type is in SignedHeaders and the payload hash is the body's", () => {
    const body = JSON.stringify({ anthropic_version: "bedrock-2023-05-31", messages: [] });
    const signed = signRequest(
      {
        method: "POST",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude/invoke",
        headers: { "content-type": "application/json" },
        body,
      },
      ctx,
    );
    // SignedHeaders is sorted, lower-cased, and includes the content-type we passed in.
    expect(signed.authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-date, Signature=",
    );
    expect(signed.headers.host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    // A signature commits to the body — a different body must produce a different signature.
    const other = signRequest(
      {
        method: "POST",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude/invoke",
        headers: { "content-type": "application/json" },
        body: body + " ",
      },
      ctx,
    );
    expect(other.authorization).not.toBe(signed.authorization);
  });

  it("signs in the session token and lists it in SignedHeaders when present", () => {
    const signed = signRequest(
      {
        method: "POST",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      { ...ctx, credentials: { ...ctx.credentials, sessionToken: "FwoGZXIvYXdz-EXAMPLE" } },
    );
    expect(signed.headers["x-amz-security-token"]).toBe("FwoGZXIvYXdz-EXAMPLE");
    expect(signed.authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=",
    );
  });
});
