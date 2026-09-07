'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uiaTree, uiaTreeOnce } = require('../bin/ai-app-bridge');

function fixture(t, fail) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-uia-freshness-'));
  const remote = path.join(directory, 'window.xml');
  const calls = path.join(directory, 'calls.jsonl');
  const executable = path.join(directory, 'adb');
  fs.writeFileSync(remote, '<hierarchy><node text="OLD_OPEN_PAGE" /></hierarchy>');
  fs.writeFileSync(executable, `#!${process.execPath}\n'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args.includes('rm')) fs.rmSync(${JSON.stringify(remote)}, { force: true });
else if (args.includes('dump')) {
  ${fail ? "process.stdout.write('ERROR: could not get idle state.\\n');" : `fs.writeFileSync(${JSON.stringify(remote)}, '<hierarchy><node text="CURRENT_HOME" /></hierarchy>'); process.stdout.write('UI hierchary dumped to: /sdcard/ai_app_window.xml\\n');`}
} else if (args.includes('cat')) {
  if (!fs.existsSync(${JSON.stringify(remote)})) process.exit(1);
  process.stdout.write(fs.readFileSync(${JSON.stringify(remote)}));
}
`, { mode: 0o755 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { ctx: { serial: path.basename(directory), adb: executable }, calls };
}

for (const [name, read] of [['uiaTree', uiaTree], ['uiaTreeOnce', uiaTreeOnce]]) {
  test(`${name} rejects zero-exit dump failure instead of returning an old XML`, async (t) => {
    const { ctx, calls } = fixture(t, true);
    await assert.rejects(read(ctx), /uiautomator_dump_failed/);
    const commands = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(commands.some((args) => args.includes('cat')), false);
    assert.equal(commands.filter((args) => args.includes('rm')).length, commands.filter((args) => args.includes('dump')).length);
  });

  test(`${name} only reads the new successful dump`, async (t) => {
    const { ctx } = fixture(t, false);
    const xml = await read(ctx);
    assert.match(xml, /CURRENT_HOME/);
    assert.doesNotMatch(xml, /OLD_OPEN_PAGE/);
  });
}
