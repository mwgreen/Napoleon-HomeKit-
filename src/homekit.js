/**
 * HomeKit Accessory Bridge for Napoleon eFIRE Fireplace
 *
 * Exposes the fireplace to Apple HomeKit (and therefore Siri) using hap-nodejs.
 *
 * Services exposed:
 *   - Lightbulb (Fireplace) — flame on/off + flame height as brightness
 *   - Fan (Blower)          — blower on/off + blower speed as rotation speed
 */

'use strict';

const {
  Accessory,
  Service,
  Characteristic,
  uuid,
  Categories,
} = require('hap-nodejs');
const { HapStatusError } = require('hap-nodejs/dist/lib/util/hapStatusError');

const protocol = require('./protocol');

const RF_BUSY = -70402; // HAPStatus.SERVICE_COMMUNICATION_FAILURE

/**
 * Create and return a HAP Accessory for the given NapoleonFireplace instance.
 *
 * @param {import('./fireplace')} fireplace - Connected NapoleonFireplace instance
 * @param {object} opts
 * @param {string} opts.name - Accessory display name
 * @param {string} opts.serialNumber
 * @param {string} [opts.pincode='031-45-154'] - HomeKit pairing PIN
 * @param {number} [opts.port=47129] - HAP server port
 * @returns {{ accessory: Accessory, publish: () => void }}
 */
