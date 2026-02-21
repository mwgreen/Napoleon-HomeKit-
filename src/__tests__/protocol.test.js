/**
 * Tests for the Napoleon eFIRE BLE protocol module.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../protocol');

describe('checksum', () => {
  it('XORs all bytes together', () => {
    assert.equal(protocol.checksum([0x10, 0x20, 0x30]), 0x10 ^ 0x20 ^ 0x30);
  });

  it('returns 0 for empty input', () => {
    assert.equal(protocol.checksum([]), 0);
  });

  it('returns the byte itself for single-byte input', () => {
    assert.equal(protocol.checksum([0x42]), 0x42);
  });
});

describe('buildMessage', () => {
  it('wraps a command in the correct frame', () => {
    const msg = protocol.buildMessage(0xc4, [0xff]);
    // Expected: [HEADER, REQ_HDR, LENGTH, CMD, DATA, CHECKSUM, FOOTER]
    assert.equal(msg[0], protocol.HEADER);       // 0xAB
    assert.equal(msg[1], protocol.REQUEST_HEADER); // 0xAA
    // length = 2 (cmd + data) + 2 = 4
    assert.equal(msg[2], 4);
    assert.equal(msg[3], 0xc4);                   // command
    assert.equal(msg[4], 0xff);                   // data
    assert.equal(msg[msg.length - 1], protocol.FOOTER); // 0x55
  });

  it('calculates correct checksum', () => {
    const msg = protocol.buildMessage(0xc4, [0xff]);
    // Checksum covers bytes 2..(n-2)
    const inner = [...msg.slice(2, msg.length - 2)];
    const expected = inner.reduce((a, b) => a ^ b, 0);
    assert.equal(msg[msg.length - 2], expected);
  });

  it('builds a command with no data', () => {
    const msg = protocol.buildMessage(0xe7);
    assert.equal(msg[0], protocol.HEADER);
    assert.equal(msg[3], 0xe7);
    assert.equal(msg.length, 6); // min message length
  });
});

describe('parseResponse', () => {
  it('parses a valid response', () => {
    // Build a fake response: [HEADER, RESP_HDR, LEN, CMD, DATA, CHECKSUM, FOOTER]
    const cmd = 0xe7;
    const data = [0x01, 0x03];
    const length = data.length + 1 + 2; // cmd + data + length + checksum
    const inner = [length, cmd, ...data];
    const cs = inner.reduce((a, b) => a ^ b, 0);
    const raw = Buffer.from([protocol.HEADER, protocol.RESPONSE_HEADER, ...inner, cs, protocol.FOOTER]);

    const result = protocol.parseResponse(raw);
    assert.ok(result);
    assert.equal(result.command, cmd);
    assert.deepEqual([...result.payload], data);
  });

  it('returns null for short messages', () => {
    assert.equal(protocol.parseResponse(Buffer.from([0xab, 0xbb])), null);
  });

  it('returns null for wrong header', () => {
    const raw = Buffer.from([0x00, 0xbb, 0x03, 0xe7, 0x00, 0x55]);
    assert.equal(protocol.parseResponse(raw), null);
  });

  it('returns null for bad checksum', () => {
    const raw = Buffer.from([protocol.HEADER, protocol.RESPONSE_HEADER, 0x03, 0xe7, 0xFF, protocol.FOOTER]);
    assert.equal(protocol.parseResponse(raw), null);
  });
});

describe('parseIFCCmd1State', () => {
  it('extracts all fields from CMD1 flags byte', () => {
    // flags byte: power=1 (bit 0), thermostat=1 (bit 1), nightLight=3 (bits 4-6), pilot=1 (bit 7)
    const flags = 0x01 | 0x02 | (3 << 4) | 0x80;
    const result = protocol.parseIFCCmd1State(Buffer.from([0x00, flags]));
    assert.ok(result);
    assert.equal(result.power, true);
    assert.equal(result.thermostat, true);
    assert.equal(result.mainMode, protocol.MainMode.SMART); // 0x03 = power + thermostat
    assert.equal(result.nightLightLevel, 3);
    assert.equal(result.pilotLight, true);
  });

  it('extracts power off / all clear', () => {
    const result = protocol.parseIFCCmd1State(Buffer.from([0x00, 0x00]));
    assert.ok(result);
    assert.equal(result.power, false);
    assert.equal(result.thermostat, false);
    assert.equal(result.mainMode, protocol.MainMode.OFF);
    assert.equal(result.nightLightLevel, 0);
    assert.equal(result.pilotLight, false);
  });

  it('extracts manual mode (power only)', () => {
    const flags = 0x01; // just power bit
    const result = protocol.parseIFCCmd1State(Buffer.from([0x00, flags]));
    assert.equal(result.mainMode, protocol.MainMode.MANUAL);
    assert.equal(result.power, true);
    assert.equal(result.thermostat, false);
  });

  it('extracts thermostat mode (thermostat only)', () => {
    const flags = 0x02; // just thermostat bit
    const result = protocol.parseIFCCmd1State(Buffer.from([0x00, flags]));
    assert.equal(result.mainMode, protocol.MainMode.THERMOSTAT);
    assert.equal(result.power, false);
    assert.equal(result.thermostat, true);
  });

  it('pilot is bit 7, not bit 2', () => {
    // Verify pilot is correctly at bit 7 (0x80), not bit 2 (0x04)
    const withBit2 = protocol.parseIFCCmd1State(Buffer.from([0x00, 0x04]));
    assert.equal(withBit2.pilotLight, false); // bit 2 should NOT set pilot

    const withBit7 = protocol.parseIFCCmd1State(Buffer.from([0x00, 0x80]));
    assert.equal(withBit7.pilotLight, true); // bit 7 SHOULD set pilot
  });

  it('returns null for insufficient payload', () => {
    assert.equal(protocol.parseIFCCmd1State(Buffer.from([0x00])), null);
  });
});

describe('parseIFCCmd2State', () => {
  it('extracts flame height, blower, aux, split-flow from single flags byte', () => {
    // Per bonaparte: flame=5 (bits 0-2), aux=1 (bit 3), blower=4 (bits 4-6), splitFlow=1 (bit 7)
    const flags = 5 | (1 << 3) | (4 << 4) | (1 << 7);
    const result = protocol.parseIFCCmd2State(Buffer.from([0x00, flags]));
    assert.ok(result);
    assert.equal(result.flameHeight, 5);
    assert.equal(result.aux, true);
    assert.equal(result.blowerSpeed, 4);
    assert.equal(result.splitFlow, true);
  });

  it('extracts zero state', () => {
    const result = protocol.parseIFCCmd2State(Buffer.from([0x00, 0x00]));
    assert.ok(result);
    assert.equal(result.flameHeight, 0);
    assert.equal(result.aux, false);
    assert.equal(result.blowerSpeed, 0);
    assert.equal(result.splitFlow, false);
  });

  it('flame height uses only 3 bits (max 7)', () => {
    const flags = 0x07; // all 3 bits set
    const result = protocol.parseIFCCmd2State(Buffer.from([0x00, flags]));
    assert.equal(result.flameHeight, 7);
    assert.equal(result.aux, false); // bit 3 not set
  });
});

describe('command builders', () => {
  it('buildSetPower(true) contains ON byte', () => {
    const msg = protocol.buildSetPower(true);
    assert.equal(msg[4], protocol.PowerState.ON);
  });

  it('buildSetPower(false) contains OFF byte', () => {
    const msg = protocol.buildSetPower(false);
    assert.equal(msg[4], protocol.PowerState.OFF);
  });

  it('buildSetIFCCmd1 packs flags correctly', () => {
    // power=true, thermostat=true, nightLight=5, pilot=true
    const msg = protocol.buildSetIFCCmd1(true, true, 5, true);
    assert.equal(msg[4], 0x00); // leading zero byte
    const flags = msg[5];
    assert.equal(flags & 0x01, 1);        // power
    assert.equal(flags & 0x02, 2);        // thermostat
    assert.equal((flags >> 4) & 0x07, 5); // night light
    assert.equal(flags & 0x80, 0x80);     // pilot at bit 7
  });

  it('buildSetIFCCmd2 packs flags correctly (bonaparte layout)', () => {
    // flame=3, blower=5, aux=true, splitFlow=false
    const msg = protocol.buildSetIFCCmd2(3, 5, true, false);
    assert.equal(msg[4], 0x00); // leading zero byte
    const flags = msg[5];
    assert.equal(flags & 0x07, 3);        // flame height in bits 0-2
    assert.equal(flags & 0x08, 0x08);     // aux at bit 3
    assert.equal((flags >> 4) & 0x07, 5); // blower speed in bits 4-6
    assert.equal(flags & 0x80, 0x00);     // split-flow off at bit 7
  });

  it('buildSetIFCCmd2 clamps values', () => {
    const msg = protocol.buildSetIFCCmd2(10, -1, false, false);
    const flags = msg[5];
    assert.equal(flags & 0x07, 6);        // clamped to MAX_FLAME_HEIGHT
    assert.equal((flags >> 4) & 0x07, 0); // clamped to 0
  });

  it('buildSetIFCCmd2 with split-flow sets bit 7', () => {
    const msg = protocol.buildSetIFCCmd2(0, 0, false, true);
    assert.equal(msg[5] & 0x80, 0x80);
  });
});

describe('command addresses', () => {
  it('GET_IFC_CMD1_STATE is 0xE3 (not 0xE7)', () => {
    assert.equal(protocol.Command.GET_IFC_CMD1_STATE, 0xe3);
  });

  it('GET_IFC_CMD2_STATE is 0xE4 (not 0xF4)', () => {
    assert.equal(protocol.Command.GET_IFC_CMD2_STATE, 0xe4);
  });

  it('SET_IFC_CMD1 is 0x27', () => {
    assert.equal(protocol.Command.SET_IFC_CMD1, 0x27);
  });

  it('SET_IFC_CMD2 is 0x28', () => {
    assert.equal(protocol.Command.SET_IFC_CMD2, 0x28);
  });

  it('probe commands are sequential', () => {
    assert.equal(protocol.Command.SET_IFC_CMD3, 0x29);
    assert.equal(protocol.Command.GET_IFC_CMD3_STATE, 0xe5);
  });
});

describe('MainMode', () => {
  it('has correct values', () => {
    assert.equal(protocol.MainMode.OFF, 0);
    assert.equal(protocol.MainMode.MANUAL, 1);
    assert.equal(protocol.MainMode.THERMOSTAT, 2);
    assert.equal(protocol.MainMode.SMART, 3);
  });

  it('mode values map to power + thermostat bits', () => {
    // OFF: power=0, thermostat=0
    assert.equal(protocol.MainMode.OFF & 0x01, 0);
    assert.equal(protocol.MainMode.OFF & 0x02, 0);
    // MANUAL: power=1, thermostat=0
    assert.equal(protocol.MainMode.MANUAL & 0x01, 1);
    assert.equal(protocol.MainMode.MANUAL & 0x02, 0);
    // THERMOSTAT: power=0, thermostat=1
    assert.equal(protocol.MainMode.THERMOSTAT & 0x01, 0);
    assert.equal(protocol.MainMode.THERMOSTAT & 0x02, 2);
    // SMART: power=1, thermostat=1
    assert.equal(protocol.MainMode.SMART & 0x01, 1);
    assert.equal(protocol.MainMode.SMART & 0x02, 2);
  });
});

describe('clamp', () => {
  it('clamps below minimum', () => {
    assert.equal(protocol.clamp(-5, 0, 6), 0);
  });

  it('clamps above maximum', () => {
    assert.equal(protocol.clamp(10, 0, 6), 6);
  });

  it('passes through values in range', () => {
    assert.equal(protocol.clamp(3, 0, 6), 3);
  });
});
