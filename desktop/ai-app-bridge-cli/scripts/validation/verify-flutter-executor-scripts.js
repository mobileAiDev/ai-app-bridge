'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

async function main() {
  const serial = process.argv[2];
  if (!serial) throw new Error('Pass the explicit Android device serial.');
  const directory = path.resolve(process.argv[3] || '../../build/executor-0.3.8');
  const env = { ...process.env, AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'flutter-script-runtime'),
    AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'flutter-script-facts'), AI_APP_BRIDGE_EXECUTOR_HOME: path.join(directory, 'cache') };
  const cliPath = process.env.AI_APP_BRIDGE_VALIDATION_CLI || path.resolve(__dirname, '../../bin/ai-app-bridge.js');
  const cli = async (command, arguments_) => {
    const argv = [cliPath, command];
    for (const [name, value] of Object.entries(arguments_)) argv.push('--' + name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), typeof value === 'string' ? value : JSON.stringify(value));
    let output;
    try { output = await execFile(process.execPath, argv, { env, maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) { if (!error.stdout) throw error; output = error; }
    const result = JSON.parse(output.stdout).value;
    assert.equal(result.ok, true, JSON.stringify(result)); return result;
  };
  const target = { serial, packageName: 'io.github.mobileaidev.aab_executor_fixture' };
  const proof = { startedAt: new Date().toISOString(), cliPath, target, scripts: [], cleanup: [] };
  let identity;
  try {
    const open = await cli('flutter-executor', { operation: 'open', ...target, activity: target.packageName + '.MainActivity' });
    identity = { sessionId: open.sessionId, runtimeEpoch: open.runtimeEpoch }; proof.open = open;
    for (const language of ['javascript', 'python']) {
      const source = language === 'javascript' ? `module.exports.main=async ctx=>{
        const call=async args=>{const r=await ctx.call('flutter-executor',{...ctx.inputs.identity,...args});if(!r.ok||!r.result.ok)throw new Error(JSON.stringify(r));return r.result;};
        const before=await call({operation:'observe'});
        const nodes=before.observation.nodes.filter(n=>n.key==='increment');if(nodes.length!==1)throw new Error('nonunique target');
        await call({operation:'act',snapshotId:before.observation.snapshotId,action:{type:'tap',nodeId:nodes[0].nodeId}});
        const after=await call({operation:'observe'});
        return {ok:true,observed:after.observation.nodes.find(n=>n.key==='counter').text};
      };` : `def main(ctx):
    def call(args):
        r=ctx.call('flutter-executor',{**ctx.inputs['identity'],**args})
        assert r['ok'] and r['result']['ok'],str(r)
        return r['result']
    before=call({'operation':'observe'})
    nodes=[n for n in before['observation']['nodes'] if n.get('key')=='increment']
    assert len(nodes)==1
    call({'operation':'act','snapshotId':before['observation']['snapshotId'],'action':{'type':'tap','nodeId':nodes[0]['nodeId']}})
    after=call({'operation':'observe'})
    return {'ok':True,'observed':next(n['text'] for n in after['observation']['nodes'] if n.get('key')=='counter')}
`;
      const started = await cli('script', { operation: 'start', recordingDir: path.join(directory, `recording-flutter-${language}-${Date.now()}`),
        script: { schemaVersion: 'aab.code-script/v1', name: `flutter-executor-${language}`, language, source,
          target: { platform: 'android', ...target }, inputs: { identity }, permissions: ['app.test'], policy: { timeoutMs: 60000, restartPolicy: 'none' } } });
      let status = started;
      while (!['completed', 'failed', 'cancelled'].includes(status.status)) status = await cli('script', { operation: 'wait', operationId: started.operationId, afterSequence: status.eventSequence ?? 0, waitMs: 1000 });
      assert.equal(status.status, 'completed', JSON.stringify(status));
      const result = await cli('script', { operation: 'result', operationId: started.operationId });
      assert.equal(result.persisted, true); assert.equal(result.result.ok, true);
      proof.scripts.push({ language, operationId: started.operationId, result });
    }
    const observed = await cli('flutter-executor', { operation: 'observe', ...target, ...identity });
    assert.equal(observed.observation.nodes.find(n => n.key === 'counter').text, 'Counter: 2');
    proof.ok = true;
  } finally {
    if (identity) { try { proof.cleanup.push(await cli('flutter-executor', { operation: 'close', ...target, ...identity })); } catch (error) { proof.cleanup.push({ error: error.message }); } }
    try { proof.cleanup.push(await cli('runtime', { operation: 'stop' })); } catch (error) { proof.cleanup.push({ error: error.message }); }
    fs.writeFileSync(path.join(directory, 'flutter-public-script-verification.json'), JSON.stringify(proof, null, 2));
  }
  process.stdout.write(JSON.stringify({ ok: proof.ok, scripts: proof.scripts.map(({ language, operationId }) => ({ language, operationId })) }) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
