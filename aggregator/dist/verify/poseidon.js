import { buildPoseidon } from "circomlibjs";
const STATE_SIZE = 5;
const RATE = 4;
const CAPACITY = 1;
const OUTPUT_POSITION = 1;
export const BN254_FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
let cached = null;
async function instance() {
    if (!cached) {
        cached = (await buildPoseidon());
    }
    return cached;
}
export async function poseidonSponge(msg) {
    const poseidon = await instance();
    const F = poseidon.F;
    let state = new Array(STATE_SIZE).fill(0n);
    let i = 0;
    const permute = () => {
        const rateInputs = state.slice(CAPACITY).map((b) => F.e(b));
        const capInit = F.e(state[0]);
        const permuted = poseidon(rateInputs, capInit, STATE_SIZE);
        state = permuted.map((f) => F.toObject(f));
    };
    for (const m of msg) {
        const idx = CAPACITY + i;
        state[idx] = (state[idx] + m) % BN254_FIELD_SIZE;
        i++;
        if (i === RATE) {
            permute();
            i = 0;
        }
    }
    if (i !== 0) {
        permute();
    }
    return state[OUTPUT_POSITION];
}
export async function hashN(inputs) {
    if (inputs.length < 1 || inputs.length > 16) {
        throw new Error(`hashN supports 1..16 inputs, got ${inputs.length}`);
    }
    const poseidon = await instance();
    const F = poseidon.F;
    const result = poseidon(inputs.map((b) => F.e(b)));
    return F.toObject(result);
}
