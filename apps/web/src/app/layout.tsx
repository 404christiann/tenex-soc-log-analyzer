import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tenex SOC Log Analyzer",
  description: "Upload a security log, get a parsed timeline, anomaly detection, and an AI-assisted summary.",
};

// `LayoutProps<"/">` (Next.js 16's generated-types helper, documented in
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/layout.md)
// only exists after `next dev`/`next build`/`next typegen` has run once —
// `tsc --noEmit` on a clean checkout fails before that. An explicit inline
// prop type has the same runtime behavior without depending on generated
// types being present.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <TooltipProvider delay={200}>
          {children}
          <Toaster />
        </TooltipProvider>
      </body>
    </html>
  );
}
