import { afterEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { describeAnthropicError, getAnthropicClient, isAnthropicConfigured } from "./client";

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  }
});

describe("isAnthropicConfigured", () => {
  it("is false when ANTHROPIC_API_KEY is unset", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(isAnthropicConfigured()).toBe(false);
  });

  it("is false when ANTHROPIC_API_KEY is empty/whitespace-only", () => {
    process.env.ANTHROPIC_API_KEY = "   ";
    expect(isAnthropicConfigured()).toBe(false);
  });

  it("is true when ANTHROPIC_API_KEY is set to a non-empty value", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    expect(isAnthropicConfigured()).toBe(true);
  });
});

describe("getAnthropicClient", () => {
  it("throws (rather than silently constructing a client) when not configured", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getAnthropicClient()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("constructs a client when configured", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    expect(() => getAnthropicClient()).not.toThrow();
  });
});

/** Builds a real SDK error instance via `.generate()` (as the SDK itself does internally) so `describeAnthropicError`'s `instanceof` chain is exercised against real classes, not hand-rolled lookalikes. */
function makeApiError(status: number, type: string, message: string) {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message } },
    message,
    new Headers(),
  );
}

describe("describeAnthropicError", () => {
  it("classifies authentication errors (401) without string-matching the message", () => {
    const err = makeApiError(401, "authentication_error", "invalid x-api-key");
    expect(err).toBeInstanceOf(Anthropic.AuthenticationError);
    expect(describeAnthropicError(err)).toMatch(/authentication/i);
  });

  it("classifies permission errors (403)", () => {
    const err = makeApiError(403, "permission_error", "no access");
    expect(describeAnthropicError(err)).toMatch(/permission/i);
  });

  it("classifies not-found errors (404)", () => {
    const err = makeApiError(404, "not_found_error", "no such model");
    expect(describeAnthropicError(err)).toMatch(/not found/i);
  });

  it("classifies rate limit errors (429)", () => {
    const err = makeApiError(429, "rate_limit_error", "slow down");
    expect(describeAnthropicError(err)).toMatch(/rate limit/i);
  });

  it("classifies server errors (5xx)", () => {
    const err = makeApiError(500, "api_error", "oops");
    expect(describeAnthropicError(err)).toMatch(/server error/i);
  });

  it("classifies request timeouts", () => {
    const err = new Anthropic.APIConnectionTimeoutError();
    expect(describeAnthropicError(err)).toMatch(/timed out/i);
  });

  it("classifies generic connection errors", () => {
    const err = new Anthropic.APIConnectionError({ message: "ECONNRESET" });
    expect(describeAnthropicError(err)).toMatch(/connection error/i);
  });

  it("falls back to the message for a plain Error", () => {
    expect(describeAnthropicError(new Error("schema validation failed"))).toBe("schema validation failed");
  });

  it("falls back to a generic message for a non-Error thrown value", () => {
    expect(describeAnthropicError("weird thrown string")).toMatch(/unknown error/i);
  });
});
