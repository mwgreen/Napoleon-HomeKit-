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
  // IFC CMD1: power + thermostat mode + night light + pilot
  SET_IFC_CMD1: 0x27,
  GET_IFC_CMD1_STATE: 0xe3,

  // IFC CMD2: flame height + blower speed + aux + split-flow
  SET_IFC_CMD2: 0x28,
  GET_IFC_CMD2_STATE: 0xe4,

  // Power (BT controller level)
  SET_POWER: 0xc4,
  GET_POWER_STATE: 0xe7,

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
  GET_AUX_CTRL: 0xf4,
  GET_REMOTE_USAGE: 0xee,

  // Undocumented — potential thermostat / CMD3 commands (sequential with CMD1/CMD2)
  SET_IFC_CMD3: 0x29,       // probe: may carry temperature setpoint
  GET_IFC_CMD3_STATE: 0xe5, // probe: may return temperature data
});

// -- Power state values --
const PowerState = Object.freeze({
  OFF: 0x00,
  ON: 0xff,
});

// -- Main mode values (lower 3 bits of IFC CMD1 flags) --
// The Wireshark dissector documents these as the fireplace operating mode.
const MainMode = Object.freeze({
  OFF: 0,         // Fireplace off
  MANUAL: 1,      // Manual flame control
  THERMOSTAT: 2,  // Thermostat mode (client manages flame based on temp)
  SMART: 3,       // Smart thermostat (power + thermostat active)
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
 * Parse IFC CMD1 state response (from GET_IFC_CMD1_STATE 0xE3).
 *
 * Payload: [status_byte, flags_byte]
 * Flags byte bit layout (per bonaparte + Wireshark dissector):
 *   Bit 0:    power        (IFC on)
 *   Bit 1:    thermostat   (thermostat mode enabled)
 *   Bits 2-3: reserved     (always 0 — candidate for temperature offset?)
 *   Bits 4-6: night_light  (0-6 brightness)
 *   Bit 7:    pilot        (continuous pilot enabled)
 *
 * The lower 3 bits also form a "main mode" value:
 *   0=off, 1=manual, 2=thermostat, 3=smart
 */
function parseIFCCmd1State(payload) {
  if (!payload || payload.length < 1) return null;
  // Some controllers return [status, flags], others return just [flags]
  const flags = payload.length >= 2 ? payload[1] : payload[0];
  return {
    power: (flags & 0x01) !== 0,
    thermostat: (flags & 0x02) !== 0,
    mainMode: flags & 0x07,
    nightLightLevel: (flags >> 4) & 0x07,
    pilotLight: (flags & 0x80) !== 0,
  };
}

/**
 * Parse IFC CMD2 state response (from GET_IFC_CMD2_STATE 0xE4).
 *
 * Payload: [status_byte, flags_byte]
 * Flags byte bit layout (per bonaparte):
 *   Bits 0-2: flame_height (0-6)
 *   Bit 3:    aux          (120V relay)
 *   Bits 4-6: blower_speed (0-6)
 *   Bit 7:    split_flow   (split-flow valve)
 */
function parseIFCCmd2State(payload) {
  if (!payload || payload.length < 1) return null;
  const flags = payload.length >= 2 ? payload[1] : payload[0];
  return {
    flameHeight: flags & 0x07,
    aux: (flags & 0x08) !== 0,
    blowerSpeed: (flags >> 4) & 0x07,
    splitFlow: (flags & 0x80) !== 0,
  };
}

/**
 * Parse LED controller state response.
 */
function parseLedState(payload) {
  if (!payload || payload.length < 1) return null;
  // Full response: [on, r, g, b, mode] — some controllers return just [on/status]
  if (payload.length >= 5) {
    return {
      on: payload[0] === 0xff,
      color: { r: payload[1], g: payload[2], b: payload[3] },
      mode: payload[4],
    };
  }
  return {
    on: payload[0] !== 0x00,
    color: { r: 0, g: 0, b: 0 },
    mode: 0,
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

/**
 * Build SET_IFC_CMD1 (0x27) — controls power, thermostat mode, night light, pilot.
 *
 * Payload: [0x00, flags_byte]
 * Flags byte layout:
 *   Bit 0:    power
 *   Bit 1:    thermostat
 *   Bits 4-6: night_light brightness (0-6)
 *   Bit 7:    pilot
 */
function buildSetIFCCmd1(power, thermostat, nightLight, pilot) {
  const flags = (power ? 0x01 : 0x00)
    | (thermostat ? 0x02 : 0x00)
    | (clamp(nightLight, 0, MAX_NIGHT_LIGHT) << 4)
    | (pilot ? 0x80 : 0x00);
  return buildMessage(Command.SET_IFC_CMD1, [0x00, flags]);
}

function buildGetIFCCmd1State() {
  return buildMessage(Command.GET_IFC_CMD1_STATE);
}

/**
 * Build SET_IFC_CMD2 (0x28) — controls flame height, blower, aux, split-flow.
 *
 * Payload: [0x00, flags_byte]
 * Flags byte layout (per bonaparte):
 *   Bits 0-2: flame_height (0-6)
 *   Bit 3:    aux
 *   Bits 4-6: blower_speed (0-6)
 *   Bit 7:    split_flow
 */
function buildSetIFCCmd2(flameHeight, blowerSpeed, aux, splitFlow) {
  const flags = clamp(flameHeight, 0, MAX_FLAME_HEIGHT)
    | (aux ? 0x08 : 0x00)
    | (clamp(blowerSpeed, 0, MAX_BLOWER_SPEED) << 4)
    | (splitFlow ? 0x80 : 0x00);
  return buildMessage(Command.SET_IFC_CMD2, [0x00, flags]);
}

function buildGetIFCCmd2State() {
  return buildMessage(Command.GET_IFC_CMD2_STATE);
}

function buildGetPowerState() {
  return buildMessage(Command.GET_POWER_STATE);
}

function buildGetRemoteUsage() {
  return buildMessage(Command.GET_REMOTE_USAGE);
}

/**
 * Probe undocumented command 0x29 (potential SET_IFC_CMD3 for temperature).
 * Sequential with SET_IFC_CMD1 (0x27) and SET_IFC_CMD2 (0x28).
 * @param {number[]} data - Payload bytes to send (try [0x00, temp_byte])
 */
function buildProbeSetCmd3(data) {
  return buildMessage(Command.SET_IFC_CMD3, data);
}

/**
 * Probe undocumented command 0xE5 (potential GET_IFC_CMD3_STATE for temperature).
 * Sequential with GET_IFC_CMD1_STATE (0xE3) and GET_IFC_CMD2_STATE (0xE4).
 */
function buildProbeGetCmd3State() {
  return buildMessage(Command.GET_IFC_CMD3_STATE);
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

// Password auth response codes (from bonaparte const.py)
const PasswordResult = Object.freeze({
  SET_SUCCESS: 0x00,
  SET_FAILED: 0x01,
  INVALID_PASSWORD: 0x19,
  LOGIN_SUCCESS: 0x35,
});

function buildSendPassword(password) {
  // Password is a 4-digit PIN sent as ASCII bytes (per bonaparte)
  const ascii = Buffer.from(String(password).padStart(4, '0'), 'ascii');
  return buildMessage(Command.SEND_PASSWORD, [...ascii]);
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
  PasswordResult,
  MainMode,
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
  parseIFCCmd1State,
  parseIFCCmd2State,
  parseLedState,
  parseTimerState,

  // Command builders
  buildSetPower,
  buildSetIFCCmd1,
  buildGetIFCCmd1State,
  buildSetIFCCmd2,
  buildGetIFCCmd2State,
  buildGetPowerState,
  buildGetRemoteUsage,
  buildSetLedState,
  buildSetLedColor,
  buildSetLedMode,
  buildGetLedState,
  buildSendPassword,
  buildSetTimer,
  buildGetTimer,
  buildGetBleVersion,
  buildGetMcuVersion,

  // Probe commands for undocumented thermostat/temperature support
  buildProbeSetCmd3,
  buildProbeGetCmd3State,

  // Utility
  clamp,
};
