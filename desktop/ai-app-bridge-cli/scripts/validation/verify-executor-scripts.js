'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

async function main() {
  const serial = process.argv[2];
  if (!serial) throw new Error('Pass the explicit Android serial.');
  const directory = path.resolve(process.argv[3] || '../../build/executor-0.3.6');
  const env = { ...process.env, AI_APP_BRIDGE_RUNTIME_HOME: path.join(directory, 'public-script-runtime'),
    AI_APP_BRIDGE_FACT_STORE_DIR: path.join(directory, 'public-script-facts'),
    AI_APP_BRIDGE_EXECUTOR_HOME: path.join(directory, 'cache') };
  const cliPath = process.env.AI_APP_BRIDGE_VALIDATION_CLI || path.resolve(__dirname, '../../bin/ai-app-bridge.js');
  const proof = { startedAt: new Date().toISOString(), cliPath, scripts: [] };
  const cli = async (command, arguments_) => {
    const argv = [cliPath, command];
    for (const [name, value] of Object.entries(arguments_)) argv.push('--' + name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), typeof value === 'string' ? value : JSON.stringify(value));
    let result;
    try { result = await execFile(process.execPath, argv, { env, maxBuffer: 8 * 1024 * 1024 }); }
    catch (error) { if (!error.stdout) throw error; result = error; }
    const parsed = JSON.parse(result.stdout).value;
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    return parsed;
  };
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<title>Public Script Executor</title><button data-testid="increment" onclick="count.textContent=String(Number(count.textContent)+1)">Increment</button><p id="count" data-testid="count">0</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const androidTarget = { serial, packageName: 'io.github.mobileaidev.aiappbridge.sample' };
  let android, web;
  const source = (platform, language) => {
    const command = platform === 'android' ? 'android-executor' : 'web-executor';
    if (language === 'javascript') return `module.exports.main = async ctx => {
      const call = async args => { const reply = await ctx.call('${command}', {...ctx.inputs.identity, ...args}); if (!reply.ok || reply.result.ok === false) throw new Error(JSON.stringify(reply)); return reply.result; };
      const before = await call({operation:'observe'${platform === 'android' ? ",engine:'espresso'" : ''}});
      ${platform === 'android' ? `const nodes = before.observation.nodes.filter(node => node.text === 'Native Increment'); if(nodes.length !== 1) throw new Error('nonunique button');
      await call({operation:'act', snapshotId:before.observation.snapshotId, action:{type:'click',nodeId:nodes[0].nodeId}});
      const after=await call({operation:'observe',engine:'espresso'});
      const text=after.observation.nodes.find(node=>node.description==='native_counter_status').text;` : `const document=before.documents.find(item=>item.parentFrameId===null);
      await call({operation:'act', frameId:document.frameId, documentId:document.documentId, action:{type:'click',selector:{by:'testId',value:'increment'}}});
      const after=await call({operation:'observe'});
      const text=after.documents[0].snapshot;`}
      return {ok:true,language:'javascript',platform:'${platform}',observed:text};
    };`;
    return `def main(ctx):
    def call(args):
        reply = ctx.call('${command}', {**ctx.inputs['identity'], **args})
        if not reply['ok'] or reply['result'].get('ok') is False:
            raise RuntimeError(str(reply))
        return reply['result']
    before = call({'operation':'observe'${platform === 'android' ? ",'engine':'espresso'" : ''}})
${platform === 'android' ? `    nodes = [node for node in before['observation']['nodes'] if node.get('text') == 'Native Increment']
    assert len(nodes) == 1
    call({'operation':'act','snapshotId':before['observation']['snapshotId'],'action':{'type':'click','nodeId':nodes[0]['nodeId']}})
    after = call({'operation':'observe','engine':'espresso'})
    text = next(node['text'] for node in after['observation']['nodes'] if node.get('description') == 'native_counter_status')` : `    document = next(item for item in before['documents'] if item['parentFrameId'] is None)
    call({'operation':'act','frameId':document['frameId'],'documentId':document['documentId'],'action':{'type':'click','selector':{'by':'testId','value':'increment'}}})
    after = call({'operation':'observe'})
    text = after['documents'][0]['snapshot']`}
    return {'ok':True,'language':'python','platform':'${platform}','observed':text}
`;
  };
  try {
    android = await cli('android-executor', { operation: 'open', ...androidTarget,
      instrumentation: androidTarget.packageName + '.test/androidx.test.runner.AndroidJUnitRunner',
      testClass: androidTarget.packageName + '.BridgeSessionTest', activity: androidTarget.packageName + '.debugbridge.DebugBridgeNativeTestActivity' });
    web = await cli('web-executor', { operation: 'open', url: `http://127.0.0.1:${server.address().port}/` });
    for (const platform of ['android', 'web']) for (const language of ['javascript', 'python']) {
      const session = platform === 'android' ? android : web;
      const identity = { sessionId: session.sessionId, runtimeEpoch: session.runtimeEpoch,
        ...(platform === 'web' ? { targetId: session.targetId } : {}) };
      const target = platform === 'android' ? { platform, ...androidTarget } : { platform, ...identity };
      const started = await cli('script', { operation: 'start', recordingDir: path.join(directory, `recording-${platform}-${language}-${Date.now()}`),
        script: { schemaVersion: 'aab.code-script/v1', name: `executor-${platform}-${language}`, target, language, source: source(platform, language),
          inputs: { identity }, permissions: ['app.test'], policy: { timeoutMs: 60000, restartPolicy: 'none' } } });
      let status = started;
      while (!['completed', 'failed', 'cancelled'].includes(status.status)) {
        status = await cli('script', { operation: 'wait', operationId: started.operationId, afterSequence: status.eventSequence ?? 0, waitMs: 1000 });
      }
      assert.equal(status.status, 'completed', JSON.stringify(status));
      const result = await cli('script', { operation: 'result', operationId: started.operationId });
      assert.equal(result.persisted, true);
      assert.equal(result.result.ok, true, JSON.stringify(result));
      proof.scripts.push({ platform, language, operationId: started.operationId, result });
    }
    const observedAndroid = await cli('android-executor', { operation: 'observe', ...androidTarget, sessionId: android.sessionId, runtimeEpoch: android.runtimeEpoch, engine: 'uiautomator' });
    assert.equal(observedAndroid.observation.nodes.find(node => node.description === 'native_counter_status').text, 'Native counter: 2');
    const observedWeb = await cli('web-executor', { operation: 'observe', sessionId: web.sessionId, runtimeEpoch: web.runtimeEpoch, targetId: web.targetId });
    assert.equal(observedWeb.documents[0].controls.find(node => node.testId === 'count').text, '2');
    proof.ok = true;
  } finally {
    if (android) proof.androidClose = await cli('android-executor', { operation: 'close', ...androidTarget, sessionId: android.sessionId, runtimeEpoch: android.runtimeEpoch });
    if (web) proof.webClose = await cli('web-executor', { operation: 'close', sessionId: web.sessionId, runtimeEpoch: web.runtimeEpoch, targetId: web.targetId });
    proof.runtimeStop = await cli('runtime', { operation: 'stop' });
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(directory, 'executor-public-script-verification.json'), JSON.stringify(proof, null, 2));
  }
  process.stdout.write(JSON.stringify({ ok: true, scripts: proof.scripts.map(({ platform, language, operationId }) => ({ platform, language, operationId })), evidence: path.join(directory, 'executor-public-script-verification.json') }) + '\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
