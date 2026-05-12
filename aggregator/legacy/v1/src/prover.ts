import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';
import { SubmitPayload } from './types';

const execAsync = promisify(exec);

const CIRCUIT_DIR = path.resolve(__dirname, '../circuits/energy_v06');
const TARGET_DIR = path.join(CIRCUIT_DIR, 'target');
const PROVER_TOML_PATH = path.join(CIRCUIT_DIR, 'Prover.toml');

export interface ProofResult {
  proof: string;
  publicInputs: string[];
  generationTimeMs: number;
  totalEnergyMwh: number;
  coarseLat: number;
  coarseLon: number;
}

function generateProverToml(payload: SubmitPayload): string {
  const coarseLat = Math.floor(payload.lat / 10000);
  const coarseLon = Math.floor(payload.lon / 10000);

  const lines: string[] = [];
  lines.push(`device_id = "${payload.deviceId}"`);
  lines.push(`epoch_start_ts = "${payload.epochStartTs}"`);
  lines.push(`coarse_lat = "${coarseLat}"`);
  lines.push(`coarse_lon = "${coarseLon}"`);
  lines.push(`exact_lat = "${payload.lat}"`);
  lines.push(`exact_lon = "${payload.lon}"`);
  lines.push(`light_level = "${payload.lightLevel}"`);
  lines.push(`tamper_flag = "${payload.tamperFlag}"`);
  lines.push('');
  lines.push('readings = [');
  for (let i = 0; i < 100; i++) {
    const r = payload.readings[i];
    lines.push(`  ["${r.voltage_mv}", "${r.current_ma}"],`);
  }
  lines.push(']');
  return lines.join('\n');
}

export async function generateProof(payload: SubmitPayload): Promise<ProofResult> {
  const startTime = Date.now();

  if (payload.readings.length !== 100) {
    throw new Error(`Expected 100 readings, got ${payload.readings.length}`);
  }

  console.log(`  -> Writing Prover.toml for device=${payload.deviceId}, session=${payload.sessionId}`);
  const tomlContent = generateProverToml(payload);
  await fs.writeFile(PROVER_TOML_PATH, tomlContent);

  console.log(`  -> Running nargo execute`);
  let nargoOutput: string;
  try {
    const result = await execAsync(`cd ${CIRCUIT_DIR} && nargo execute`, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 60000
    });
    nargoOutput = result.stdout;
  } catch (error: any) {
    throw new Error(`nargo execute failed: ${error.message}`);
  }

  const energyMatch = nargoOutput.match(/Circuit output:\s*(\d+)/);
  if (!energyMatch) {
    throw new Error(`Could not parse Circuit output. stdout: ${nargoOutput.substring(0, 500)}`);
  }
  const totalEnergyMwh = parseInt(energyMatch[1]);

  const coarseLat = Math.floor(payload.lat / 10000);
  const coarseLon = Math.floor(payload.lon / 10000);

  console.log(`  -> Total energy: ${totalEnergyMwh} mWh, coarse GPS: (${coarseLat}, ${coarseLon})`);

  console.log(`  -> Running bb prove (EVM target)`);
  const cmd = `cd ${CIRCUIT_DIR} && bb prove -b ./target/energy_v06.json -w ./target/energy_v06.gz -t evm -o ./target`;
  try {
    const { stderr } = await execAsync(cmd, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 120000
    });
    if (stderr && !stderr.includes('warning')) {
      console.log(`  bb stderr: ${stderr.substring(0, 200)}`);
    }
  } catch (error: any) {
    throw new Error(`bb prove failed: ${error.message}`);
  }

  const proofPath = path.join(TARGET_DIR, 'proof');
  const publicInputsPath = path.join(TARGET_DIR, 'public_inputs');

  const proofBytes = await fs.readFile(proofPath);
  const publicInputsBytes = await fs.readFile(publicInputsPath);

  const proofHex = '0x' + proofBytes.toString('hex');

  const publicInputs: string[] = [];
  for (let i = 0; i < publicInputsBytes.length; i += 32) {
    const chunk = publicInputsBytes.slice(i, i + 32);
    publicInputs.push('0x' + chunk.toString('hex'));
  }

  const generationTimeMs = Date.now() - startTime;
  console.log(`  Proof generated in ${generationTimeMs}ms (${publicInputs.length} public inputs)`);

  return {
    proof: proofHex,
    publicInputs,
    generationTimeMs,
    totalEnergyMwh,
    coarseLat,
    coarseLon
  };
}