"use client";

/**
 * Auth-page-scoped styling primitives.
 *
 * The reference design for /login (flat white page, large rounded inputs
 * with placeholder-as-label, vivid blue primary button) deliberately
 * diverges from the app-wide design system (compact h-8 controls, deep
 * slate-blue primary). Rather than mutating the global Input/Button
 * primitives — which would restyle the dashboard and results screens —
 * these thin wrappers layer the auth look on top of the shared components
 * via className overrides, so focus rings, disabled states, and
 * aria-invalid behavior stay consistent with the rest of the app.
 *
 * (The password-input wrapper that used to live here was removed with the
 * passwordless-OTP overhaul, DECISIONS.md §14d — there are no password
 * fields anywhere anymore.)
 */

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const fieldClasses =
  "h-auto rounded-[8px] border-slate-200 bg-white px-5 py-4 text-base text-slate-800 placeholder:text-slate-400 focus-visible:border-blue-600 focus-visible:ring-blue-600/20 md:text-base";

export function AuthInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return <Input className={cn(fieldClasses, className)} {...props} />;
}

const authButtonBase = "h-auto w-full rounded-[8px] px-5 py-4 text-base font-bold";

export function AuthPrimaryButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(authButtonBase, "bg-[#62d6e5] text-slate-800 hover:bg-[#53b6c3]", className)}
      {...props}
    />
  );
}
