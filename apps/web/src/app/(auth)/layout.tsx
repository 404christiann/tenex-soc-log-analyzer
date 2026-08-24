export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-1 flex-col bg-white">
      {/* Hairline header border — the reference shows an empty header row closed off by a thin divider. */}
      <div className="h-12 shrink-0 border-b border-slate-200" aria-hidden />
      <div className="flex flex-1 items-start justify-center px-6 py-16 sm:py-24">
        <div className="w-full max-w-[440px]">{children}</div>
      </div>
    </div>
  );
}
