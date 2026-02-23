/**
 * Napoleon eFIRE Fireplace — BLE Client
 *
 * Manages the Bluetooth Low Energy connection to a Napoleon fireplace
 * and provides a high-level API for controlling it.
 */

'use strict';

const EventEmitter = require('events');
const noble = require('@stoprocent/noble');
const protocol = require('./protocol');

const CONNECT_TIMEOUT_MS = 20000;
const COMMAND_TIMEOUT_MS = 8000;
const DISCONNECT_IDLE_MS = 0; // 0 = stay connected (HomeKit needs low latency)
const POLL_INTERVAL_MS = 60000;
const REMOTE_OVERRIDE_POLL_MS = 10000; // poll faster when remote override is active
const RECONNECT_DELAY_MS = 10000;

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
    this._pendingCommand = null; // expected response command byte

    // Command queue — serializes BLE writes so they don't clobber each other
    this._commandQueue = Promise.resolve();
    this._recovering = false;
    this._remoteProbing = false;

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
    this._discovered = false;

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
    // Guard against multiple discover callbacks firing
    if (this._discovered) return;

    const id = peripheral.id || peripheral.address;
    if (!id) return;

    // Match by peripheral ID or by advertised local name
    const nameMatch = peripheral.advertisement?.localName?.toLowerCase().includes('nap_fpc') ||
                      peripheral.advertisement?.localName?.toLowerCase().includes(this.peripheralId);
    const idMatch = id.toLowerCase().replace(/:/g, '') === this.peripheralId.replace(/:/g, '');

    if (!idMatch && !nameMatch) return;

    // Prevent re-entry
    this._discovered = true;
    noble.stopScanning();
    noble.removeListener('discover', this._onDiscover);
    this._log(`Found fireplace: ${peripheral.advertisement?.localName || id}`);

    try {
      await this._connectToPeripheral(peripheral);
      if (this._connectResolve) this._connectResolve(null);
    } catch (err) {
      if (this._connectResolve) this._connectResolve(err);
    }
  }

  async _connectToPeripheral(peripheral) {
    // Clean up old peripheral listeners if reconnecting
    if (this._peripheral && this._peripheral !== peripheral) {
      this._peripheral.removeAllListeners('disconnect');
    }
    this._peripheral = peripheral;

    peripheral.removeAllListeners('disconnect');
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
    this._log('Authenticated. Syncing to known off state...');

    // Force fireplace to a known "off" state on startup.
    // The BLE controller remembers its last commanded state, which may not
    // reflect reality if the RF remote was used. Start clean.
    try {
      await this.sendCommand(protocol.buildSetIFCCmd2(0, 0, false, false));
      await this.sendCommand(protocol.buildSetIFCCmd1(false, false, 0, false));
      await this.sendCommand(protocol.buildSetPower(false));
    } catch (err) {
      this._log(`Initial sync warning: ${err.message}`);
    }
    this.state.power = false;
    this.state.flameHeight = 0;
    this.state.blowerSpeed = 0;
    this.state.mainMode = protocol.MainMode.OFF;
    this.emit('connected');

    // Start polling
    this._startPolling();
  }

  _scheduleReconnect() {
    this._stopPolling();
    this._reconnectAttempt = (this._reconnectAttempt || 0) + 1;
    const delay = Math.min(RECONNECT_DELAY_MS * this._reconnectAttempt, 120000); // max 2 min
    this._log(`Reconnect attempt ${this._reconnectAttempt} in ${delay / 1000}s...`);
    this._reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this._reconnectAttempt = 0; // reset on success
      } catch (err) {
        this._log(`Reconnect failed: ${err.message}`);
        this._scheduleReconnect();
      }
    }, delay);
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
  sendCommand(message) {
    // Queue commands so only one BLE write is in flight at a time
    const run = async () => {
      // Fail fast if remote override is active (unless probing for release)
      if (this.state.remoteOverride && !this._remoteProbing) {
        throw new Error('RF remote override — command skipped');
      }

      // Auto-reconnect if connection was lost
      if (!this._connected || !this._writeChar) {
        this._log('Not connected — attempting reconnect before command...');
        await this.connect();
      }

      // Extract the command byte from the message (byte index 3)
      const sentCommand = message[3];

      return new Promise((resolve, reject) => {
        this._pendingResolve = resolve;
        this._pendingReject = reject;
        this._pendingCommand = sentCommand;
        this._pendingTimeout = setTimeout(() => {
          this._rejectPending(new Error(`Command 0x${sentCommand.toString(16)} timed out`));
        }, COMMAND_TIMEOUT_MS);

        // Use write-with-response (false) — the ff01 characteristic requires it
        this._writeChar.write(message, false, (err) => {
          if (err) {
            this._rejectPending(err);
          }
        });
      });
    };

    // Chain onto the queue so commands run sequentially
    this._commandQueue = this._commandQueue.then(run, run);
    return this._commandQueue;
  }

  _onNotification(data) {
    const buf = Buffer.from(data);
    const resp = protocol.parseResponse(buf);
    if (!resp) {
      this._log(`Invalid response: ${buf.toString('hex')}`);
      return;
    }

    // Handle remote override notifications (0xEE) — can arrive at any time
    if (resp.command === protocol.Command.GET_REMOTE_USAGE) {
      // 0x00 = remote IS in use, 0xFF = remote NOT in use
      const remoteActive = resp.payload.length > 0 && resp.payload[0] === 0x00;

      if (remoteActive && !this.state.remoteOverride) {
        this.state.remoteOverride = true;
        this._log('RF remote has taken over — BLE commands blocked');
        this.emit('remoteOverride', true);
        this._startRemoteOverridePoll();
      } else if (!remoteActive && this.state.remoteOverride) {
        this.state.remoteOverride = false;
        this._log('RF remote released — BLE commands resumed');
        this.emit('remoteOverride', false);
        this._stopRemoteOverridePoll();
        if (!this._recovering) {
          this._recovering = true;
          this._syncAfterRemote().finally(() => { this._recovering = false; });
        }
      }

      // If there's a pending command, reject it immediately
      if (this._pendingResolve && remoteActive && this._pendingCommand !== protocol.Command.GET_REMOTE_USAGE) {
        clearTimeout(this._pendingTimeout);
        const reject = this._pendingReject;
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingTimeout = null;
        this._pendingCommand = null;
        reject(new Error('RF remote override'));
      }
      return;
    }

    // Handle 0xEC — unsolicited IFC state broadcast from the controller.
    // Sent when the RF remote changes the fireplace state.
    // Payload: [status, flags] where flags matches CMD2 format (flame in bits 0-2).
    if (resp.command === 0xec) {
      const flags = resp.payload.length >= 2 ? resp.payload[1] : resp.payload[0];
      const flame = flags & 0x07;
      const blower = (flags >> 4) & 0x07;
      this.state.flameHeight = flame;
      this.state.blowerSpeed = blower;
      this.state.power = flame > 0;
      this._log(`IFC state broadcast: flame=${flame} blower=${blower} power=${this.state.power}`);
      this.emit('stateChanged', this.state);
      return;
    }

    if (this._pendingResolve && resp.command === this._pendingCommand) {
      // This is the response to our pending command
      clearTimeout(this._pendingTimeout);
      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingReject = null;
      this._pendingTimeout = null;
      this._pendingCommand = null;
      resolve(resp);
    } else {
      // Unsolicited notification — log and emit
      this._log(`Unsolicited notification: cmd=0x${resp.command.toString(16)} payload=${resp.payload.toString('hex')}`);
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
      this._pendingCommand = null;
      reject(err);
    }
  }

  // ──────────────────────────────────────────
  // Authentication
  // ──────────────────────────────────────────

  async _authenticate() {
    const resp = await this.sendCommand(protocol.buildSendPassword(this.password));
    const code = resp.payload.length > 0 ? resp.payload[0] : null;
    this._log(`Auth response: 0x${code?.toString(16) ?? 'none'}`);

    if (code === protocol.PasswordResult.LOGIN_SUCCESS) {
      this._log('Authentication successful');
    } else if (code === protocol.PasswordResult.INVALID_PASSWORD) {
      throw new Error('Authentication failed — wrong eFIRE PIN');
    } else {
      throw new Error(`Authentication failed — unexpected response: 0x${code?.toString(16) ?? 'none'}`);
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
   * When remote override is detected, poll frequently to detect when it clears.
   * Sends a simple GET command — if it succeeds, the remote has released.
   */
  _startRemoteOverridePoll() {
    this._stopRemoteOverridePoll();
    this._stopPolling(); // pause normal polling
    this._remoteOverrideTimer = setInterval(async () => {
      if (this._recovering) return; // recovery already in progress
      try {
        // Probe by bypassing the remote override check in sendCommand
        this._remoteProbing = true;
        await this.sendCommand(protocol.buildGetIFCCmd1State());
        this._remoteProbing = false;
        // If we got here, the remote released — recover
        this.state.remoteOverride = false;
        this._log('Remote override cleared (poll) — recovering');
        this.emit('remoteOverride', false);
        this._stopRemoteOverridePoll();
        this._recovering = true;
        await this._syncAfterRemote();
        this._recovering = false;
      } catch (_) {
        this._remoteProbing = false;
        // Still locked out
      }
    }, REMOTE_OVERRIDE_POLL_MS);
  }

  _stopRemoteOverridePoll() {
    if (this._remoteOverrideTimer) {
      clearInterval(this._remoteOverrideTimer);
      this._remoteOverrideTimer = null;
    }
  }

  /**
   * After the RF remote releases, sync the BLE controller to match
   * the physical state (tracked via 0xEC broadcasts).
   */
  async _syncAfterRemote() {
    try {
      // Let the BLE controller settle after the RF remote session
      await new Promise(r => setTimeout(r, 2000));

      // Re-authenticate — RF remote session may have invalidated our BLE auth
      await this._authenticate();

      if (this.state.power) {
        // Fireplace is on — sync BLE controller to current flame/blower
        await this.sendCommand(protocol.buildSetPower(true));
        await this.sendCommand(
          protocol.buildSetIFCCmd1(true, false, this.state.nightLightLevel, this.state.pilotLight)
        );
        await this.sendCommand(
          protocol.buildSetIFCCmd2(this.state.flameHeight, this.state.blowerSpeed, this.state.aux, this.state.splitFlow)
        );
      } else {
        // Fireplace is off — sync BLE controller to off
        await this.sendCommand(protocol.buildSetIFCCmd2(0, 0, false, false));
        await this.sendCommand(protocol.buildSetIFCCmd1(false, false, 0, false));
        await this.sendCommand(protocol.buildSetPower(false));
      }
      this._log('BLE controller synced to physical state after remote');
    } catch (err) {
      this._log(`Post-remote sync warning: ${err.message}`);
    }
    this._startPolling();
  }

  /**
   * Query the fireplace for its current state and update this.state.
   */
  async updateState() {
    // IFC CMD1: thermostat mode, night light, pilot
    // Note: We do NOT update this.state.power from CMD1 here because the BLE
    // controller returns stale power state that doesn't reflect our SET commands
    // or RF remote changes. Power is tracked from our own setPower() calls and
    // 0xEC state broadcasts from the RF remote.
    try {
      const cmd1Resp = await this.sendCommand(protocol.buildGetIFCCmd1State());
      const parsed = protocol.parseIFCCmd1State(cmd1Resp.payload);
      if (parsed) {
        this.state.thermostat = parsed.thermostat;
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
        // When power is off, the BLE controller still reports the last commanded
        // flame/blower values. Override to 0 so HomeKit shows the correct state.
        this.state.flameHeight = this.state.power ? parsed.flameHeight : 0;
        this.state.blowerSpeed = this.state.power ? parsed.blowerSpeed : 0;
        this.state.aux = parsed.aux;
        this.state.splitFlow = parsed.splitFlow;
      }
    } catch (err) {
      this._log(`Failed to get IFC CMD2 state: ${err.message}`);
    }

    // Note: GET_POWER (0xE7) is not supported on WLT8258 controllers.
    // Power state is already read from IFC CMD1.

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
    if (on) {
      // Power on: SET_POWER first, then SET_IFC_CMD1 for manual mode
      await this.sendCommand(protocol.buildSetPower(true));
      await this.sendCommand(
        protocol.buildSetIFCCmd1(true, false, this.state.nightLightLevel, this.state.pilotLight)
      );
    } else {
      // Power off: zero controls first, then CMD1 off, then SET_POWER off
      await this.sendCommand(
        protocol.buildSetIFCCmd2(0, 0, false, false)
      );
      await this.sendCommand(
        protocol.buildSetIFCCmd1(false, false, this.state.nightLightLevel, this.state.pilotLight)
      );
      await this.sendCommand(protocol.buildSetPower(false));
    }
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
