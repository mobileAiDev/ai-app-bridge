'use strict';

// A declared no-SIM fixture for the authorized OPPOs. This controller owns only
// Wi-Fi setup; App observations and interactions remain in the public Script.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const VPN_PACKAGE = 'io.nekohasekai.sfa';

function field(text, pattern, name) {
  const matches = [...text.matchAll(new RegExp(pattern.source, 'g'))];
  assert.equal(matches.length, 1, `Unrecognized Android network field: ${name}`);
  return matches[0];
}

function networkAgent(raw) {
  const [, netId, type, state, extra] = field(raw,
    /^\s*NetworkAgentInfo\{network\{([1-9][0-9]*)\}\s+handle\{[0-9]+\}\s+ni\{([A-Z_]+) ([A-Z_]+) extra: ([^}]*)\}/, 'network identity');
  // Android reports CONNECTING before it assigns LinkProperties. Such agents
  // remain explicit pending observations and can never satisfy either gate.
  if (state !== 'CONNECTED') return { raw, netId, type, state };
  const capabilities = field(raw, /\bnc\{\[ (.*)\]\}\s+factorySerialNumber=/, 'network capabilities')[1];
  const transports = field(capabilities, /^Transports: ([A-Z_]+(?:\|[A-Z_]+)*) /, 'transports')[1].split('|');
  const underlying = field(capabilities, /\bUnderlyingNetworks: (Null|\[(?:[0-9]+(?:, ?[0-9]+)*)?\])$/, 'underlying networks')[1];
  const agent = { raw, netId, type, state, transports,
    capabilities: field(capabilities, /\bCapabilities: ([A-Z_]+(?:&[A-Z_]+)*) /, 'capabilities')[1].split('&'),
    interfaceName: field(raw, /\blp\{\{InterfaceName: ([^ ]+) /, 'interface')[1],
    underlyingNetworks: underlying === 'Null' ? null : JSON.parse(underlying).map(String) };
  if (type === 'VPN') {
    const transport = field(capabilities,
      /TransportInfo: <VpnTransportInfo\{type=([0-9]+), sessionId=(.*?), bypassable=(true|false) longLivedTcpConnectionsExpensive=(true|false)\}>/, 'VPN transport identity');
    agent.vpn = {
      packageName: field(extra, /^VPN:([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)$/, 'VPN package')[1],
      ownerUid: field(capabilities, /\bOwnerUid: ([0-9]+)\b/, 'VPN owner UID')[1],
      type: transport[1], sessionId: transport[2], bypassable: transport[3] === 'true',
      uidRanges: field(capabilities, /\bUids: <(\{[0-9]+(?:-[0-9]+)?(?:, ?[0-9]+(?:-[0-9]+)?)*\})>/, 'VPN UID ranges')[1],
    };
  }
  return agent;
}

function connectivity(raw) {
  const lines = raw.split('\n');
  const defaults = lines.filter(line => line.startsWith('Active default network: '));
  assert.equal(defaults.length, 1, 'Unrecognized Android connectivity output');
  const defaultNetwork = defaults[0].slice('Active default network: '.length);
  assert(/^(none|[1-9][0-9]*)$/.test(defaultNetwork), 'Unrecognized Android default network');
  const start = lines.indexOf('Current Networks:'), end = lines.indexOf('Status for known UIDs:');
  assert(start >= 0 && end > start, 'Unrecognized Android Current Networks section');
  const agents = lines.slice(start + 1, end).filter(line => /^\s*NetworkAgentInfo\{/.test(line)).map(networkAgent);
  assert.equal(new Set(agents.map(agent => agent.netId)).size, agents.length, 'Duplicate Android network identity');
  return { defaultNetwork, agents, connected: agents.filter(agent => agent.state === 'CONNECTED').map(agent => agent.raw) };
}

function connectedWifiError(sample) {
  if (sample.sim !== 'ABSENT,ABSENT') return 'both_sim_slots_must_be_absent';
  if (sample.wifi !== '1') return 'wifi_not_enabled';
  if (sample.network.agents.some(agent => agent.state !== 'CONNECTED')) return 'network_agent_not_connected';
  const physical = sample.network.agents.filter(agent => agent.type !== 'VPN');
  if (physical.length !== 1 || physical[0].type !== 'WIFI') return 'unique_physical_wifi_network_required';
  const wifi = physical[0];
  if (wifi.transports.join('|') !== 'WIFI' || wifi.interfaceName !== 'wlan0' || wifi.underlyingNetworks !== null)
    return 'unsupported_wifi_transport';
  if (sample.network.defaultNetwork !== wifi.netId) return 'wifi_default_network_mismatch';
  if (sample.wifiIdentity.length !== 1) return 'wifi_identity_not_unique';
  if (!sample.interfaces.some(item => item.ifname === 'wlan0' && item.operstate === 'UP'
      && item.addr_info.some(address => address.family === 'inet' && address.scope === 'global'))) return 'wifi_interface_not_ready';
  const vpns = sample.network.agents.filter(agent => agent.type === 'VPN');
  if (vpns.length > 1) return 'multiple_vpn_networks_not_supported';
  if (vpns.length === 1) {
    const vpn = vpns[0];
    if (vpn.vpn.packageName !== VPN_PACKAGE) return 'vpn_package_not_supported';
    if (vpn.transports.join('|') !== 'WIFI|VPN') return 'vpn_transports_not_wifi_overlay';
    if (JSON.stringify(vpn.underlyingNetworks) !== JSON.stringify([wifi.netId])) return 'vpn_underlying_network_mismatch';
  }
  return null;
}

function originalRadioError(sample, before) {
  if (sample.sim !== before.sim || sample.data !== before.data || sample.airplane !== before.airplane)
    return 'original_radio_state_changed';
  return null;
}

function disconnectedError(sample, before) {
  if (sample.sim !== 'ABSENT,ABSENT') return 'both_sim_slots_must_be_absent';
  if (sample.wifi !== '0') return 'wifi_not_disabled';
  if (sample.network.defaultNetwork !== 'none') return 'default_network_still_present';
  const wlan = sample.interfaces.find(item => item.ifname === 'wlan0');
  if (wlan?.operstate !== 'DOWN' || wlan.addr_info.length !== 0) return 'wifi_interface_still_active';
  const radioError = originalRadioError(sample, before);
  if (radioError) return radioError;
  if (sample.network.agents.some(agent => agent.type !== 'VPN')) return 'physical_network_still_present';
  const vpns = sample.network.agents;
  if (vpns.length > 1) return 'multiple_vpn_networks_not_supported';
  if (vpns.length === 1) {
    const original = before.network.agents.find(agent => agent.type === 'VPN'), vpn = vpns[0];
    if (vpn.state !== 'CONNECTED') return 'vpn_isolation_state_unconfirmed';
    if (!original || JSON.stringify(vpn.vpn) !== JSON.stringify(original.vpn)) return 'vpn_identity_changed';
    if (vpn.transports.join('|') !== 'VPN') return 'vpn_isolation_state_unconfirmed';
    if (vpn.underlyingNetworks !== null && vpn.underlyingNetworks.length !== 0) return 'vpn_underlying_network_still_declared';
  }
  return null;
}

function restoredError(sample, before) {
  const error = connectedWifiError(sample) || originalRadioError(sample, before);
  if (error) return error;
  if (JSON.stringify(sample.wifiIdentity) !== JSON.stringify(before.wifiIdentity)) return 'original_wifi_identity_not_restored';
  const vpnIdentity = value => value.network.agents.filter(agent => agent.type === 'VPN').map(agent => agent.vpn);
  if (JSON.stringify(vpnIdentity(sample)) !== JSON.stringify(vpnIdentity(before))) return 'original_vpn_identity_not_restored';
  for (const original of before.network.agents) {
    const current = sample.network.agents.find(agent => agent.type === original.type);
    if (['INTERNET', 'VALIDATED'].some(capability => original.capabilities.includes(capability)
        && !current.capabilities.includes(capability))) return 'original_network_capabilities_not_restored';
  }
  return null;
}

const connectedWifi = sample => connectedWifiError(sample) === null;
const disconnected = (sample, before) => disconnectedError(sample, before) === null;

function createNoPeerFixture({ serial, directory }) {
  assert(['b46093e6', 'FYZLAU49X8OVQGJ7'].includes(serial), 'Explicit authorized OPPO required');
  const journal = { serial, condition: 'no-sim-wifi-disconnected', commands: [], active: null };
  let sequence = 0;
  const save = () => fs.writeFileSync(path.join(directory, 'network-journal.json'), JSON.stringify(journal, null, 2) + '\n');
  function adb(args) {
    const record = { atMs: Date.now(), args };
    journal.commands.push(record); save();
    try {
      record.stdout = execFileSync('adb', ['-s', serial, 'shell', ...args], { encoding: 'utf8', timeout: 15000 });
      return record.stdout.trim();
    } catch (error) { record.error = error.message; throw error; }
    finally { record.completedAtMs = Date.now(); save(); }
  }
  function sample() {
    const atMs = Date.now();
    const wifi = adb(['settings', 'get', 'global', 'wifi_on']);
    const sim = adb(['getprop', 'gsm.sim.state']);
    const data = adb(['settings', 'get', 'global', 'mobile_data']);
    const airplane = adb(['cmd', 'connectivity', 'airplane-mode']);
    const network = connectivity(adb(['dumpsys', 'connectivity']));
    const interfaces = JSON.parse(adb(['ip', '-j', 'addr']));
    const wifiStatus = adb(['cmd', 'wifi', 'status']);
    const wifiIdentity = wifiStatus.split('\n').filter(line => line.startsWith('Wifi is connected to '));
    return { atMs, completedAtMs: Date.now(), wifi, sim, data, airplane, network, interfaces, wifiIdentity };
  }
  async function until(check) {
    const deadline = Date.now() + 15000;
    let error;
    do {
      const observed = sample();
      error = check(observed);
      if (error === null) return observed;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    throw Error(`Network fixture condition failed: ${error} (15 second deadline); inspect network-journal.json`);
  }
  function recorded(checkpoint, phase, before, observed) {
    const document = { kind: 'localsend.no-peer-fixture-result/v1', serial, checkpoint, phase,
      condition: journal.condition, verdict: 'passed', before, observed };
    const file = path.join(directory, `network-${++sequence}-${checkpoint}-${phase}.json`);
    fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
    // The immutable companion file owns raw OS observations. Keep Agent replies
    // and the Script result small instead of duplicating those observations.
    return { kind: document.kind, serial, checkpoint, phase, condition: journal.condition, verdict: document.verdict,
      artifact: { path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') } };
  }
  async function isolate(checkpoint) {
    assert.equal(journal.active, null, 'A network fixture is already active');
    const before = sample();
    const error = connectedWifiError(before);
    assert.equal(error, null, `Network fixture precondition failed: ${error}`);
    journal.active = { checkpoint, before }; save();
    adb(['svc', 'wifi', 'disable']);
    return recorded(checkpoint, 'isolate', before, await until(value => disconnectedError(value, before)));
  }
  async function verify(checkpoint) {
    assert.equal(journal.active?.checkpoint, checkpoint, 'No matching active network fixture');
    const observed = sample();
    const error = disconnectedError(observed, journal.active.before);
    assert.equal(error, null, `No-peer network condition changed: ${error}`);
    return recorded(checkpoint, 'verify', journal.active.before, observed);
  }
  async function restore(checkpoint) {
    assert.equal(journal.active?.checkpoint, checkpoint, 'No matching network fixture to restore');
    const before = journal.active.before;
    adb(['svc', 'wifi', 'enable']);
    const observed = await until(value => restoredError(value, before));
    const result = recorded(checkpoint, 'restore', before, observed);
    journal.active = null; save();
    return result;
  }
  return { isolate, verify, restore, cleanup: async () => journal.active ? restore(journal.active.checkpoint) : null };
}

module.exports = { createNoPeerFixture, connectivity, disconnected, connectedWifi,
  connectedWifiError, disconnectedError, restoredError };
