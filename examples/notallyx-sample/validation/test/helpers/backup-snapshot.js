'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { collectSnapshot, PACKAGE } = require('../../collector');
const { readSnapshot, compareCanonical } = require('../../oracles');
const CREATE = String.raw`
import json,pathlib,sqlite3,shutil,sys
s=json.load(sys.stdin);d=pathlib.Path(s['dir']);db=d/'live.sqlite'
c=sqlite3.connect(db);c.execute('PRAGMA journal_mode=WAL')
schema=json.load(open(s['schemaPath']))['database']
for e in schema['entities']:c.execute(e['createSql'].replace(chr(36)+'{TABLE_NAME}',e['tableName']))
for q in schema['setupQueries']:c.execute(q)
c.execute('PRAGMA user_version=11');c.commit();c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
for note in s['data']['notes']:
 n=dict(note)
 for k in ['labels','spans','items','images','files','audios','reminders']:n[k]=json.dumps(n[k],ensure_ascii=False)
 c.execute('INSERT INTO BaseNote ('+','.join('"'+k+'"' for k in n)+') VALUES ('+','.join('?' for k in n)+')',list(n.values()))
for label in s['data']['labels']:c.execute('INSERT INTO Label(value,"order") VALUES (?,?)',(label['value'],label['order']))
c.commit()
for suffix in ['','-wal','-shm']:
 f=pathlib.Path(str(db)+suffix)
 if f.exists():shutil.copyfile(f,d/('NotallyDatabase'+suffix))
c.close()
`;
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function prefsXml(preferences) {
  return `<map>${Object.entries(preferences).map(([key, value]) => {
    const name = xml(key);
    if (Array.isArray(value)) return `<set name="${name}">${value.map(item => `<string>${xml(item)}</string>`).join('')}</set>`;
    if (typeof value === 'boolean') return `<boolean name="${name}" value="${value}"/>`;
    if (typeof value === 'number') return `<long name="${name}" value="${value}"/>`;
    return `<string name="${name}">${xml(value)}</string>`;
  }).join('')}</map>`;
}
function fixture(t, data, { start = 1000, sequence = 1, runId = 'labels-run', serial = 'offline-labels', apkSha256 = 'a'.repeat(64), attach = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notallyx-label-oracle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const create = spawnSync('python3', ['-c', CREATE], { input: JSON.stringify({ dir, data,
    schemaPath: path.resolve(__dirname, '../../../app/schemas/com.philkes.notallyx.data.NotallyDatabase/11.json') }), encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  const remote = new Map();
  for (const suffix of ['', '-wal', '-shm']) { const file = path.join(dir, `NotallyDatabase${suffix}`); if (fs.existsSync(file)) remote.set(`databases/NotallyDatabase${suffix}`, fs.readFileSync(file)); }
  remote.set(`shared_prefs/${PACKAGE}_preferences.xml`, Buffer.from(prefsXml(data.preferences)));
  for (const file of attach) remote.set(`files/attachments/${file.kind}/${file.name}`, Buffer.from(file.body));
  let clock = start;
  const runCommand = (_program, argv) => {
    const a = argv.slice(2);
    if (a[0] === 'shell') return { status: a[1] === 'pidof' ? 1 : 0, stdout: '', stderr: '' };
    const cmd = a[3], arg = a[4];
    if (cmd === 'test') { const present = arg === '-f' ? remote.has(a[5]) : [...remote.keys()].some(file => file.startsWith(`${a[5]}/`)); return { status: present ? 0 : 1, stdout: '', stderr: '' }; }
    if (cmd === 'cat') return { status: 0, stdout: remote.get(arg), stderr: '' };
    if (cmd === 'find') return { status: 0, stdout: Buffer.from([...remote.keys()].filter(file => file.startsWith(`${arg}/`)).join('\0') + '\0'), stderr: '' };
    throw new Error(`Unexpected simulated command ${argv}`);
  };
  const manifest = collectSnapshot({ serial, packageName: PACKAGE, out: path.join(dir, 'evidence'), runId, sequence, apkSha256 }, { runCommand, now: () => ++clock });
  const snapshot = readSnapshot(manifest, { expectedTarget: manifest.target, expectedApkSha256: apkSha256, runId, afterSequence: sequence, minCapturedAtMs: start });
  assert.equal(snapshot.ok, true, snapshot.reason);
  return snapshot;
}

module.exports={fixture};
