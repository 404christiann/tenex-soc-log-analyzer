import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * `proxy.ts` already redirects every request to `/` (authenticated ->
 * `/dashboard`, unauthenticated -> `/login`) before this ever renders — this
 * is defense-in-depth in case that matcher is ever narrowed, not the
 * primary routing mechanism.
 */
export default async function RootPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? "/dashboard" : "/login");
}
