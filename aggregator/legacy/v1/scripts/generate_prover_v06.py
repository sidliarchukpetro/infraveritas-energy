#!/usr/bin/env python3
"""
Generate Prover.toml for energy_v06 circuit testing.
Pattern matches edge_device.py mock readings:
  voltage_mv = 5500 + (i % 10) * 50
  current_ma = 240 + (i % 8) * 10
"""

print('device_id = "42"')
print('epoch_start_ts = "1714900000"')
print('exact_lat = "48451700"')
print('exact_lon = "25575200"')
print('light_level = "5000"')
print('tamper_flag = "0"')
print('coarse_lat = "4845"')
print('coarse_lon = "2557"')
print('readings = [')
for i in range(100):
    voltage_mv = 5500 + (i % 10) * 50
    current_ma = 240 + (i % 8) * 10
    print(f'  ["{voltage_mv}", "{current_ma}"],')
print(']')
