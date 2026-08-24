import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UserNav } from "@/components/user-nav";

/**
 * Authenticated app shell (phase brief: "nav/header showing the signed-in
 * user's email, sign-out control"). `proxy.ts` already redirects
 * unauthenticated requests before this renders — the check here is
 * defense-in-depth, and it's also how this layout gets the user's email for
 * the nav without a client-side fetch/flicker.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/dashboard" className="flex items-center gap-2">
            <Image
              src="/tenex-logo.png"
              alt="Tenex logo"
              width={28}
              height={28}
              className="size-7 rounded-md"
              priority
            />
            <span className="text-sm font-semibold tracking-tight">Tenex SOC Log Analyzer</span>
          </Link>
          <div className="flex items-center gap-1">
            <UserNav email={user.email ?? "unknown"} />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
