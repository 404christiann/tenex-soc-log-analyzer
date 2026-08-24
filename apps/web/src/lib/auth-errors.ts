import type { AuthError } from "@supabase/supabase-js";

/**
 * Supabase Auth's own `error.message` strings are already reasonably
 * human-readable, but this maps the common cases for the passwordless OTP
 * flow (DECISIONS.md §7's "clear error states", §14d's OTP overhaul) to
 * slightly friendlier copy and falls back to the raw message for anything
 * else — never a generic "something went wrong".
 */
export function getAuthErrorMessage(error: AuthError): string {
  const message = error.message.toLowerCase();

  // GoTrue's wrong-or-expired OTP error ("Token has expired or is invalid",
  // error code `otp_expired`) — the same message covers both cases, so the
  // copy has to as well.
  if (message.includes("token has expired or is invalid") || error.code === "otp_expired") {
    return "That code is incorrect or has expired — check the digits, or request a new code.";
  }
  if (message.includes("unable to validate email address") || message.includes("invalid email")) {
    return "That doesn't look like a valid email address.";
  }
  // GoTrue's send-frequency guard ("For security purposes, you can only
  // request this after N seconds") and the hourly email rate limit.
  if (
    message.includes("for security purposes") ||
    message.includes("email rate limit") ||
    error.status === 429
  ) {
    return "Too many attempts — please wait a moment and try again.";
  }
  if (message.includes("signups not allowed")) {
    return "New sign-ups are currently disabled.";
  }
  if (message.includes("fetch") || message.includes("network")) {
    return "Couldn't reach the authentication service. Check your connection and try again.";
  }

  return error.message;
}
