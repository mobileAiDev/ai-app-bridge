'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A real child process supplies the documented devicectl JSON/container-copy
// contract. Tests never consult attached phones or a host's device inventory.
function createIOSRuntimeFixture(directory, { deviceId = 'iphone-wire', bundleId = 'pkg', port,
  runtimeEpoch = 'epoch-1', processId = 42, tunnelState = 'connected', udid = `${deviceId}-udid`,
  schemaVersion = 'aab.ios-runtime/v1', descriptorFilename = 'ai_app_bridge_port.json' } = {}) {
  const configFile = path.join(directory, 'ios-device.json');
  const callsFile = path.join(directory, 'ios-device-calls.jsonl');
  const executable = path.join(directory, 'devicectl-fixture');
  const binding = { schemaVersion, bundleId, runtimeEpoch, processId, port };
  const config = { deviceId, bundleId, descriptorFilename, descriptor: { ...binding, ok: true }, device: {
    identifier: deviceId, hardwareProperties: { platform: 'iOS', udid },
    deviceProperties: { name: 'wire-phone', developerModeStatus: 'enabled', ddiServicesAvailable: true },
    connectionProperties: { pairingState: 'paired', tunnelState, tunnelIPAddress: '127.0.0.1' },
  } };
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
const value = name => args[args.indexOf(name) + 1];
async function main() {
  if (config.hang) {
    fs.writeFileSync(config.hang, String(process.pid));
    process.on('SIGTERM', () => {});
    await new Promise(() => setInterval(() => {}, 1000));
  }
  if (args[0] === 'list' && args[1] === 'devices') {
    fs.writeFileSync(value('--json-output'), JSON.stringify({ result: { devices: [config.device] } }));
    return;
  }
  if (args.slice(0, 3).join(' ') !== 'device copy from' || value('--device') !== config.deviceId
    || value('--domain-type') !== 'appDataContainer' || value('--domain-identifier') !== config.bundleId
    || value('--source') !== 'Documents/' + config.descriptorFilename) throw new Error('wrong container copy target');
  if (config.copyDelayMs) await new Promise(resolve => setTimeout(resolve, config.copyDelayMs));
  if (!config.absent) fs.writeFileSync(value('--destination'), config.rawDescriptor ?? JSON.stringify(config.descriptor));
  fs.writeFileSync(value('--json-output'), JSON.stringify({ result: { copied: true } }));
}
main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
`, { mode: 0o755 });
  return {
    binding, devicectl: executable, config,
    args: { deviceId, bundleId, devicectl: executable, runtimeUrl: `http://127.0.0.1:${port}` },
    update(changes) { Object.assign(config, changes); fs.writeFileSync(configFile, JSON.stringify(config)); },
    calls() { return fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : []; },
  };
}

module.exports = { createIOSRuntimeFixture };
