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

describe('parsePowerState', () => {
  it('extracts power on with all flags', () => {
    // flags byte: power=1, thermostat=1, pilot=1, nightLight=3 (bits 7:4)
    const flags = 0x01 | 0x02 | 0x04 | (3 << 4);
    const result = protocol.parsePowerState(Buffer.from([0x00, flags]));
    assert.ok(result);
    assert.equal(result.power, true);
    assert.equal(result.thermostat, true);
    assert.equal(result.pilotLight, true);
    assert.equal(result.nightLightLevel, 3);
  });

  it('extracts power off', () => {
    const result = protocol.parsePowerState(Buffer.from([0x00, 0x00]));
    assert.ok(result);
    assert.equal(result.power, false);
    assert.equal(result.thermostat, false);
    assert.equal(result.pilotLight, false);
    assert.equal(result.nightLightLevel, 0);
  });

  it('returns null for insufficient payload', () => {
    assert.equal(protocol.parsePowerState(Buffer.from([0x00])), null);
  });
});

describe('parseIFCCmd2State', () => {
  it('extracts flame height, blower, aux, split-flow', () => {
    // b1: blowerSpeed=4 (upper nibble), flameHeight=5 (lower nibble)
    // b2: aux=1, splitFlow=1
    const b1 = (4 << 4) | 5;
    const b2 = 0x03; // both bits set
    const result = protocol.parseIFCCmd2State(Buffer.from([b1, b2]));
    assert.ok(result);
    assert.equal(result.flameHeight, 5);
    assert.equal(result.blowerSpeed, 4);
    assert.equal(result.aux, true);
    assert.equal(result.splitFlow, true);
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

  it('buildSetFlameAndBlower encodes correctly', () => {
    const msg = protocol.buildSetFlameAndBlower(3, 5, true, false);
    const b1 = msg[4];
    assert.equal(b1 & 0x0f, 3);        // flame height
    assert.equal((b1 >> 4) & 0x0f, 5); // blower speed
    assert.equal(msg[5] & 0x01, 1);     // aux on
    assert.equal(msg[5] & 0x02, 0);     // split-flow off
  });

  it('buildSetFlameAndBlower clamps values', () => {
    const msg = protocol.buildSetFlameAndBlower(10, -1, false, false);
    const b1 = msg[4];
    assert.equal(b1 & 0x0f, 6);        // clamped to MAX_FLAME_HEIGHT
    assert.equal((b1 >> 4) & 0x0f, 0); // clamped to 0
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
