#!/usr/bin/env node

/**
 * Napoleon eFIRE BLE Scanner
 *
 * Scans for nearby Napoleon fireplaces and prints their BLE peripheral IDs.
 * Use the discovered ID in your config.json.
 *
 * Usage: npm run scan
 */

'use strict';

const noble = require('@abandonware/noble');
const protocol = require('./protocol');

const SCAN_DURATION_MS = 15000;
const found = new Map();

console.log('Scanning for Napoleon eFIRE fireplaces...');
console.log(`(will scan for ${SCAN_DURATION_MS / 1000} seconds)\n`);

noble.on('stateChange', (state) => {
  if (state === 'poweredOn') {
    // Scan for all peripherals (some fireplaces may not advertise the service UUID)
    noble.startScanning([], false);
  } else {
    console.error(`Bluetooth state: ${state}`);
    if (state === 'poweredOff') {
      console.error('Please enable Bluetooth and try again.');
      process.exit(1);
    }
  }
});

noble.on('discover', (peripheral) => {
  const name = peripheral.advertisement?.localName || '';
  const id = peripheral.id || peripheral.address || '';

  // Napoleon eFIRE devices advertise names like "NAP_FPC_XXXX" by default
  const isNapoleon = name.toUpperCase().startsWith('NAP_FPC') ||
    name.toUpperCase().startsWith('NAP_') ||
    (peripheral.advertisement?.serviceUuids || []).some(
      (u) => u.toLowerCase() === protocol.SERVICE_UUID_SHORT
    );

  if (isNapoleon && !found.has(id)) {
    found.set(id, { name, id, rssi: peripheral.rssi });
    console.log(`  Found: ${name || '(unnamed)'}`);
    console.log(`    ID:   ${id}`);
    console.log(`    RSSI: ${peripheral.rssi} dBm`);
    console.log();
  }
});

setTimeout(() => {
  noble.stopScanning();
  console.log('Scan complete.');

  if (found.size === 0) {
    console.log('\nNo Napoleon fireplaces found.');
    console.log('Make sure:');
    console.log('  1. The fireplace is powered on');
    console.log('  2. No other device (eFIRE app) is connected to it');
    console.log('  3. Bluetooth is enabled on this machine');
    console.log('  4. You have Bluetooth permissions (on Linux, run with sudo)');
  } else {
    console.log(`\nFound ${found.size} fireplace(s).`);
    console.log('Copy the ID into your config.json as "peripheralId".');
  }

  process.exit(0);
}, SCAN_DURATION_MS);
