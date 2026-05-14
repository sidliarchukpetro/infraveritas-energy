import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { getCompiledCircuit } from "./witness.js";
const EVM_OPTIONS = { verifierTarget: "evm" };
let cachedBb = null;
let cachedBackend = null;
async function getBb() {
    if (!cachedBb) {
        cachedBb = await Barretenberg.new();
    }
    return cachedBb;
}
async function getBackend() {
    if (!cachedBackend) {
        const circuit = getCompiledCircuit();
        const bb = await getBb();
        cachedBackend = new UltraHonkBackend(circuit.bytecode, bb);
    }
    return cachedBackend;
}
export async function generateProof(witness) {
    const backend = await getBackend();
    const { proof, publicInputs } = await backend.generateProof(witness, EVM_OPTIONS);
    if (publicInputs.length !== 9) {
        throw new Error(`Expected 9 external public inputs from bb.js, got ${publicInputs.length} ` +
            `(check circuit NUMBER_OF_PUBLIC_INPUTS - PAIRING_POINTS_SIZE = 17 - 8 = 9)`);
    }
    return { proof, publicInputs };
}
export async function verifyProofLocally(proof) {
    const backend = await getBackend();
    return backend.verifyProof({
        proof: proof.proof,
        publicInputs: proof.publicInputs,
    }, EVM_OPTIONS);
}
export async function destroyBackends() {
    if (cachedBb) {
        await cachedBb.destroy();
        cachedBb = null;
        cachedBackend = null;
    }
}
