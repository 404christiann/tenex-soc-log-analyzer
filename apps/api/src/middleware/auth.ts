import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Auth middleware (DECISIONS.md §14a "RLS enforcement — Option A" and §5's
 * "password hashing via Supabase Auth, not hand-rolled"). Extracts the
 * caller's `Authorization: Bearer <token>` header, verifies the JWT was
 * genuinely issued by this project's Supabase Auth instance, and attaches:
 *   - `req.user.id` — the authenticated user's id (JWT `sub` claim)
 *   - `req.accessToken` — the raw token, so route handlers can build a
 *     user-scoped Supabase client for RLS-enforced reads (`db/supabase.ts`)
 *
 * Verification approach — supports BOTH ways a Supabase project can sign
 * access tokens (discovered empirically while building this phase's
 * integration tests against a real local Supabase Auth instance, which
 * turned out to sign with the newer scheme by default):
 *   - Legacy: HS256, a shared secret (`SUPABASE_JWT_SECRET`, Project
 *     Settings > API > JWT Settings) — verified locally, no network call.
 *   - Current default for new projects ("JWT Signing Keys"): ES256/RS256
 *     asymmetric keys — verified against the project's public JWKS
 *     endpoint (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`), Supabase's
 *     own documented approach for this mode (no shared secret to leak).
 * The key resolver below picks the right path per-token from its protected
 * header's `alg`, so this middleware works unmodified against either kind
 * of project — never a decode-without-verify in either path, and both
 * verify signature + expiry (`exp`) + audience (`aud` must be
 * `"authenticated"`, which Supabase sets on every logged-in user's access
 * token). 401s with a clear JSON body on anything missing, malformed,
 * expired, or signed with the wrong key.
 */

declare module "express-serve-static-core" {
  interface Request {
    user?: { id: string };
    accessToken?: string;
  }
}

const BEARER_PREFIX = "Bearer ";
const EXPECTED_AUDIENCE = "authenticated";
const ACCEPTED_ALGORITHMS = ["HS256", "ES256", "RS256"];

function getHs256SecretKey(): Uint8Array {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new Error("SUPABASE_JWT_SECRET is not configured on the server.");
  }
  return new TextEncoder().encode(secret);
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksForUrl: string | null = null;

function getRemoteJwks(): ReturnType<typeof createRemoteJWKSet> {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl || supabaseUrl.trim().length === 0) {
    throw new Error("SUPABASE_URL is not configured on the server.");
  }
  if (!cachedJwks || cachedJwksForUrl !== supabaseUrl) {
    cachedJwks = createRemoteJWKSet(new URL(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`));
    cachedJwksForUrl = supabaseUrl;
  }
  return cachedJwks;
}

/**
 * Per-token key resolver passed to `jose.jwtVerify`: inspects the token's
 * own protected header (never client-supplied out-of-band) to decide
 * whether to verify against the local HS256 secret or the remote JWKS —
 * this is jose's documented pattern for supporting multiple signing
 * algorithms/keys, not a bypass of verification.
 */
const resolveVerificationKey: JWTVerifyGetKey = async (protectedHeader, token) => {
  if (protectedHeader.alg === "HS256") {
    return getHs256SecretKey();
  }
  return getRemoteJwks()(protectedHeader, token);
};

function unauthorized(res: Response, message: string): void {
  res.status(401).json({ error: message });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    unauthorized(res, "Missing or malformed Authorization header — expected 'Bearer <token>'.");
    return;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) {
    unauthorized(res, "Missing bearer token.");
    return;
  }

  try {
    const { payload } = await jwtVerify(token, resolveVerificationKey, {
      audience: EXPECTED_AUDIENCE,
      algorithms: ACCEPTED_ALGORITHMS,
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      unauthorized(res, "Token is missing a subject (user id) claim.");
      return;
    }

    req.user = { id: payload.sub };
    req.accessToken = token;
    next();
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      unauthorized(res, "Access token has expired.");
      return;
    }
    // Covers: bad signature, malformed compact JWS, wrong audience, wrong
    // algorithm, not-yet-valid (`nbf`), unresolvable JWKS `kid`, and
    // anything else jose/JWKS resolution rejects.
    unauthorized(res, "Invalid or expired access token.");
  }
}

/** Test-only hook: JWKS results are cached process-wide by jose's RemoteJWKSet; reset between test files that point at different Supabase instances. */
export function _resetJwksCacheForTests(): void {
  cachedJwks = null;
  cachedJwksForUrl = null;
}
