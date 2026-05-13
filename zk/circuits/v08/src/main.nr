// v08 Energy Proof Circuit
// Spec: docs/specs/aggregator_design.md section 3.2

use poseidon::poseidon::bn254;

// Public inputs (visible to V3 contract on-chain):
//   payload_hash    Poseidon sponge hash, 32 bytes as Field
//   device_id       packed into bytes32 by V3
//   epoch_start_ts  used by V3 for gap check
//   session_id      used by V3 to build session_key
//   tamper_flag     V3 requires 0
//
// Private inputs (witness only, not revealed):
//   canonical_payload  full 307 field-element payload
//   signature          P-256 ECDSA: r 32 bytes || s 32 bytes
//   pubkey_x, pubkey_y P-256 public key coordinates as bytes
fn main(
    payload_hash: pub Field,
    device_id: pub Field,
    epoch_start_ts: pub Field,
    session_id: pub Field,
    tamper_flag: pub Field,
    canonical_payload: [Field; 307],
    signature: [u8; 64],
    pubkey_x: [u8; 32],
    pubkey_y: [u8; 32],
) {
    // Check 1 of 7: payload_hash must equal Poseidon sponge of canonical_payload.
    // This anchors the public input to the witnessed canonical bytes.
    // Cross-language tested: edge Python matches Noir bit-exact.
    // Spec: docs/specs/poseidon_params.md v1.1.
    let computed_hash = bn254::sponge(canonical_payload);
    assert(computed_hash == payload_hash);

    // Check 2 of 7: metadata destructuring.
    // Public inputs must match positions 0,1,2,6 of canonical_payload.
    // Positions 3,4 (lat_e7, lon_e7) and 5 (light_level) remain private.
    // Spec: edge/hal/canonical.py canonicalize() field order.
    assert(canonical_payload[0] == device_id);
    assert(canonical_payload[1] == session_id);
    assert(canonical_payload[2] == epoch_start_ts);
    assert(canonical_payload[6] == tamper_flag);

    // Check 3: P-256 ECDSA signature verify.
    // Edge HSM signs payload_hash (32 BE bytes) with P-256 private key.
    // Circuit proves the signature is valid under pubkey (x, y) for the same hash.
    // Convert public input Field to 32 big-endian bytes for the verifier.
    let hash_bytes: [u8; 32] = payload_hash.to_be_bytes();
    let valid = std::ecdsa_secp256r1::verify_signature(
        pubkey_x,
        pubkey_y,
        signature,
        hash_bytes,
    );
    assert(valid);
}
