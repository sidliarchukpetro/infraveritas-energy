import { ethers } from 'ethers';
import { REGISTRY_ABI } from './abi';
import * as dotenv from 'dotenv';

dotenv.config();

export async function submitProofOnChain(
  deviceId: number,
  epochStartTs: number,
  coarseLat: number,
  coarseLon: number,
  totalEnergyMwh: number,
  proof: string,
  publicInputs: string[]
): Promise<{ txHash: string; status: string }> {
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const contract = new ethers.Contract(
    process.env.CONTRACT_ADDRESS!,
    REGISTRY_ABI,
    wallet
  );

  console.log(`-> Submitting on-chain: device=${deviceId}, energy=${totalEnergyMwh} mWh, GPS=(${coarseLat}, ${coarseLon}), epoch=${epochStartTs}`);

  const proofBytes = proof.startsWith('0x') ? proof : '0x' + proof;

  const tx = await contract.submitProof(
    BigInt(deviceId),
    BigInt(epochStartTs),
    BigInt(coarseLat),
    BigInt(coarseLon),
    BigInt(totalEnergyMwh),
    proofBytes,
    publicInputs
  );

  console.log(`-> TX sent: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`-> Confirmed in block: ${receipt.blockNumber}`);

  return {
    txHash: tx.hash,
    status: receipt.status === 1 ? 'confirmed' : 'failed'
  };
}
