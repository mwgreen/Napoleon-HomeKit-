/**
 * Napoleon eFIRE Fireplace — BLE Client
 *
 * Manages the Bluetooth Low Energy connection to a Napoleon fireplace
 * and provides a high-level API for controlling it.
 */

'use strict';

const EventEmitter = require('events');
const noble = require('@abandonware/noble');
const protocol = require('./protocol');

const CONNECT_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 5000;
const DISCONNECT_IDLE_MS = 0; // 0 = stay connected (HomeKit needs low latency)
const POLL_INTERVAL_MS = 30000;
const RECONNECT_DELAY_MS = 5000;

class NapoleonFireplace extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.peripheralId - BLE peripheral UUID or MAC address (lowercase, no colons on Linux)
   * @param {string} [opts.password='1234'] - 4-digit eFIRE PIN
   * @param {string} [opts.name] - Friendly name for logging
   */
  constructor(opts) {
    super();
    this.peripheralId = opts.peripheralId.toLowerCase();
    this.password = opts.password || '1234';
    this.name = opts.name || 'Napoleon Fireplace';

    // Connection state
    this._peripheral = null;
    this._writeChar = null;
    this._readChar = null;
    this._connected = false;
    this._authenticated = false;
    this._connecting = false;
    this._disconnectTimer = null;
    this._pollTimer = null;

    // Pending command callback
    this._pendingResolve = null;
    this._pendingReject = null;
    this._pendingTimeout = null;

    // Cached fireplace state
    this.state = {
      power: false,
      thermostat: false,
      mainMode: protocol.MainMode.OFF,
      flameHeight: 0,
      blowerSpeed: 0,
      aux: false,
      splitFlow: false,
      nightLightLevel: 0,
      pilotLight: false,
      remoteOverride: false,
      led: { on: false, color: { r: 0, g: 0, b: 0 }, mode: 0 },
    };

    // Listen for noble state changes
    this._onStateChange = this._onStateChange.bind(this);
    this._onDiscover = this._onDiscover.bind(this);
    noble.on('stateChange', this._onStateChange);
  }

  // ──────────────────────────────────────────
  // Connection lifecycle
  // ──────────────────────────────────────────

  /**
   * Start scanning and connect to the fireplace.
   * Returns a promise that resolves when connected and authenticated.
   */
  async connect() {
    if (this._connected) return;
    if (this._connecting) return;
    this._connecting = true;

    this._log('Searching for fireplace...');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble.stopScanning();
        noble.removeListener('discover', this._onDiscover);
        this._connecting = false;
        reject(new Error(`Timed out searching for fireplace ${this.peripheralId}`));
      }, CONNECT_TIMEOUT_MS);

      this._connectResolve = (err) => {
        clearTimeout(timeout);
        noble.removeListener('discover', this._onDiscover);
        this._connecting = false;
        if (err) return reject(err);
        resolve();
      };

      noble.on('discover', this._onDiscover);

      if (noble.state === 'poweredOn') {
        noble.startScanning([protocol.SERVICE_UUID_SHORT], false);
      }
      // Otherwise _onStateChange will start scanning once ready
    });
  }

  _onStateChange(state) {
    if (state === 'poweredOn' && this._connecting) {
      noble.startScanning([protocol.SERVICE_UUID_SHORT], false);
    }
  }

  async _onDiscover(peripheral) {
    const id = peripheral.id || peripheral.address;
    if (!id) return;

    // Match by peripheral ID or by advertised local name
    const nameMatch = peripheral.advertisement?.localName?.toLowerCase().includes('nap_fpc') ||
                      peripheral.advertisement?.localName?.toLowerCase().includes(this.peripheralId);
    const idMatch = id.toLowerCase().replace(/:/g, '') === this.peripheralId.replace(/:/g, '');

    if (!idMatch && !nameMatch) return;

    noble.stopScanning();
    this._log(`Found fireplace: ${peripheral.advertisement?.localName || id}`);

    try {
      await this._connectToPeripheral(peripheral);
      if (this._connectResolve) this._connectResolve(null);
    } catch (err) {
      if (this._connectResolve) this._connectResolve(err);
    }
  }

  async _connectToPeripheral(peripheral) {
    this._peripheral = peripheral;

    peripheral.once('disconnect', () => {
      this._log('Disconnected');
      this._connected = false;
      this._authenticated = false;
      this._writeChar = null;
      this._readChar = null;
      this._rejectPending(new Error('Disconnected'));
      this.emit('disconnected');
      this._scheduleReconnect();
    });

    this._log('Connecting...');
    await this._nobleConnect(peripheral);
    this._log('Connected. Discovering services...');

    const { characteristics } = await this._nobleDiscoverCharacteristics(peripheral);

    for (const char of characteristics) {
      const uuid = char.uuid.toLowerCase();
      if (uuid === protocol.WRITE_CHAR_UUID_SHORT || uuid === protocol.WRITE_CHAR_UUID.replace(/-/g, '')) {
        this._writeChar = char;
      }
      if (uuid === protocol.READ_CHAR_UUID_SHORT || uuid === protocol.READ_CHAR_UUID.replace(/-/g, '')) {
        this._readChar = char;
      }
    }

    if (!this._writeChar || !this._readChar) {
      throw new Error('Could not find required BLE characteristics');
    }

    // Subscribe to notifications on the read characteristic
    await this._nobleSubscribe(this._readChar);
    this._readChar.on('data', (data) => this._onNotification(data));

    this._connected = true;
    this._log('BLE ready. Authenticating...');

    // Authenticate
    await this._authenticate();
    this._authenticated = true;
    this._log('Authenticated. Fetching initial state...');

    // Get initial state
    await this.updateState();
    this.emit('connected');

    // Start polling
    this._startPolling();
  }

  _scheduleReconnect() {
    this._stopPolling();
    setTimeout(async () => {
      try {
        this._log('Attempting reconnect...');
        await this.connect();
      } catch (err) {
        this._log(`Reconnect failed: ${err.message}`);
        this._scheduleReconnect();
      }
    }, RECONNECT_DELAY_MS);
  }

  async disconnect() {
    this._stopPolling();
    if (this._peripheral && this._connected) {
      this._connected = false;
      try {
        await new Promise((resolve) => this._peripheral.disconnect(resolve));
      } catch (_) { /* ignore */ }
    }
  }

  // ──────────────────────────────────────────
  // BLE communication
  // ──────────────────────────────────────────

  /**
   * Send a command and wait for the response.
   * @param {Buffer} message - A fully built protocol message
   * @returns {Promise<{command: number, payload: Buffer}>}
   */
  async sendCommand(message) {
    if (!this._connected || !this._writeChar) {
      throw new Error('Not connected');
    }

    return new Promise((resolve, reject) => {
      this._pendingResolve = resolve;
      this._pendingReject = reject;
      this._pendingTimeout = setTimeout(() => {
        this._rejectPending(new Error('Command timed out'));
      }, COMMAND_TIMEOUT_MS);

      this._writeChar.write(message, true, (err) => {
        if (err) {
          this._rejectPending(err);
        }
      });
    });
  }

  _onNotification(data) {
    const buf = Buffer.from(data);
    const resp = protocol.parseResponse(buf);
    if (!resp) {
      this._log(`Invalid response: ${buf.toString('hex')}`);
      return;
    }

    if (this._pendingResolve) {
      clearTimeout(this._pendingTimeout);
      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingReject = null;
      this._pendingTimeout = null;
      resolve(resp);
    } else {
      // Unsolicited notification — could be a state update
      this.emit('notification', resp);
    }
  }

  _rejectPending(err) {
    if (this._pendingReject) {
      clearTimeout(this._pendingTimeout);
      const reject = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject = null;
      this._pendingTimeout = null;
      reject(err);
    }
  }

  // ──────────────────────────────────────────
  // Authentication
  // ──────────────────────────────────────────

  async _authenticate() {
    const resp = await this.sendCommand(protocol.buildSendPassword(this.password));
    // The response payload[0] should be 0x00 for success
    if (resp.payload.length > 0 && resp.payload[0] !== 0x00) {
      throw new Error('Authentication failed — check your eFIRE PIN');
    }
  }

  // ──────────────────────────────────────────
  // State polling
  // ──────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(async () => {
      try {
        await this.updateState();
      } catch (err) {
        this._log(`Poll error: ${err.message}`);
      }
    }, POLL_INTERVAL_MS);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Query the fireplace for its current state and update this.state.
   */
  async updateState() {
    // IFC CMD1: power, thermostat mode, night light, pilot
    try {
      const cmd1Resp = await this.sendCommand(protocol.buildGetIFCCmd1State());
      const parsed = protocol.parseIFCCmd1State(cmd1Resp.payload);
      if (parsed) {
        this.state.power = parsed.power;
        this.state.thermostat = parsed.thermostat;
        this.state.mainMode = parsed.mainMode;
        this.state.nightLightLevel = parsed.nightLightLevel;
        this.state.pilotLight = parsed.pilotLight;
      }
    } catch (err) {
      this._log(`Failed to get IFC CMD1 state: ${err.message}`);
    }

    // IFC CMD2: flame height, blower speed, aux, split-flow
    try {
      const cmd2Resp = await this.sendCommand(protocol.buildGetIFCCmd2State());
      const parsed = protocol.parseIFCCmd2State(cmd2Resp.payload);
      if (parsed) {
        this.state.flameHeight = parsed.flameHeight;
        this.state.blowerSpeed = parsed.blowerSpeed;
        this.state.aux = parsed.aux;
        this.state.splitFlow = parsed.splitFlow;
      }
    } catch (err) {
      this._log(`Failed to get IFC CMD2 state: ${err.message}`);
    }

    // Check if RF remote is overriding BLE
    try {
      const remoteResp = await this.sendCommand(protocol.buildGetRemoteUsage());
      if (remoteResp.payload.length > 0) {
        this.state.remoteOverride = remoteResp.payload[0] !== 0x00;
      }
    } catch (_) { /* may not be supported */ }

    // LED state
    try {
      const ledResp = await this.sendCommand(protocol.buildGetLedState());
      const parsed = protocol.parseLedState(ledResp.payload);
      if (parsed) {
        this.state.led = parsed;
      }
    } catch (_) { /* LED may not be present */ }

    this.emit('stateChanged', this.state);
  }

  // ──────────────────────────────────────────
  // High-level control API
  // ──────────────────────────────────────────

  async setPower(on) {
    await this.sendCommand(protocol.buildSetPower(on));
    this.state.power = on;
    this.state.mainMode = on ? protocol.MainMode.MANUAL : protocol.MainMode.OFF;
    this.state.thermostat = false;
    if (!on) {
      this.state.flameHeight = 0;
      this.state.blowerSpeed = 0;
    }
    this.emit('stateChanged', this.state);
  }

  /**
   * Set the fireplace operating mode via IFC CMD1.
   * @param {number} mode - MainMode value (OFF, MANUAL, THERMOSTAT, SMART)
   */
  async setMainMode(mode) {
    const power = (mode & 0x01) !== 0;
    const thermostat = (mode & 0x02) !== 0;
    await this.sendCommand(
      protocol.buildSetIFCCmd1(power, thermostat, this.state.nightLightLevel, this.state.pilotLight)
    );
    this.state.power = power;
    this.state.thermostat = thermostat;
    this.state.mainMode = mode;
    this.emit('stateChanged', this.state);
  }

  async setFlameHeight(height) {
    const h = protocol.clamp(height, 0, protocol.MAX_FLAME_HEIGHT);
    await this.sendCommand(
      protocol.buildSetIFCCmd2(h, this.state.blowerSpeed, this.state.aux, this.state.splitFlow)
    );
    this.state.flameHeight = h;
    this.emit('stateChanged', this.state);
  }

  async setBlowerSpeed(speed) {
    const s = protocol.clamp(speed, 0, protocol.MAX_BLOWER_SPEED);
    await this.sendCommand(
      protocol.buildSetIFCCmd2(this.state.flameHeight, s, this.state.aux, this.state.splitFlow)
    );
    this.state.blowerSpeed = s;
    this.emit('stateChanged', this.state);
  }

  async setAux(enabled) {
    await this.sendCommand(
      protocol.buildSetIFCCmd2(this.state.flameHeight, this.state.blowerSpeed, enabled, this.state.splitFlow)
    );
    this.state.aux = enabled;
    this.emit('stateChanged', this.state);
  }

  async setNightLight(brightness) {
    const b = protocol.clamp(brightness, 0, protocol.MAX_NIGHT_LIGHT);
    await this.sendCommand(
      protocol.buildSetIFCCmd1(this.state.power, this.state.thermostat, b, this.state.pilotLight)
    );
    this.state.nightLightLevel = b;
    this.emit('stateChanged', this.state);
  }

  async setContinuousPilot(enabled) {
    await this.sendCommand(
      protocol.buildSetIFCCmd1(this.state.power, this.state.thermostat, this.state.nightLightLevel, enabled)
    );
    this.state.pilotLight = enabled;
    this.emit('stateChanged', this.state);
  }

  /**
   * Probe undocumented command 0xE5 (potential GET_IFC_CMD3_STATE).
   * Returns raw response payload for analysis, or null on error.
   */
  async probeCmd3State() {
    try {
      const resp = await this.sendCommand(protocol.buildProbeGetCmd3State());
      this._log(`Probe 0xE5 response: cmd=0x${resp.command.toString(16)} payload=${resp.payload.toString('hex')}`);
      return resp;
    } catch (err) {
      this._log(`Probe 0xE5 failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Probe undocumented command 0x29 (potential SET_IFC_CMD3).
   * @param {number[]} data - Raw payload bytes to send
   * Returns raw response for analysis, or null on error.
   */
  async probeSetCmd3(data) {
    try {
      const resp = await this.sendCommand(protocol.buildProbeSetCmd3(data));
      this._log(`Probe 0x29 response: cmd=0x${resp.command.toString(16)} payload=${resp.payload.toString('hex')}`);
      return resp;
    } catch (err) {
      this._log(`Probe 0x29 failed: ${err.message}`);
      return null;
    }
  }

  async setLedState(on) {
    await this.sendCommand(protocol.buildSetLedState(on));
    this.state.led.on = on;
    this.emit('stateChanged', this.state);
  }

  async setLedColor(r, g, b) {
    await this.sendCommand(protocol.buildSetLedColor(r, g, b));
    this.state.led.color = { r, g, b };
    this.emit('stateChanged', this.state);
  }

  // ──────────────────────────────────────────
  // Noble promisified helpers
  // ──────────────────────────────────────────

  _nobleConnect(peripheral) {
    return new Promise((resolve, reject) => {
      peripheral.connect((err) => (err ? reject(err) : resolve()));
    });
  }

  _nobleDiscoverCharacteristics(peripheral) {
    return new Promise((resolve, reject) => {
      peripheral.discoverSomeServicesAndCharacteristics(
        [protocol.SERVICE_UUID_SHORT],
        [protocol.WRITE_CHAR_UUID_SHORT, protocol.READ_CHAR_UUID_SHORT],
        (err, services, characteristics) => {
          if (err) return reject(err);
          resolve({ services, characteristics });
        }
      );
    });
  }

  _nobleSubscribe(characteristic) {
    return new Promise((resolve, reject) => {
      characteristic.subscribe((err) => (err ? reject(err) : resolve()));
    });
  }

  _log(msg) {
    console.log(`[${this.name}] ${msg}`);
  }
}

module.exports = NapoleonFireplace;
