/**
 * Generate src/chain/abi.ts from forge artifacts.
 *
 * Run after any contract change:
 *   npm run abi:gen
 *
 * This is the single source of truth — DO NOT hand-edit src/chain/abi.ts.
 * The `as const` tail makes viem fully type-aware of all functions/events/errors.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

interface Source {
  exportName: string;
  artifactPath: string;
}

const SOURCES: Source[] = [
  {
    exportName: "V3_ABI",
    artifactPath:
      "contracts/out/EnergyProofRegistryV3.sol/EnergyProofRegistryV3.json",
  },
  {
    exportName: "DEVICE_REGISTRY_ABI",
    artifactPath: "contracts/out/DeviceRegistry.sol/DeviceRegistry.json",
  },
];

const HEADER = `/**
 * Auto-generated from forge artifacts by scripts/generate-abi.ts.
 * DO NOT EDIT BY HAND — re-run \`npm run abi:gen\` after contract changes.
 *
 * Source: contracts/out/<Contract>.sol/<Contract>.json
 */

`;

let body = HEADER;
let abiItemCount = 0;

for (const { exportName, artifactPath } of SOURCES) {
  const fullPath = resolve(REPO_ROOT, artifactPath);
  const raw = readFileSync(fullPath, "utf-8");
  const artifact = JSON.parse(raw) as { abi: unknown[] };
  if (!Array.isArray(artifact.abi)) {
    throw new Error(`${artifactPath} has no abi field`);
  }
  body += `export const ${exportName} = ${JSON.stringify(artifact.abi, null, 2)} as const;\n\n`;
  console.log(`  ${exportName}: ${artifact.abi.length} items`);
  abiItemCount += artifact.abi.length;
}

const outPath = resolve(__dirname, "../src/chain/abi.ts");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, body);

console.log(`\nGenerated ${outPath} (${abiItemCount} ABI items total)`);
