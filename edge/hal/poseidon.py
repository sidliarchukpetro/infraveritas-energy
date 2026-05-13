"""Poseidon hash. Matches Noir v0.3.0 bn254::sponge bit-exact.

Spec: docs/specs/poseidon_params.md v1.1
Construction: t=5, rate=4, capacity=1, output[1].
"""

from circomlibpy.poseidon import PoseidonHash, MODUL

STATE_SIZE = 5
RATE = 4
CAPACITY = 1
OUTPUT_POSITION = 1
BN254_FIELD_SIZE = MODUL


def poseidon_sponge(msg: list[int]) -> int:
    """Poseidon sponge hash. Matches Noir bn254::sponge."""
    p = PoseidonHash()
    state = [0] * STATE_SIZE
    i = 0
    for k in range(len(msg)):
        state[CAPACITY + i] = (state[CAPACITY + i] + msg[k]) % MODUL
        i += 1
        if i == RATE:
            state = p._build_poseidon(RATE, STATE_SIZE, state[CAPACITY:], state[0])
            i = 0
    if i != 0:
        state = p._build_poseidon(RATE, STATE_SIZE, state[CAPACITY:], state[0])
    return state[OUTPUT_POSITION]


def hash_n(inputs: list[int]) -> int:
    """Fixed-size Poseidon for 1..16 inputs. Matches Noir bn254::hash_N."""
    n = len(inputs)
    if n < 1 or n > 16:
        raise ValueError(f"hash_n supports 1..16, got {n}")
    return PoseidonHash().hash(n, inputs)
