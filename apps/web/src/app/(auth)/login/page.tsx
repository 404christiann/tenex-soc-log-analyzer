"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { clearStalePkceVerifierCookies, createClient } from "@/lib/supabase/client";
import { getAuthErrorMessage } from "@/lib/auth-errors";
import { AuthInput, AuthPrimaryButton } from "../_components/auth-ui";

/**
 * The single auth entry point (DECISIONS.md §14d — passwordless OTP, one
 * screen). Two steps within this one route:
 *
 *  1. "email" — enter an email address; `signInWithOtp` emails a 6-digit
 *     code. Its default `shouldCreateUser: true` transparently creates the
 *     account on first use, so there is no separate signup flow anywhere.
 *  2. "code"  — enter the code into a 6-box PIN input (shadcn `input-otp`
 *     for the interaction, Preline's OTP markup as the visual sizing spec);
 *     `verifyOtp` establishes the same Supabase session cookie the old
 *     password flow did, so everything downstream (proxy.ts, RLS, the API's
 *     Bearer tokens) is untouched.
 *
 * All code generation/expiry/verification/rate limiting is Supabase Auth's
 * built-in system — this page is UI over unmodified `signInWithOtp` /
 * `verifyOtp` calls, nothing custom (§14d Path A).
 */

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 30;

/** Preline-spec PIN box (§14d), mapped to this app's real tokens: bg-layer ->
 * white, border-layer-line -> slate-200, text-foreground -> slate-800, and
 * blue-600 as the focus/primary color like everywhere else. Separated
 * rounded boxes, not shadcn's default joined strip. */
const otpSlotClasses =
  "size-9.5 rounded-md border border-slate-200 bg-white text-sm text-slate-800 shadow-none " +
  "first:rounded-l-md last:rounded-r-md " +
  "data-[active=true]:border-blue-600 data-[active=true]:ring-[3px] data-[active=true]:ring-blue-600/20";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  // Tick the resend cooldown down once per second while it's active.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  async function sendCode(isResend: boolean) {
    setError(null);
    setInfo(null);
    setSending(true);

    const supabase = createClient();
    // Each `signInWithOtp` call starts a new PKCE flow with a new
    // code-verifier cookie, and the SDK never cleans up the previous flow's
    // cookie — abandoned flows (resends, navigate-away-and-retry) accumulate
    // until /login breaks with ERR_TOO_MANY_REDIRECTS. Only the newest
    // flow's verifier ever matters, so drop stale ones before every send
    // (this covers both the initial send and the resend path — both funnel
    // through here).
    clearStalePkceVerifierCookies();
    // Numeric-code mode: no `emailRedirectTo` (that's the magic-link-URL
    // variant); `shouldCreateUser` stays at its default `true`.
    const { error: sendError } = await supabase.auth.signInWithOtp({ email });

    setSending(false);
    if (sendError) {
      setError(getAuthErrorMessage(sendError));
      return;
    }

    setCode("");
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    if (isResend) {
      setInfo(`We sent a new code to ${email}.`);
    } else {
      setStep("code");
    }
  }

  async function handleEmailSubmit(e: FormEvent) {
    e.preventDefault();
    await sendCode(false);
  }

  async function verifyCode(token: string) {
    if (verifying) return;
    setError(null);
    setInfo(null);
    setVerifying(true);

    const supabase = createClient();
    const { error: verifyError } = await supabase.auth.verifyOtp({ email, token, type: "email" });

    if (verifyError) {
      setError(getAuthErrorMessage(verifyError));
      setCode("");
      setVerifying(false);
      return;
    }

    // Real session established (same cookie-based session as before —
    // client.ts/server.ts/middleware.ts are unchanged). Same post-login
    // behavior as the old password flow.
    const next = searchParams.get("next");
    router.push(next && next.startsWith("/") ? next : "/dashboard");
    router.refresh();
  }

  async function handleCodeSubmit(e: FormEvent) {
    e.preventDefault();
    if (code.length === CODE_LENGTH) {
      await verifyCode(code);
    }
  }

  function backToEmail() {
    setStep("email");
    setCode("");
    setError(null);
    setInfo(null);
  }

  const logo = (
    <Image
      src="/tenex-logo.png"
      alt="Tenex logo"
      width={48}
      height={48}
      className="mx-auto size-12 rounded-lg"
      priority
    />
  );

  if (step === "code") {
    return (
      <div>
        {logo}
        <h1 className="mt-6 text-center text-3xl font-bold text-slate-800">Check your email</h1>
        <p className="mt-3 text-center text-slate-500">
          We sent a 6-digit code to <span className="font-medium text-slate-800">{email}</span>.
        </p>
        <form onSubmit={handleCodeSubmit} className="mt-10 flex flex-col gap-4 sm:mt-12">
          {error && (
            <Alert variant="destructive" className="rounded-lg">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {info && (
            <Alert className="rounded-lg border-blue-200 bg-blue-50 text-blue-800">
              <AlertDescription className="text-blue-800">{info}</AlertDescription>
            </Alert>
          )}
          <InputOTP
            maxLength={CODE_LENGTH}
            pattern={REGEXP_ONLY_DIGITS}
            value={code}
            onChange={setCode}
            onComplete={(value: string) => void verifyCode(value)}
            disabled={verifying}
            autoFocus
            aria-label="6-digit code"
            containerClassName="justify-center"
          >
            {/* Preline reference: `flex justify-center gap-x-3` of six
                separate size-9.5 rounded boxes. */}
            <InputOTPGroup className="gap-x-3">
              {Array.from({ length: CODE_LENGTH }, (_, i) => (
                <InputOTPSlot key={i} index={i} className={otpSlotClasses} />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <div className="mt-4 flex flex-col gap-4">
            <AuthPrimaryButton type="submit" disabled={verifying || code.length !== CODE_LENGTH}>
              {verifying ? (
                <>
                  <Loader2 className="size-5 animate-spin" />
                  Verifying…
                </>
              ) : (
                "Verify code"
              )}
            </AuthPrimaryButton>
            <div className="flex items-center justify-center gap-6 text-sm">
              <button
                type="button"
                onClick={() => void sendCode(true)}
                disabled={sending || resendCooldown > 0}
                className="font-medium text-slate-800 underline underline-offset-4 hover:text-blue-600 disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline"
              >
                {resendCooldown > 0
                  ? `Resend code in ${resendCooldown}s`
                  : sending
                    ? "Sending…"
                    : "Resend code"}
              </button>
              <button
                type="button"
                onClick={backToEmail}
                className="text-slate-500 underline underline-offset-4 hover:text-blue-600"
              >
                Wrong email?
              </button>
            </div>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div>
      {logo}
      <h1 className="mt-6 text-center text-3xl font-bold text-slate-800">Sign in</h1>
      <p className="mt-3 text-center text-slate-500">
        Enter your email and we&apos;ll send you a 6-digit code to sign in. No password required.
      </p>
      <form onSubmit={handleEmailSubmit} className="mt-10 flex flex-col gap-4 sm:mt-12">
        {error && (
          <Alert variant="destructive" className="rounded-lg">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div>
          <label htmlFor="email" className="sr-only">
            Email
          </label>
          <AuthInput
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={sending}
            placeholder="Email"
          />
        </div>
        <div className="mt-4">
          <AuthPrimaryButton type="submit" disabled={sending}>
            {sending ? (
              <>
                <Loader2 className="size-5 animate-spin" />
                Sending code…
              </>
            ) : (
              "Send code"
            )}
          </AuthPrimaryButton>
        </div>
      </form>
    </div>
  );
}