function createAccessory(fireplace, opts) {
  const accessoryUuid = uuid.generate(`napoleon-fireplace:${opts.serialNumber}`);
  const accessory = new Accessory(opts.name, accessoryUuid);

  // -- Accessory Information --
  accessory
    .getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Manufacturer, 'Napoleon')
    .setCharacteristic(Characteristic.Model, 'eFIRE Bluetooth')
    .setCharacteristic(Characteristic.SerialNumber, opts.serialNumber)
    .setCharacteristic(Characteristic.FirmwareRevision, '1.0.0');

  // ──────────────────────────────────────────
  // 1. Lightbulb Service — flame on/off + flame height as brightness
  //    "Hey Siri, turn on the fireplace" / "Set the fireplace to 80%"
  // ──────────────────────────────────────────
  const flameService = accessory.addService(Service.Lightbulb, 'Fireplace');

  const onChar = flameService.getCharacteristic(Characteristic.On);
  onChar.value = false;
  onChar
    .onGet(() => {
      if (fireplace.state.remoteOverride) throw new HapStatusError(RF_BUSY);
      return fireplace.state.power;
    })
    .onSet(async (value) => {
      if (fireplace.state.remoteOverride) throw new HapStatusError(RF_BUSY);
      console.log(`[HomeKit] Flame set to ${value ? 'ON' : 'OFF'}`);
      await fireplace.setPower(!!value);
      console.log(`[HomeKit] Flame command sent OK`);
    });

  // Brightness = flame height (0-100% mapped to 0-6)
  const flameToPercent = (h) => Math.min(100, Math.round((h / protocol.MAX_FLAME_HEIGHT) * 100));
  const percentToFlame = (p) => Math.round((p / 100) * protocol.MAX_FLAME_HEIGHT);

  const brightnessChar = flameService.getCharacteristic(Characteristic.Brightness);
  brightnessChar.value = 0;
  brightnessChar
    .onGet(() => {
      if (fireplace.state.remoteOverride) throw new HapStatusError(RF_BUSY);
      return fireplace.state.power ? flameToPercent(fireplace.state.flameHeight) : 0;
    })
    .onSet(async (value) => {
      if (fireplace.state.remoteOverride) throw new HapStatusError(RF_BUSY);
      const h = protocol.clamp(percentToFlame(value), 0, protocol.MAX_FLAME_HEIGHT);
      console.log(`[HomeKit] Flame height set to ${h} (${value}%)`);
      if (h === 0 && fireplace.state.power) {
        await fireplace.setPower(false);
        console.log(`[HomeKit] Flame at 0 — powered off`);
      } else if (h > 0 && !fireplace.state.power) {
        await fireplace.setPower(true);
        await fireplace.setFlameHeight(h);
        console.log(`[HomeKit] Powered on + flame height command sent OK`);
      } else {
        await fireplace.setFlameHeight(h);
        console.log(`[HomeKit] Flame height command sent OK`);
      }
    });

  // ──────────────────────────────────────────
  // 2. Fan Service — blower on/off + blower speed
  //    "Hey Siri, turn on the blower" / "Set the blower to 50%"
  // ──────────────────────────────────────────
  const fanService = accessory.addService(Service.Fanv2, 'Blower');

  fanService
    .getCharacteristic(Characteristic.Active)
    .updateValue(0)
    .onGet(() => {
      if (fireplace.state.remoteOverride) throw new HapStatusError(RF_BUSY);
      return fireplace.state.blowerSpeed > 0 ? 1 : 0;
    })
    .onSet(async (value) => {
      if (fireplace.state.remoteOverride) throw new HapStatusError(RF_BUSY);
      console.log(`[HomeKit] Blower set to ${value === 1 ? 'ON' : 'OFF'}`);
      if (value === 0) {
        await fireplace.setBlowerSpeed(0);
      } else if (fireplace.state.blowerSpeed === 0) {
        await fireplace.setBlowerSpeed(3); // default to mid speed
      }
      console.log(`[HomeKit] Blower command sent OK`);
    });

  // Rotation speed = blower speed (0-100% mapped to 0-6)
  fanService
    .getCharacteristic(Characteristic.RotationSpeed)
    .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
    .updateValue(0)
    .onGet(() => {
      if (fireplace.state.remoteOverride) throw new HapStatusError(RF_BUSY);
      return Math.min(100, Math.round((fireplace.state.blowerSpeed / protocol.MAX_BLOWER_SPEED) * 100));
    })
    .onSet(async (value) => {
      if (fireplace.state.remoteOverride) throw new HapStatusError(RF_BUSY);
      const speed = Math.round((value / 100) * protocol.MAX_BLOWER_SPEED);
      console.log(`[HomeKit] Blower speed set to ${speed} (${value}%)`);
      await fireplace.setBlowerSpeed(speed);
      console.log(`[HomeKit] Blower speed command sent OK`);
    });

  // ──────────────────────────────────────────
  // Update HomeKit when fireplace state changes
  // ──────────────────────────────────────────
  // When RF remote takes over, push "Not Responding" to HomeKit
  fireplace.on('remoteOverride', (active) => {
    if (active) {
      const err = new HapStatusError(RF_BUSY);
      flameService.updateCharacteristic(Characteristic.On, err);
      flameService.updateCharacteristic(Characteristic.Brightness, err);
      fanService.updateCharacteristic(Characteristic.Active, err);
      fanService.updateCharacteristic(Characteristic.RotationSpeed, err);
    }
    // When remote releases, stateChanged will push real values
  });

  fireplace.on('stateChanged', (state) => {
    flameService.updateCharacteristic(Characteristic.On, state.power);
    flameService.updateCharacteristic(Characteristic.Brightness, state.power ? flameToPercent(state.flameHeight) : 0);
    fanService.updateCharacteristic(Characteristic.Active, state.blowerSpeed > 0 ? 1 : 0);
    fanService.updateCharacteristic(
      Characteristic.RotationSpeed,
      Math.min(100, Math.round((state.blowerSpeed / protocol.MAX_BLOWER_SPEED) * 100)),
    );
  });

  // ──────────────────────────────────────────
  // Publish
  // ──────────────────────────────────────────
  const pincode = opts.pincode || '031-45-154';
  const port = opts.port || 47129;

  function publish() {
    accessory.publish({
      username: generateMacAddress(opts.serialNumber),
      pincode,
      port,
      bind: '0.0.0.0',
      category: Categories.AIR_HEATER,
    });
    console.log(`HomeKit accessory "${opts.name}" published.`);
    console.log(`Pair with PIN: ${pincode}`);
  }

  return { accessory, publish };
}

/**
 * Generate a stable MAC-like address from a serial string for HAP publishing.
 */
function generateMacAddress(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + ts.charCodeAt(i)) | 0;
  }
  const bytes = [];
  for (let i = 0; i < 6; i++) {
    bytes.push(((hash >> (i * 4)) & 0xff).toString(16).padStart(2, '0').toUpperCase());
  }
  return bytes.join(':');
}

module.exports = { createAccessory };
