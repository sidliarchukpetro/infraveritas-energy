# Poseidon test vector generation

**Status: COMPLETE 2026-05-13.** Vectors at `docs/specs/poseidon_test_vectors.json`. `docs/specs/poseidon_params.md` promoted to v1.0.

## Reproducing

```bash
cd zk/circuits/v08_poseidon_vectors
nargo test --show-output
```

## Configuration

```toml
[dependencies]
poseidon = { tag = "v0.3.0", git = "https://github.com/noir-lang/poseidon" }
```

## Story

- **v0.1.1** failed: `std::poseidon2_permutation` signature змінилася між Noir 1.0.0 stable і beta.20, тому `poseidon2.nr` всередині lib не компілюється. Хоча ми не викликаємо Poseidon2, Nargo компілює всю dependency.
- **v0.3.0** works: всі 4 test functions pass with Noir 1.0.0-beta.20.

Newer tags v0.2.x і v0.3.0 не були listed у GitHub README (де висів v0.1.1), знайшли через `git ls-remote --tags`.

## Next

Phase 2 (edge Python Poseidon migration) — blocked on this; **now unblocked**.
