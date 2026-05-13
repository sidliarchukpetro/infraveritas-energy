//! Poseidon test vector generation for v08 cross-language consistency.
//!
//! Run: nargo test --show-output from this directory.
//! Outputs hash values for hash_1, hash_2, hash_3, hash_16 with deterministic inputs.
//! Values feed docs/specs/poseidon_test_vectors.json (Phase 1 of Poseidon freeze).

use poseidon::poseidon::bn254;

#[test]
fn print_hash_1() {
    let inputs: [Field; 1] = [1];
    let h = bn254::hash_1(inputs);
    println(f"hash_1([1]) = {h}");
}

#[test]
fn print_hash_2() {
    let inputs: [Field; 2] = [1, 2];
    let h = bn254::hash_2(inputs);
    println(f"hash_2([1, 2]) = {h}");
}

#[test]
fn print_hash_3() {
    let inputs: [Field; 3] = [1, 2, 3];
    let h = bn254::hash_3(inputs);
    println(f"hash_3([1, 2, 3]) = {h}");
}

#[test]
fn print_hash_16() {
    let inputs: [Field; 16] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    let h = bn254::hash_16(inputs);
    println(f"hash_16([1..16]) = {h}");
}

#[test]
fn print_sponge_5() {
    let msg: [Field; 5] = [1, 2, 3, 4, 5];
    let h = bn254::sponge(msg);
    println(f"sponge([1..5]) = {h}");
}

#[test]
fn print_sponge_4() {
    let msg: [Field; 4] = [1, 2, 3, 4];
    let h = bn254::sponge(msg);
    println(f"sponge_4 = {h}");
}

#[test]
fn print_sponge_8() {
    let msg: [Field; 8] = [1, 2, 3, 4, 5, 6, 7, 8];
    let h = bn254::sponge(msg);
    println(f"sponge_8 = {h}");
}

#[test]
fn print_sponge_17() {
    let mut msg: [Field; 17] = [0; 17];
    for i in 0..17 {
        msg[i] = i as Field + 1;
    }
    let h = bn254::sponge(msg);
    println(f"sponge_17 = {h}");
}

#[test]
fn print_sponge_100() {
    let mut msg: [Field; 100] = [0; 100];
    for i in 0..100 {
        msg[i] = i as Field + 1;
    }
    let h = bn254::sponge(msg);
    println(f"sponge_100 = {h}");
}
