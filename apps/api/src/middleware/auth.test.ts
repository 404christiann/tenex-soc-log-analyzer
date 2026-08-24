import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { SignJWT } from "jose";
import { requireAuth } from "./auth";

/**
 * Auth middleware unit tests (DECISIONS.md §7/§14a). Fully unit-testable
 * without a live Supabase project: `requireAuth` verifies the JWT purely
 * against `SUPABASE_JWT_SECRET` via `jose`, so a token signed here with a
 * known test secret exercises the exact same verification code path the
 * real middleware runs in production against a real Supabase-issued token.
 */

const TEST_SECRET = "test-secret-at-least-32-characters-long-for-hs256";
const ORIGINAL_SECRET = process.env.SUPABASE_JWT_SECRET;

beforeEach(() => {
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.SUPABASE_JWT_SECRET;
  } else {
    process.env.SUPABASE_JWT_SECRET = ORIGINAL_SECRET;
  }
});

function makeReq(authorizationHeader?: string): Request {
  return {
    headers: authorizationHeader ? { authorization: authorizationHeader } : {},
  } as unknown as Request;
}

function makeRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res as Response;
  });
  return res as Response & { statusCode?: number; body?: unknown };
}

async function signValidToken(overrides: { secret?: string; audience?: string; sub?: string; expiredSecondsAgo?: number } = {}): Promise<string> {
  const secret = new TextEncoder().encode(overrides.secret ?? TEST_SECRET);
  let builder = new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(overrides.sub ?? "11111111-1111-1111-1111-111111111111")
    .setIssuedAt()
    .setAudience(overrides.audience ?? "authenticated");

  if (overrides.expiredSecondsAgo !== undefined) {
    builder = builder.setExpirationTime(Math.floor(Date.now() / 1000) - overrides.expiredSecondsAgo);
  } else {
    builder = builder.setExpirationTime("1h");
  }

  return builder.sign(secret);
}

describe("requireAuth", () => {
  it("401s when the Authorization header is missing entirely", async () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(req, res, next as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    expect(next).not.toHaveBeenCalled();
  });

  it("401s when the header doesn't have a Bearer prefix", async () => {
    const req = makeReq("Basic dXNlcjpwYXNz");
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(req, res, next as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s on a malformed token (not a JWT at all)", async () => {
    const req = makeReq("Bearer this-is-not-a-jwt");
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(req, res, next as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s on an empty bearer token", async () => {
    const req = makeReq("Bearer ");
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(req, res, next as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s on a well-formed JWT signed with the WRONG secret (valid shape, invalid signature)", async () => {
    const token = await signValidToken({ secret: "a-completely-different-secret-value-32chars" });
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(req, res, next as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s on an expired token", async () => {
    const token = await signValidToken({ expiredSecondsAgo: 3600 });
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(req, res, next as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s on a token with the wrong audience", async () => {
    const token = await signValidToken({ audience: "some-other-audience" });
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(req, res, next as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() and attaches req.user/req.accessToken for a validly signed token", async () => {
    const token = await signValidToken({ sub: "22222222-2222-2222-2222-222222222222" });
    const req = makeReq(`Bearer ${token}`);
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(req, res, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toEqual({ id: "22222222-2222-2222-2222-222222222222" });
    expect(req.accessToken).toBe(token);
  });
});
