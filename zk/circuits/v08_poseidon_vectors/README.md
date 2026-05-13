# Poseidon test vector generation (DEFERRED 2026-05-13)

## Status

**DEFERRED** — Phase 1 of Poseidon parameter freeze (test vector generation)
не завершений через ecosystem incompatibility.

## Що пробували

Створено мінімальний Nargo lib проект з `noir-lang/poseidon v0.1.1` як dependency
для виконання `nargo test --show-output` і captureу hash values для cross-language
consistency.

## Чому не зайшло

`noir-lang/poseidon v0.1.1` testovaний з Noir 1.0.0 stable, але у нас встановлений
Noir 1.0.0-beta.20. Внутрішній файл `src/poseidon2.nr` бібліотеки використовує
signature `std::poseidon2_permutation(state, 4)` (2 параметри) і `RATE` як runtime
constant — обидві speci змінилися у beta.20:
Хоча наш `lib.nr` використовує Poseidon (не Poseidon2), Nargo компілює всю
dependency, і поломаний `poseidon2.nr` блокує build.

## Untried options (для майбутньої сесії)

1. **noir-lang/poseidon main branch** — може містити fix для beta.20+
2. **TaceoLabs noir-poseidon** — інша library, але "permutation only" не повний hash
3. **Custom sponge implementation** — implement Poseidon manually у Noir, ~300 lines
4. **Downgrade Noir до 1.0.0 stable** — рискує сумісність з legacy v06 circuit
5. **Python-generated vectors** — тимчасова compromise, weak source of truth

## Що працює

Sceleton проекту (Nargo.toml + src/lib.nr) написаний correctly per current
Noir syntax — `use poseidon::poseidon::bn254;` path правильний для library API.
Тільки dependency version compatibility — issue.

При наступній спробі: оновити dependency version у Nargo.toml, нічого не міняти
у lib.nr.

## Залежний artifact

`docs/specs/poseidon_params.md` (v0.9) — committed з frozen параметрами і
TBD test vectors section. Promote до v1.0 коли Phase 1 успішно закрита.
