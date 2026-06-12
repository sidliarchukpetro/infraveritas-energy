"""INA226 I2C power sensor HAL (bus 1, addr 0x40, onboard R002 shunt).

Calibration: current LSB = 1 mA, CAL = 2560. Bus LSB = 1.25 mV.
Config 0x4527 = 16-sample averaging, continuous shunt+bus."""
import time
import smbus2
from .edge_device import Reading

_ADDR = 0x40
_bus = None

def _rd(reg):
    d = _bus.read_i2c_block_data(_ADDR, reg, 2)
    return (d[0] << 8) | d[1]

def _wr(reg, v):
    _bus.write_i2c_block_data(_ADDR, reg, [(v >> 8) & 0xFF, v & 0xFF])

def init():
    global _bus
    if _bus is None:
        _bus = smbus2.SMBus(1)
        _wr(0x05, 2560)
        _wr(0x00, 0x4527)

def collect_readings(n=100, hz=10.0):
    init()
    out = []
    t0 = time.time()
    for i in range(n):
        target = t0 + i / hz
        while time.time() < target: time.sleep(0.002)
        u_mv = round(_rd(0x02) * 1.25)
        raw = _rd(0x04)
        if raw > 32767: raw -= 65536
        out.append(Reading(voltage_mv=u_mv, current_ma=max(raw, 0), timestamp_ms=int(time.time() * 1000)))
    return tuple(out)
