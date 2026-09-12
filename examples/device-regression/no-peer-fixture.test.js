'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { connectivity, connectedWifi, disconnected, connectedWifiError, disconnectedError, restoredError } = require('./no-peer-fixture');

// Contract-relevant fields copied from android-suite-20260912-03's Current
// Networks record. Unused SSID, addresses, routes and request lists are omitted.
const wifiLine = '  NetworkAgentInfo{network{443}  handle{1906076209165}  ni{WIFI CONNECTED extra: }  lp{{InterfaceName: wlan0 }}  nc{[ Transports: WIFI Capabilities: NOT_METERED&INTERNET&NOT_RESTRICTED&TRUSTED&NOT_VPN&VALIDATED&NOT_ROAMING&FOREGROUND&NOT_CONGESTED&NOT_SUSPENDED&NOT_VCN_MANAGED&NOT_BANDWIDTH_CONSTRAINED OwnerUid: 1000 AdminUids: [1000] UnderlyingNetworks: Null]}  factorySerialNumber=6}';
const vpnLine = '  NetworkAgentInfo{network{445}  handle{1914666143757}  ni{VPN CONNECTED extra: VPN:io.nekohasekai.sfa}  lp{{InterfaceName: tun0 }}  nc{[ Transports: WIFI|VPN Capabilities: NOT_METERED&INTERNET&NOT_RESTRICTED&TRUSTED&VALIDATED&NOT_ROAMING&FOREGROUND&NOT_CONGESTED&NOT_SUSPENDED&NOT_VCN_MANAGED&NOT_BANDWIDTH_CONSTRAINED TransportInfo: <VpnTransportInfo{type=1, sessionId=sing-box, bypassable=false longLivedTcpConnectionsExpensive=false}> Uids: <{0-10098, 10100-10112, 10114-10129, 10132-10132, 10134-20098, 20100-20112, 20114-20129, 20132-20132, 20134-99999}> OwnerUid: 10405 AdminUids: [10405] UnderlyingNetworks: [443]]}  factorySerialNumber=4}';

function dump(lines, defaultNetwork = '443') {
  return `Active default network: ${defaultNetwork}\n\nCurrent Networks:\n${lines.join('\n')}\nStatus for known UIDs:\n`;
}

function sample(lines = [wifiLine, vpnLine], defaultNetwork = '443') {
  return { sim: 'ABSENT,ABSENT', wifi: '1', data: '1', airplane: 'disabled',
    network: connectivity(dump(lines, defaultNetwork)), wifiIdentity: ['Wifi is connected to fixture-ssid'],
    interfaces: [{ ifname: 'wlan0', operstate: 'UP', addr_info: [{ family: 'inet', scope: 'global' }] }] };
}

function isolated(lines = []) {
  const value = sample(lines, 'none');
  value.wifi = '0'; value.wifiIdentity = [];
  value.interfaces = [{ ifname: 'wlan0', operstate: 'DOWN', addr_info: [] }];
  return value;
}

const isolatedVpn = underlying => vpnLine.replace('Transports: WIFI|VPN', 'Transports: VPN')
  .replace('UnderlyingNetworks: [443]', `UnderlyingNetworks: ${underlying}`);

test('recorded 03 Wi-Fi and VPN fields preserve overlay identity and raw evidence', () => {
  const network = connectivity(dump([wifiLine, vpnLine]));
  assert.equal(network.defaultNetwork, '443');
  assert.deepEqual(network.connected, [wifiLine, vpnLine]);
  const [wifi, vpn] = network.agents;
  assert.deepEqual([wifi.netId, wifi.type, wifi.interfaceName, wifi.underlyingNetworks], ['443', 'WIFI', 'wlan0', null]);
  assert.deepEqual(vpn.transports, ['WIFI', 'VPN']);
  assert.deepEqual(vpn.underlyingNetworks, ['443']);
  assert.deepEqual(vpn.vpn, { packageName: 'io.nekohasekai.sfa', ownerUid: '10405', type: '1',
    sessionId: 'sing-box', bypassable: false,
    uidRanges: '{0-10098, 10100-10112, 10114-10129, 10132-10132, 10134-20098, 20100-20112, 20114-20129, 20132-20132, 20134-99999}' });
});

test('ordinary Wi-Fi remains accepted and historical network records are excluded', () => {
  const before = sample([wifiLine]);
  assert.equal(connectedWifi(before), true);
  assert.equal(disconnected(isolated(), before), true);
  assert.equal(restoredError(sample([wifiLine]), before), null);
  assert.deepEqual(connectivity(dump([wifiLine]) + vpnLine).connected, [wifiLine]);
});

test('recorded Wi-Fi with its one explicit sing-box overlay is accepted', () => {
  assert.equal(connectedWifiError(sample()), null);
});

test('additional physical networks and transport kinds are rejected', () => {
  for (const type of ['ETHERNET', 'CELLULAR', 'BLUETOOTH', 'WIFI']) {
    const extra = wifiLine.replace('network{443}', 'network{446}')
      .replace('ni{WIFI ', `ni{${type} `).replace('Transports: WIFI ', `Transports: ${type} `);
    assert.equal(connectedWifiError(sample([wifiLine, vpnLine, extra])), 'unique_physical_wifi_network_required');
    assert.equal(disconnectedError(isolated([extra]), sample()), 'physical_network_still_present');
  }
  const extraTransport = vpnLine.replace('WIFI|VPN', 'CELLULAR|WIFI|VPN');
  assert.equal(connectedWifiError(sample([wifiLine, extraTransport])), 'vpn_transports_not_wifi_overlay');
});

