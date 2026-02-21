/**
 * Napoleon eFIRE BLE Protocol Implementation
 *
 * Based on the reverse-engineered protocol from the bonaparte library
 * by Felix Kaechele (https://github.com/kaechele/bonaparte).
 *
 * Protocol format:
 *   [HEADER(0xAB)] [MSG_TYPE(0xAA=req/0xBB=resp)] [LENGTH] [COMMAND] [...DATA] [CHECKSUM] [FOOTER(0x55)]
 *
 * Checksum: XOR of all bytes between header/msg_type and footer (length + command + data).
 */

'use strict';

// -- Packet framing --
const HEADER = 0xab;
const REQUEST_HEADER = 0xaa;
const RESPONSE_HEADER = 0xbb;
const FOOTER = 0x55;
const MIN_MESSAGE_LENGTH = 6;

// -- BLE GATT UUIDs --
// Napoleon eFIRE uses 16-bit UUIDs expanded to 128-bit Bluetooth Base UUID format
const UUID_BASE = '-0000-1000-8000-00805f9b34fb';
const SERVICE_UUID = '0000ff00' + UUID_BASE;
const WRITE_CHAR_UUID = '0000ff01' + UUID_BASE;
const READ_CHAR_UUID = '0000ff02' + UUID_BASE;

// Short forms used by noble (lowercase, no dashes)
const SERVICE_UUID_SHORT = 'ff00';
const WRITE_CHAR_UUID_SHORT = 'ff01';
const READ_CHAR_UUID_SHORT = 'ff02';

// -- Commands --
const Command = Object.freeze({
  // Power / flame control
  SET_POWER: 0xc4,
  GET_POWER_STATE: 0xe7,

  // Flame height + blower + aux + split-flow are packed into a single write
  SET_IFC_CMD2: 0x28,       // sets flame height, blower speed, aux, split-flow
  GET_IFC_CMD2_STATE: 0xf4, // reads back the same

  // Night light / continuous pilot
  SET_NIGHT_LIGHT: 0x27,    // sets night light brightness + pilot on/off

  // LED strip control
  SET_LED_STATE: 0xb1,
  SET_LED_COLOR: 0xc1,
  SET_LED_MODE: 0xf1,
  GET_LED_STATE: 0xe0,
  GET_LED_COLOR: 0xe1,
  GET_LED_MODE: 0xe2,

  // Timer
  SET_TIMER: 0xc3,
  GET_TIMER: 0xe6,

  // Authentication
  SEND_PASSWORD: 0xc5,
  PASSWORD_MGMT: 0xc6,
  PASSWORD_READ: 0xe8,
  PASSWORD_SET: 0xe9,
  RESET_PASSWORD: 0x3f,

  // System / info
  SYNC_TIME: 0xc7,
  GET_BLE_VERSION: 0xf2,
  GET_MCU_VERSION: 0xf3,
});

// -- Power state values --
const PowerState = Object.freeze({
  OFF: 0x00,
  ON: 0xff,
});

// -- LED mode values --
const LedMode = Object.freeze({
  CYCLE: 0x01,
  HOLD: 0x02,
  EMBER_BED: 0xff,
});

// -- Limits --
const MAX_FLAME_HEIGHT = 6;
const MAX_BLOWER_SPEED = 6;
const MAX_NIGHT_LIGHT = 6;

// ──────────────────────────────────────────
// Checksum helpers
// ──────────────────────────────────────────

/**
 * XOR checksum over an array of bytes.
 */
function checksum(bytes) {
  return bytes.reduce((acc, b) => acc ^ b, 0);
}

/**
 * Verify the checksum of a raw response message.
 * Bytes 2..(n-2) are checksummed and compared with byte n-1.
 */
function verifyChecksum(msg) {
  if (msg.length < MIN_MESSAGE_LENGTH) return false;
  const payload = msg.slice(2, msg.length - 2); // skip header+type and checksum+footer
  return checksum(payload) === msg[msg.length - 2];
}

// ──────────────────────────────────────────
// Message building
// ──────────────────────────────────────────

/**
 * Build a request message to send to the fireplace.
 * @param {number} command - Command byte from the Command enum
 * @param {number[]} [data=[]] - Optional data bytes
 * @returns {Buffer}
 */
function buildMessage(command, data = []) {
  const payload = [command, ...data];
  const length = payload.length + 2; // +2 accounts for length byte itself and checksum
  const inner = [length, ...payload];
  const cs = checksum(inner);
  return Buffer.from([HEADER, REQUEST_HEADER, ...inner, cs, FOOTER]);
}

// ──────────────────────────────────────────
// Response parsing
// ──────────────────────────────────────────

/**
 * Parse a raw response buffer. Returns { command, payload } or null on error.
 */
function parseResponse(buf) {
  if (!buf || buf.length < MIN_MESSAGE_LENGTH) return null;
  if (buf[0] !== HEADER || buf[1] !== RESPONSE_HEADER) return null;
  if (buf[buf.length - 1] !== FOOTER) return null;
  if (!verifyChecksum(buf)) return null;

  const command = buf[3];
  const payload = buf.slice(4, buf.length - 2); // data between command and checksum
  return { command, payload: Buffer.from(payload) };
}

