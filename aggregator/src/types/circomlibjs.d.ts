/**
 * Minimal ambient declaration for circomlibjs.
 *
 * Upstream package (iden3/circomlibjs) ships no TypeScript types as of 2026-05.
 * Declared as `any` here — type safety enforced manually at usage sites
 * (see src/verify/poseidon.ts PoseidonFn / PoseidonF interfaces).
 *
 * When @types/circomlibjs becomes available — remove this file and install it.
 */
declare module "circomlibjs";
