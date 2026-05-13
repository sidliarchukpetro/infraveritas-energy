"""Cross-language Poseidon consistency tests against Noir-generated vectors."""

import json
from pathlib import Path

import pytest

from hal.poseidon import poseidon_sponge, hash_n

VECTORS_PATH = Path(__file__).parent.parent.parent / "docs" / "specs" / "poseidon_test_vectors.json"


class TestHashN:
    """Verify hash_n matches Noir bn254::hash_N."""

    @pytest.mark.parametrize("inputs,expected_hex", [
        ([1], "0x29176100eaa962bdc1fe6c654d6a3c130e96a4d1168b33848b897dc502820133"),
        ([1, 2], "0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a"),
        ([1, 2, 3], "0x0e7732d89e6939c0ff03d5e58dab6302f3230e269dc5b968f725df34ab36d732"),
        (list(range(1, 17)), "0x16159a551cbb66108281a48099fff949ae08afd7f1f2ec06de2ffb96b919b765"),
    ])
    def test_matches_noir(self, inputs, expected_hex):
        assert hash_n(inputs) == int(expected_hex, 16)

    def test_rejects_zero_inputs(self):
        with pytest.raises(ValueError):
            hash_n([])

    def test_rejects_seventeen_inputs(self):
        with pytest.raises(ValueError):
            hash_n(list(range(17)))


class TestSponge:
    """Verify poseidon_sponge matches Noir bn254::sponge for variable lengths."""

    @pytest.mark.parametrize("length,expected_hex", [
        (4, "0x1148aaef609aa338b27dafd89bb98862d8bb2b429aceac47d86206154ffe053d"),
        (5, "0x046f72048d371ab8c2793248aee7aa80a56a4f990d4d21ca5424509a0d5c85c3"),
        (8, "0x2e7c4c9ffd716e467fea513abfe2eff37673fc8630f29490c2e8ded9da5f1ffb"),
        (17, "0x144cc38a94cf16102fe122079c1bb44bcbb2e0b17c221f3e9581d724e64fe85b"),
        (100, "0x0be93a637bdbf670fe1843f40c63122b7a6a9ec5b3c3a96e085f6a1e59b66856"),
    ])
    def test_matches_noir(self, length, expected_hex):
        msg = list(range(1, length + 1))
        assert poseidon_sponge(msg) == int(expected_hex, 16)

    def test_empty_msg(self):
        # Empty message: i=0, no permutations triggered, returns initial state[1]=0
        assert poseidon_sponge([]) == 0


class TestVectorsFromJSON:
    """Verify all vectors loaded from canonical JSON file match — protects JSON integrity."""

    @pytest.fixture(scope="class")
    def vectors(self):
        with open(VECTORS_PATH) as f:
            return json.load(f)["vectors"]

    def test_hash_n_from_json(self, vectors):
        for name in ["hash_1", "hash_2", "hash_3", "hash_16"]:
            entry = vectors[name]
            inputs = [int(x, 16) for x in entry["input"]]
            assert hash_n(inputs) == int(entry["output"], 16), f"{name} JSON mismatch"

    def test_sponge_from_json(self, vectors):
        for name in ["sponge_4", "sponge_5", "sponge_8", "sponge_17", "sponge_100"]:
            entry = vectors[name]
            msg = list(range(1, entry["input_length"] + 1))
            assert poseidon_sponge(msg) == int(entry["output"], 16), f"{name} JSON mismatch"
