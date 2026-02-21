# Napoleon HomeKit Bridge

Control your Napoleon eFIRE Bluetooth fireplace with Apple Siri and the Home app.

This project creates a HomeKit accessory bridge that communicates with Napoleon
fireplaces over Bluetooth Low Energy (BLE) and exposes them as native HomeKit
devices. Once paired, you can use Siri voice commands or the Home app on any
Apple device.

## Siri Commands

After pairing, try:

- **"Hey Siri, turn on the fireplace"**
- **"Hey Siri, turn off the fireplace"**
- **"Hey Siri, set the fireplace to 30 degrees"** (controls flame height)
- **"Hey Siri, turn on the blower"**
- **"Hey Siri, set the blower to 50 percent"**
- **"Hey Siri, turn on the accent light"**
- **"Hey Siri, turn off the pilot light"**

## HomeKit Services

| Service       | What it controls                       |
|---------------|----------------------------------------|
| HeaterCooler  | Power on/off, flame height (as temp)   |
| Fan           | Blower fan on/off and speed (6 steps)  |
| Lightbulb     | LED accent light on/off, color, brightness |
| Switch        | Continuous pilot light on/off          |

## Requirements

- **Mac** (macOS 12+) or **Raspberry Pi** (with Bluetooth 4.0+ adapter)
- Node.js 18 or later
- A Napoleon fireplace with an eFIRE Bluetooth controller
- An iPhone/iPad on the same network for HomeKit pairing

### Raspberry Pi Prerequisites

```bash
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev
```

On Raspberry Pi you will need to run with `sudo` or grant the node binary
Bluetooth capabilities:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

## Setup

1. **Clone and install:**

```bash
git clone https://github.com/mwgreen/Napoleon-HomeKit-.git
cd Napoleon-HomeKit-
npm install
```

2. **Find your fireplace:**

Make sure no other device (eFIRE app) is connected, then:

```bash
npm run scan
```

This scans for nearby Napoleon fireplaces and prints their BLE peripheral ID.

3. **Configure:**

Edit `config.json` (created on first run) with your fireplace's peripheral ID:

```json
{
  "name": "Napoleon Fireplace",
  "peripheralId": "aa:bb:cc:dd:ee:ff",
  "password": "1234",
  "pincode": "031-45-154",
  "port": 47129
}
```

| Field          | Description                                          |
|----------------|------------------------------------------------------|
| `name`         | Display name in the Home app                         |
| `peripheralId` | BLE address from `npm run scan`                      |
| `password`     | 4-digit eFIRE PIN (default is `1234`)                |
| `pincode`      | HomeKit pairing code (format: `XXX-XX-XXX`)          |
| `port`         | HAP server port (change if running multiple bridges)  |

4. **Start the bridge:**

```bash
npm start
```

5. **Pair with HomeKit:**

Open the **Home** app on your iPhone, tap **+** > **Add Accessory**, and either
scan the QR code shown in the terminal or enter the PIN manually.

## Running as a Service (Raspberry Pi)

Create a systemd service to start automatically on boot:

```bash
sudo tee /etc/systemd/system/napoleon-homekit.service << 'EOF'
[Unit]
Description=Napoleon HomeKit Bridge
After=bluetooth.target network-online.target
Wants=bluetooth.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/Napoleon-HomeKit-
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable napoleon-homekit
sudo systemctl start napoleon-homekit
```

## Known Limitations

- **Exclusive BLE connection:** While this bridge is connected, the Napoleon
  eFIRE mobile app cannot connect to the fireplace (BLE allows only one central
  device at a time).

- **RF remote override:** If you use the physical RF remote, it overrides the
  Bluetooth controller and the bridge will lose the ability to send commands or
  read state until the fireplace is power-cycled. Remove batteries from the RF
  remote if you want to use this bridge exclusively.

- **No temperature sensor:** Napoleon fireplaces don't report ambient
  temperature. The HeaterCooler "temperature" setting is mapped to flame height
  (6 steps across a 15-35 C range).

## Project Structure

```
src/
  index.js      - Entry point, config loading, startup
  fireplace.js  - BLE client for Napoleon eFIRE communication
  protocol.js   - eFIRE BLE protocol encoding/decoding
  homekit.js    - HomeKit accessory definition (hap-nodejs)
  scanner.js    - BLE discovery utility
  __tests__/    - Unit tests
config.json     - Your fireplace configuration
persist/        - HomeKit pairing state (auto-created)
```

## Credits

The BLE protocol implementation is based on the reverse-engineering work by
[Felix Kaechele](https://github.com/kaechele) in the
[bonaparte](https://github.com/kaechele/bonaparte) Python library.

## License

MIT