/**
 * Parse power state response.
 * Byte layout: [main_mode, power | thermostat | night_light | pilot]
 */
function parsePowerState(payload) {
  if (!payload || payload.length < 2) return null;
  const flags = payload[1];
  return {
    power: (flags & 0x01) !== 0,
    thermostat: (flags & 0x02) !== 0,
    nightLightLevel: (flags >> 4) & 0x0f,
    pilotLight: (flags & 0x04) !== 0,
  };
}

/**
 * Parse IFC command 2 state (flame height, blower speed, aux, split-flow).
 */
function parseIFCCmd2State(payload) {
  if (!payload || payload.length < 2) return null;
  const b1 = payload[0];
  const b2 = payload[1];
  return {
    flameHeight: b1 & 0x0f,
    blowerSpeed: (b1 >> 4) & 0x0f,
    aux: (b2 & 0x01) !== 0,
    splitFlow: (b2 & 0x02) !== 0,
  };
}

/**
 * Parse LED controller state response.
 */
function parseLedState(payload) {
  if (!payload || payload.length < 5) return null;
  return {
    on: payload[0] === 0xff,
    color: { r: payload[1], g: payload[2], b: payload[3] },
    mode: payload[4],
  };
}

/**
 * Parse timer state response.
 */
function parseTimerState(payload) {
  if (!payload || payload.length < 4) return null;
  return {
    hours: payload[0],
    minutes: payload[1],
    seconds: payload[2],
    active: payload[3] === 0xff,
  };
}

// ──────────────────────────────────────────
// Command builders (return Buffer)
// ──────────────────────────────────────────

function buildSetPower(on) {
  return buildMessage(Command.SET_POWER, [on ? PowerState.ON : PowerState.OFF]);
}

function buildGetPowerState() {
  return buildMessage(Command.GET_POWER_STATE);
}

function buildSetFlameAndBlower(flameHeight, blowerSpeed, aux, splitFlow) {
  const b1 = (clamp(blowerSpeed, 0, MAX_BLOWER_SPEED) << 4) | clamp(flameHeight, 0, MAX_FLAME_HEIGHT);
  let b2 = 0;
  if (aux) b2 |= 0x01;
  if (splitFlow) b2 |= 0x02;
  return buildMessage(Command.SET_IFC_CMD2, [b1, b2]);
}

function buildGetIFCCmd2State() {
  return buildMessage(Command.GET_IFC_CMD2_STATE);
}

function buildSetNightLight(brightness, pilot) {
  const b = (clamp(brightness, 0, MAX_NIGHT_LIGHT) << 4) | (pilot ? 0x04 : 0x00);
  return buildMessage(Command.SET_NIGHT_LIGHT, [b]);
}

function buildSetLedState(on) {
  return buildMessage(Command.SET_LED_STATE, [on ? 0xff : 0x00]);
}

function buildSetLedColor(r, g, b) {
  return buildMessage(Command.SET_LED_COLOR, [r & 0xff, g & 0xff, b & 0xff]);
}

function buildSetLedMode(mode) {
  return buildMessage(Command.SET_LED_MODE, [mode]);
}

function buildGetLedState() {
  return buildMessage(Command.GET_LED_STATE);
}

function buildSendPassword(password) {
  // Password is a 4-digit PIN sent as 4 bytes
  const digits = String(password).padStart(4, '0').split('').map(Number);
  return buildMessage(Command.SEND_PASSWORD, digits);
}

function buildSetTimer(hours, minutes, enabled) {
  return buildMessage(Command.SET_TIMER, [hours & 0xff, minutes & 0xff, enabled ? 0xff : 0x00]);
}

function buildGetTimer() {
  return buildMessage(Command.GET_TIMER);
}

function buildGetBleVersion() {
  return buildMessage(Command.GET_BLE_VERSION);
}

function buildGetMcuVersion() {
  return buildMessage(Command.GET_MCU_VERSION);
}

// ──────────────────────────────────────────
// Utility
// ──────────────────────────────────────────

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  // Constants
  HEADER,
  REQUEST_HEADER,
  RESPONSE_HEADER,
  FOOTER,
  MIN_MESSAGE_LENGTH,
  SERVICE_UUID,
  WRITE_CHAR_UUID,
  READ_CHAR_UUID,
  SERVICE_UUID_SHORT,
  WRITE_CHAR_UUID_SHORT,
  READ_CHAR_UUID_SHORT,
  Command,
  PowerState,
  LedMode,
  MAX_FLAME_HEIGHT,
  MAX_BLOWER_SPEED,
  MAX_NIGHT_LIGHT,

  // Checksum
  checksum,
  verifyChecksum,

  // Message building / parsing
  buildMessage,
  parseResponse,
  parsePowerState,
  parseIFCCmd2State,
  parseLedState,
  parseTimerState,

  // Command builders
  buildSetPower,
  buildGetPowerState,
  buildSetFlameAndBlower,
  buildGetIFCCmd2State,
  buildSetNightLight,
  buildSetLedState,
  buildSetLedColor,
  buildSetLedMode,
  buildGetLedState,
  buildSendPassword,
  buildSetTimer,
  buildGetTimer,
  buildGetBleVersion,
  buildGetMcuVersion,

  // Utility
  clamp,
};