test('unknown, multiple and incompletely bound VPN baselines are rejected', () => {
  assert.equal(connectedWifiError(sample([wifiLine, vpnLine.replace('io.nekohasekai.sfa', 'example.unknown')])), 'vpn_package_not_supported');
  assert.equal(connectedWifiError(sample([wifiLine, vpnLine, vpnLine.replace('network{445}', 'network{446}')])), 'multiple_vpn_networks_not_supported');
  for (const underlying of ['[446]', '[443, 446]', '[]', 'Null']) {
    assert.equal(connectedWifiError(sample([wifiLine, vpnLine.replace('UnderlyingNetworks: [443]', `UnderlyingNetworks: ${underlying}`)])), 'vpn_underlying_network_mismatch');
  }
});

test('the original VPN may disappear or explicitly lose every underlying network', () => {
  const before = sample();
  assert.equal(disconnectedError(isolated(), before), null);
  assert.equal(disconnectedError(isolated([isolatedVpn('[]')]), before), null);
  assert.equal(disconnectedError(isolated([isolatedVpn('Null')]), before), null);
  const hasDefault = isolated([isolatedVpn('Null')]); hasDefault.network.defaultNetwork = '445';
  assert.equal(disconnectedError(hasDefault, before), 'default_network_still_present');
});

test('an old netId and stale physical transports never become proof of isolation', () => {
  const before = sample();
  assert.equal(disconnectedError(isolated([isolatedVpn('[443]')]), before), 'vpn_underlying_network_still_declared');
  assert.equal(disconnectedError(isolated([vpnLine.replace('UnderlyingNetworks: [443]', 'UnderlyingNetworks: []')]), before), 'vpn_isolation_state_unconfirmed');
});

test('isolation rejects newly introduced or changed VPN identities', () => {
  const vpn = isolatedVpn('[]');
  assert.equal(disconnectedError(isolated([vpn]), sample([wifiLine])), 'vpn_identity_changed');
  for (const changed of [vpn.replace('io.nekohasekai.sfa', 'example.unknown'), vpn.replace('OwnerUid: 10405', 'OwnerUid: 10406'),
    vpn.replace('sessionId=sing-box', 'sessionId=other'), vpn.replace('bypassable=false', 'bypassable=true'),
    vpn.replace('0-10098', '0-10097')]) {
    assert.equal(disconnectedError(isolated([changed]), sample()), 'vpn_identity_changed');
  }
});

test('restoration requires the original VPN over the reconnected Wi-Fi new netId', () => {
  const before = sample();
  const reconnectedWifi = wifiLine.replace('network{443}', 'network{448}');
  const reconnectedVpn = vpnLine.replace('network{445}', 'network{449}').replace('UnderlyingNetworks: [443]', 'UnderlyingNetworks: [448]');
  assert.equal(restoredError(sample([reconnectedWifi, reconnectedVpn], '448'), before), null);
  assert.equal(restoredError(sample([reconnectedWifi, vpnLine], '448'), before), 'vpn_underlying_network_mismatch');
  assert.equal(restoredError(sample([reconnectedWifi], '448'), before), 'original_vpn_identity_not_restored');
  assert.equal(restoredError(sample(), sample([wifiLine])), 'original_vpn_identity_not_restored');
  assert.equal(restoredError(sample([wifiLine, vpnLine.replace('OwnerUid: 10405', 'OwnerUid: 10406')]), before), 'original_vpn_identity_not_restored');
  assert.equal(restoredError(sample([wifiLine, vpnLine.replace('&VALIDATED', '')]), before), 'original_network_capabilities_not_restored');
});

test('Wi-Fi identity, interface shutdown and unchanged radio state remain required', () => {
  const before = sample();
  const changedWifi = sample(); changedWifi.wifiIdentity = ['Wifi is connected to another-ssid'];
  assert.equal(restoredError(changedWifi, before), 'original_wifi_identity_not_restored');
  for (const field of ['sim', 'data', 'airplane']) {
    const changed = isolated(); changed[field] = 'changed';
    assert.notEqual(disconnectedError(changed, before), null);
  }
  const addressRemaining = isolated(); addressRemaining.interfaces[0].addr_info.push({ family: 'inet', scope: 'global' });
  assert.equal(disconnectedError(addressRemaining, before), 'wifi_interface_still_active');
  const enabled = isolated(); enabled.wifi = '1';
  assert.equal(disconnectedError(enabled, before), 'wifi_not_disabled');
});

test('unknown states or missing required network fields cannot produce a pass', () => {
  assert.equal(connectedWifiError(sample([wifiLine.replace('WIFI CONNECTED', 'WIFI CONNECTING')])), 'network_agent_not_connected');
  // The original 08 restore record includes CONNECTING with no InterfaceName.
  const connecting = wifiLine.replace('WIFI CONNECTED', 'WIFI CONNECTING').replace('InterfaceName: wlan0 ', 'LinkAddresses: [ ] ');
  assert.equal(connectedWifiError(sample([connecting], 'none')), 'network_agent_not_connected');
  assert.equal(disconnectedError(isolated([connecting]), sample()), 'physical_network_still_present');
  for (const malformed of [dump([wifiLine, vpnLine.replace('UnderlyingNetworks: [443]', '')]),
    dump([wifiLine, vpnLine.replace('OwnerUid: 10405', '')]),
    dump([wifiLine, vpnLine.replace('Uids: <', 'UnknownUids: <')]),
    dump([wifiLine, wifiLine]), dump([wifiLine]).replace('Current Networks:', 'Unknown:')]) {
    assert.throws(() => connectivity(malformed));
  }
});
