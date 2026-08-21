import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `@tenex/shared` is consumed as raw TypeScript from the workspace (no
  // build step) — this opts it into Next's compilation instead of treating
  // it as pre-built runtime code. See packages/shared and DECISIONS.md §12.
  transpilePackages: ["@tenex/shared"],
};

export default nextConfig;
