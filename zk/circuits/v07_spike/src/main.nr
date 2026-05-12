// InfraVeritas Energy Module v07-spike
// Phase A.2.2 measurement: cost of keccak256(readings) as public output.

fn main(
    readings: [(u64, u64); 100],
    exact_lat: u64,
    exact_lon: u64,
    light_level: u64,
    tamper_flag: u64,
    device_id: pub u64,
    epoch_start_ts: pub u64,
    coarse_lat: pub u64,
    coarse_lon: pub u64
) -> pub (u64, [u8; 32]) {
    // v06 logic unchanged
    assert(epoch_start_ts >= 1700000000);
    assert(epoch_start_ts <= 2000000000);
    assert(device_id > 0);
    assert(device_id < 1000000);
    assert(tamper_flag == 0);
    assert(coarse_lat == exact_lat / 10000);
    assert(coarse_lon == exact_lon / 10000);

    let mut total_energy_mwh: u64 = 0;
    for i in 0..100 {
        let (voltage_mv, current_ma) = readings[i];
        assert(voltage_mv <= 10000);
        assert(current_ma <= 5000);
        let power_mw = voltage_mv * current_ma / 1000;
        total_energy_mwh = total_energy_mwh + power_mw;
    }

    let is_dark: u64 = if light_level < 50 { 1 } else { 0 };
    assert(is_dark * total_energy_mwh == 0);

    // NEW (spike): blake2s as proxy for hash cost measurement.
    // Encode 100 pairs of (u64, u64) as 1600 bytes big-endian.
    let mut readings_bytes: [u8; 1600] = [0; 1600];
    for i in 0..100 {
        let (v, a) = readings[i];
        for j in 0..8 {
            let j_u64 = j as u64;
            let shift = (7 - j_u64) * 8;
            readings_bytes[i * 16 + j] = ((v >> shift) & 0xff) as u8;
            readings_bytes[i * 16 + 8 + j] = ((a >> shift) & 0xff) as u8;
        }
    }
    let readings_hash = std::hash::blake2s(readings_bytes);

    (total_energy_mwh, readings_hash)
}
