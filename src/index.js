#!/usr/bin/env node

/**
 * Napoleon HomeKit Bridge
 *
 * Connects to a Napoleon eFIRE Bluetooth fireplace and exposes it as a
 * HomeKit accessory. Once paired, you can control it with Siri:
 *
 *   "Hey Siri, turn on the fireplace"
 *   "Hey Siri, set the fireplace to 30 degrees"
 *   "Hey Siri, turn on the blower"
 *   "Hey Siri, turn off the pilot light"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { HAPStorage } = require('hap-nodejs');
const NapoleonFireplace = require('./fireplace');
const { createAccessory } = require('./homekit');

// ──────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const PERSIST_DIR = path.join(__dirname, '..', 'persist');

function loadConfig() {
  const defaults = {
    name: 'Napoleon Fireplace',
    peripheralId: '',
    password: '1234',
    pincode: '031-45-154',
    port: 47129,
  };

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('No config.json found. Creating a template...');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2) + '\n');
    console.error(`Edit ${CONFIG_PATH} and set your peripheralId (run "npm run scan" to find it).`);
    process.exit(1);
  }

  const config = { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };

  if (!config.peripheralId) {
    console.error('peripheralId is required in config.json.');
    console.error('Run "npm run scan" to discover nearby Napoleon fireplaces.');
    process.exit(1);
  }

  return config;
}

// ──────────────────────────────────────────
// Main
// ──────────────────────────────────────────

async function main() {
  const config = loadConfig();

  // Ensure persist directory for HAP state
  if (!fs.existsSync(PERSIST_DIR)) {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
  }
  HAPStorage.setCustomStoragePath(PERSIST_DIR);

  console.log('Napoleon HomeKit Bridge');
  console.log('=======================');
  console.log(`Fireplace: ${config.name}`);
  console.log(`BLE ID:    ${config.peripheralId}`);
  console.log();

  // Create BLE fireplace client
  const fireplace = new NapoleonFireplace({
    peripheralId: config.peripheralId,
    password: config.password,
    name: config.name,
  });

  // Connect to fireplace
  try {
    await fireplace.connect();
  } catch (err) {
    console.error(`Failed to connect: ${err.message}`);
    console.error('Make sure the fireplace is powered on, Bluetooth is enabled,');
    console.error('and no other app (eFIRE) is connected to it.');
    process.exit(1);
  }

  // Create and publish HomeKit accessory
  const { publish } = createAccessory(fireplace, {
    name: config.name,
    serialNumber: config.peripheralId,
    pincode: config.pincode,
    port: config.port,
  });

  publish();

  console.log();
  console.log('Open the Home app on your iPhone and tap "Add Accessory".');
  console.log(`Use PIN: ${config.pincode}`);
  console.log();
  console.log('Once paired, try: "Hey Siri, turn on the fireplace"');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await fireplace.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
