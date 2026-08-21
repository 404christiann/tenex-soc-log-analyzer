// Confirms `@tenex/shared` (the Zod schemas / API types package) resolves and
// type-checks from apps/web via the npm workspace + `transpilePackages`
// wiring (see next.config.ts). Later phases import specific schemas directly
// where needed — this file is just the Phase 0 wiring proof, not app logic.
export * from "@tenex/shared";
