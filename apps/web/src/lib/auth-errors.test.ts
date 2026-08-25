import { AuthError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { getAuthErrorMessage } from "./auth-errors";

/**
 * Unit tests for `getAuthErrorMessage` (DECISIONS.md §7/§14d). Each case
 * builds a real `AuthError` with the literal message/status/code GoTrue
 * sends for that failure, so the assertions exercise the exact matching
 * logic the function runs against production errors.
 */
describe("getAuthErrorMessage", () => {
  it("maps the wrong-or-expired OTP error", () => {
    const error = new AuthError("Token has expired or is invalid", 403, "otp_expired");
    expect(getAuthErrorMessage(error)).toBe(
      "That code is incorrect or has expired — check the digits, or request a new code."
    );
  });

  it("maps an invalid email address", () => {
    const error = new AuthError("Unable to validate email address: invalid format", 400);
    expect(getAuthErrorMessage(error)).toBe("That doesn't look like a valid email address.");
  });

  it("maps the send-frequency / rate limit guard", () => {
    const error = new AuthError(
      "For security purposes, you can only request this after 42 seconds.",
      429
    );
    expect(getAuthErrorMessage(error)).toBe(
      "Too many attempts — please wait a moment and try again."
    );
  });

  it("maps the hourly email rate limit by message even without a 429 status", () => {
    const error = new AuthError("Email rate limit exceeded", 500);
    expect(getAuthErrorMessage(error)).toBe(
      "Too many attempts — please wait a moment and try again."
    );
  });

  it("maps signups-disabled", () => {
    const error = new AuthError("Signups not allowed for this instance", 422);
    expect(getAuthErrorMessage(error)).toBe("New sign-ups are currently disabled.");
  });

  it("maps a network/fetch failure", () => {
    const error = new AuthError("Failed to fetch", undefined);
    expect(getAuthErrorMessage(error)).toBe(
      "Couldn't reach the authentication service. Check your connection and try again."
    );
  });

  // The bug this covers: Supabase Auth's own literal error text when its
  // configured SMTP provider (Resend, per README.md §4b) fails server-side
  // to send the email — a hosted-infra problem, not a rate limit or bad
  // email, and previously leaked straight through the fallback `return
  // error.message` unmapped.
  it("maps the confirmation-email send failure to friendly, non-technical copy", () => {
    const error = new AuthError("Error sending confirmation email", 500, "unexpected_failure");
    expect(getAuthErrorMessage(error)).toBe(
      "We couldn't send your code right now — this is usually temporary. Please try again in a few minutes."
    );
  });

  it("maps the sibling magic-link send failure the same way", () => {
    const error = new AuthError("Error sending magic link email", 500, "unexpected_failure");
    expect(getAuthErrorMessage(error)).toBe(
      "We couldn't send your code right now — this is usually temporary. Please try again in a few minutes."
    );
  });

  it("maps the send failure case-insensitively", () => {
    const error = new AuthError("ERROR SENDING CONFIRMATION EMAIL", 500, "unexpected_failure");
    expect(getAuthErrorMessage(error)).toBe(
      "We couldn't send your code right now — this is usually temporary. Please try again in a few minutes."
    );
  });

  it("does not leak SMTP/Resend/Supabase infra details in the mapped copy", () => {
    const error = new AuthError("Error sending confirmation email", 500, "unexpected_failure");
    const message = getAuthErrorMessage(error);
    expect(message.toLowerCase()).not.toMatch(/smtp|resend|supabase|gotrue/);
  });

  it("falls back to the raw message for an unrecognized error", () => {
    const error = new AuthError("Database error updating user for confirmation", 500);
    expect(getAuthErrorMessage(error)).toBe("Database error updating user for confirmation");
  });

  it("does not misclassify other unexpected_failure errors as a send failure", () => {
    // Same GoTrue error code as the send failure, but an unrelated message —
    // regression guard for why this file matches on message, not on
    // `error.code === "unexpected_failure"` (that code is shared by many
    // unrelated internal errors).
    const error = new AuthError("Database error finding user", 500, "unexpected_failure");
    expect(getAuthErrorMessage(error)).toBe("Database error finding user");
  });
});
