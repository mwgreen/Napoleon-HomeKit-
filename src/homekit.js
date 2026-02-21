/**
 * HomeKit Accessory Bridge for Napoleon eFIRE Fireplace
 *
 * Exposes the fireplace to Apple HomeKit (and therefore Siri) using hap-nodejs.
 *
 * Services exposed:
 *   - HeaterCooler    — main power + flame height (modeled as heating threshold)
 *   - Fan             — blower fan (6 speeds)
 *   - Lightbulb       — LED light strip (on/off + color)
 *   - Switch (Pilot)  — continuous pilot light toggle
 */

'use strict';

const {
  Accessory,
  Service,
  Characteristic,
  uuid,
  Categories,
  CharacteristicEventTypes,
  AccessoryEventTypes,
} = require('hap-nodejs');

const protocol = require('./protocol');

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
  // 1. HeaterCooler Service — main fireplace power + flame height
  // ──────────────────────────────────────────
  const heaterService = accessory.addService(Service.HeaterCooler, 'Fireplace');

  // Active (on/off)
  heaterService
    .getCharacteristic(Characteristic.Active)
    .onGet(() => (fireplace.state.power ? 1 : 0))
    .onSet(async (value) => {
      await fireplace.setPower(value === 1);
    });

  // Current heater state (idle vs heating)
  heaterService
    .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
    .onGet(() => {
      if (!fireplace.state.power) return Characteristic.CurrentHeaterCoolerState.INACTIVE;
      return Characteristic.CurrentHeaterCoolerState.HEATING;
    });

  // Target heater state — lock to HEAT only
  heaterService
    .getCharacteristic(Characteristic.TargetHeaterCoolerState)
    .setProps({
      validValues: [Characteristic.TargetHeaterCoolerState.HEAT],
    })
    .onGet(() => Characteristic.TargetHeaterCoolerState.HEAT)
    .onSet(() => {}); // no-op, always heat

  // Current temperature — we don't have a sensor, report a nominal value
  heaterService
    .getCharacteristic(Characteristic.CurrentTemperature)
    .onGet(() => 21); // 21 C nominal

  // Heating threshold temperature — mapped to flame height (0–6 → 15–35 C range)
  heaterService
    .getCharacteristic(Characteristic.HeatingThresholdTemperature)
    .setProps({ minValue: 15, maxValue: 35, minStep: 3.33 })
    .onGet(() => {
      // Map flame height 0–6 to temperature 15–35
      return 15 + (fireplace.state.flameHeight / protocol.MAX_FLAME_HEIGHT) * 20;
    })
    .onSet(async (value) => {
      // Map temperature 15–35 back to flame height 0–6
      const height = Math.round(((value - 15) / 20) * protocol.MAX_FLAME_HEIGHT);
      await fireplace.setFlameHeight(protocol.clamp(height, 0, protocol.MAX_FLAME_HEIGHT));
    });

  // ──────────────────────────────────────────
  // 2. Fan Service — blower
  // ──────────────────────────────────────────
  const fanService = accessory.addService(Service.Fanv2, 'Blower');

  fanService
    .getCharacteristic(Characteristic.Active)
    .onGet(() => (fireplace.state.blowerSpeed > 0 ? 1 : 0))
    .onSet(async (value) => {
      if (value === 0) {
        await fireplace.setBlowerSpeed(0);
      } else if (fireplace.state.blowerSpeed === 0) {
        await fireplace.setBlowerSpeed(3); // default to mid speed
      }
    });

  // Rotation speed — map 0–100% to 0–6 steps
  fanService
    .getCharacteristic(Characteristic.RotationSpeed)
    .setProps({ minValue: 0, maxValue: 100, minStep: 16.67 })
    .onGet(() => (fireplace.state.blowerSpeed / protocol.MAX_BLOWER_SPEED) * 100)
    .onSet(async (value) => {
      const speed = Math.round((value / 100) * protocol.MAX_BLOWER_SPEED);
      await fireplace.setBlowerSpeed(speed);
    });

  // ──────────────────────────────────────────
  // 3. Lightbulb Service — LED accent light
  // ──────────────────────────────────────────
  const lightService = accessory.addService(Service.Lightbulb, 'Accent Light');

  lightService
    .getCharacteristic(Characteristic.On)
    .onGet(() => fireplace.state.led.on)
    .onSet(async (value) => {
      await fireplace.setLedState(!!value);
    });

  // Brightness — map to a simple 0–100 from the color intensity
  lightService
    .getCharacteristic(Characteristic.Brightness)
    .onGet(() => {
      const { r, g, b } = fireplace.state.led.color;
      return Math.round((Math.max(r, g, b) / 255) * 100);
    })
    .onSet(async (value) => {
      // Scale current color to new brightness
      const { r, g, b } = fireplace.state.led.color;
      const maxC = Math.max(r, g, b) || 1;
      const scale = (value / 100) * 255 / maxC;
      await fireplace.setLedColor(
        Math.min(255, Math.round(r * scale)),
        Math.min(255, Math.round(g * scale)),
        Math.min(255, Math.round(b * scale)),
      );
    });

  // Hue + Saturation for color control
  let pendingHue = 0;
  let pendingSaturation = 100;

  lightService
    .getCharacteristic(Characteristic.Hue)
    .onGet(() => {
      return rgbToHsl(fireplace.state.led.color.r, fireplace.state.led.color.g, fireplace.state.led.color.b).h;
    })
    .onSet(async (value) => {
      pendingHue = value;
      const { r, g, b } = hslToRgb(pendingHue, pendingSaturation, 50);
      await fireplace.setLedColor(r, g, b);
    });

  lightService
    .getCharacteristic(Characteristic.Saturation)
    .onGet(() => {
      return rgbToHsl(fireplace.state.led.color.r, fireplace.state.led.color.g, fireplace.state.led.color.b).s;
    })
    .onSet(async (value) => {
      pendingSaturation = value;
      const { r, g, b } = hslToRgb(pendingHue, pendingSaturation, 50);
      await fireplace.setLedColor(r, g, b);
    });

  // ──────────────────────────────────────────
  // 4. Switch Service — continuous pilot light
  // ──────────────────────────────────────────
  const pilotService = accessory.addService(Service.Switch, 'Pilot Light');

  pilotService
    .getCharacteristic(Characteristic.On)
    .onGet(() => fireplace.state.pilotLight)
    .onSet(async (value) => {
      await fireplace.setContinuousPilot(!!value);
    });

  // ──────────────────────────────────────────
  // Update HomeKit when fireplace state changes
  // ──────────────────────────────────────────
  fireplace.on('stateChanged', (state) => {
    heaterService.updateCharacteristic(Characteristic.Active, state.power ? 1 : 0);
    heaterService.updateCharacteristic(
      Characteristic.CurrentHeaterCoolerState,
      state.power
        ? Characteristic.CurrentHeaterCoolerState.HEATING
        : Characteristic.CurrentHeaterCoolerState.INACTIVE,
    );
    heaterService.updateCharacteristic(
      Characteristic.HeatingThresholdTemperature,
      15 + (state.flameHeight / protocol.MAX_FLAME_HEIGHT) * 20,
    );

    fanService.updateCharacteristic(Characteristic.Active, state.blowerSpeed > 0 ? 1 : 0);
    fanService.updateCharacteristic(
      Characteristic.RotationSpeed,
      (state.blowerSpeed / protocol.MAX_BLOWER_SPEED) * 100,
    );

    lightService.updateCharacteristic(Characteristic.On, state.led.on);
    pilotService.updateCharacteristic(Characteristic.On, state.pilotLight);
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
      category: Categories.AIR_HEATER,
    });
    console.log(`HomeKit accessory "${opts.name}" published.`);
    console.log(`Pair with PIN: ${pincode}`);
  }

  return { accessory, publish };
}

// ──────────────────────────────────────────
// Color conversion helpers
// ──────────────────────────────────────────

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }

  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

/**
 * Generate a stable MAC-like address from a serial string for HAP publishing.
 */
function generateMacAddress(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const bytes = [];
  for (let i = 0; i < 6; i++) {
    bytes.push(((hash >> (i * 4)) & 0xff).toString(16).padStart(2, '0').toUpperCase());
  }
  return bytes.join(':');
}

module.exports = { createAccessory };
