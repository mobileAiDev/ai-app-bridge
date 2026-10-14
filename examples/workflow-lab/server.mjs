import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commerceRequest, newCommerceState } from './commerce.mjs';

// A real TCP/HTTP fixture shared by native, WebView and Flutter test clients.
// The UI drives business endpoints. The harness configures faults and reads the
// independent journal; it must not perform business mutations for the UI.
export function createLabServer({ directory, port = 0, host = '127.0.0.1' }) {
  fs.mkdirSync(directory, { recursive: true });
  const journalPath = path.join(directory, 'server.jsonl');
  const statePath = path.join(directory, 'server-state.json');
  const runs = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : {};
  let sequence = 0;
  const record = value => fs.appendFileSync(journalPath, JSON.stringify({ sequence: ++sequence, atMs: Date.now(), ...value }) + '\n');
  const persist = () => {
    const temporary = statePath + '.next';
    fs.writeFileSync(temporary, JSON.stringify(runs, null, 2));
    fs.renameSync(temporary, statePath);
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const runId = url.searchParams.get('run') || request.headers['x-lab-run'];
    const requestId = `${Date.now()}-${sequence + 1}`;
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) { response.writeHead(413); response.end(); return; }
    }
    let data;
    try { data = body ? JSON.parse(body) : {}; }
    catch { response.writeHead(400); response.end('invalid JSON'); return; }
    record({ type: 'request', requestId, runId, method: request.method, path: url.pathname,
      source: request.headers['x-lab-source'] || null,
      body: url.pathname === '/api/session' ? { account: data.account, agreement: data.agreement } : data });
    const send = (status, value) => {
      record({ type: 'response', requestId, runId, status, body: value });
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      response.end(JSON.stringify(value));
    };
    try {
      if (url.pathname === '/__control' && request.method === 'POST') {
        if (!data.runId || runs[data.runId]) return send(409, { error: 'use_a_new_run_id' });
        runs[data.runId] = { config: { delayMs: 200, firstSave: '503', ...data.config }, orders: {}, sessions: 0, session: null,
          sessionExpiredOnce: false, saveAttempts: 0, approvals: 0, flutterUpdates: 0, commerce: newCommerceState() };
        persist(); return send(201, { runId: data.runId });
      }
      if (url.pathname === '/__state') return send(200, runId ? runs[runId] || null : runs);
      if (['/review.html', '/campaign.html'].includes(url.pathname)) {
        const bytes = fs.readFileSync(new URL(`.${url.pathname}`, import.meta.url));
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(bytes); return;
      }
      if (/^\/images\/product-([0-9]|1[01])\.png$/.test(url.pathname)) {
        const bytes = fs.readFileSync(new URL(`.${url.pathname}`, import.meta.url));
        response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
        response.end(bytes); return;
      }
      const run = runs[runId];
      if (!run) return send(404, { error: 'unknown_run' });
      await delay(run.config.delayMs);
      if (url.pathname === '/api/session' && request.method === 'POST') {
        if (data.account !== 'bridge@example.test' || data.password !== 'fixture-password' || data.agreement !== true)
          return send(401, { error: 'invalid_credentials_or_agreement' });
        run.sessions++;
        run.session = `lab-${runId}${run.sessions === 1 ? '' : `-${run.sessions}`}`;
        persist(); return send(200, { session: run.session, account: data.account });
      }
      if (request.headers.authorization !== `Bearer ${run.session}` || !run.session) return send(401, { error: 'session_required' });
      if (run.config.expireSessionOnceAt === url.pathname && !run.sessionExpiredOnce) {
        run.sessionExpiredOnce = true; run.session = null; persist(); return send(401, { error: 'session_expired' });
      }
      if (url.pathname.startsWith('/api/shop/')) return commerceRequest({ run, method: request.method, url, data, send,
        commit: () => { persist(); record({ type: 'commerce_state', requestId, runId,
          cartRevision: run.commerce.cartRevision, orderCount: Object.keys(run.commerce.orders).length, ledgerCount: run.commerce.ledger.length }); },
        loseResponse: fault => { record({ type: 'injected_fault', requestId, runId, fault }); response.destroy(); } });
      if (url.pathname === '/api/items') {
        const query = url.searchParams.get('q') || '';
        const items = Array.from({ length: 60 }, (_, index) => ({ id: `SITE-${String(index + 1).padStart(3, '0')}`,
          name: `设备巡检 ${index % 3 + 1}`, zone: ['北区', '南区', '东区'][index % 3], position: index + 1 }));
        const filtered = items.filter(item => `${item.name} ${item.zone} ${item.id}`.includes(query));
        const page = Number(url.searchParams.get('page') || 0), pageSize = 6;
        return send(200, { items: filtered.slice(page * pageSize, (page + 1) * pageSize), total: filtered.length, page });
      }
      if (url.pathname === '/api/orders' && request.method === 'POST') {
        run.saveAttempts++;
        if (!data.idempotencyKey || !data.siteId || !data.assignee || !data.note) { persist(); return send(422, { error: 'fields_required' }); }
        const existing = Object.values(run.orders).find(order => order.idempotencyKey === data.idempotencyKey);
        if (existing) { persist(); return send(200, { order: existing, repeated: true }); }
        if (run.saveAttempts === 1 && run.config.firstSave === '503') { persist(); return send(503, { error: 'service_temporarily_unavailable', committed: false }); }
        const order = { ...data, id: `ORDER-${Object.keys(run.orders).length + 1}`, revision: 1, approved: false, checked: false };
        run.orders[order.id] = order; persist();
        record({ type: 'commit', requestId, runId, operation: 'create', order });
        if (run.saveAttempts === 1 && run.config.firstSave === 'lost-response') {
          record({ type: 'injected_fault', requestId, runId, fault: 'response_lost_after_commit' });
          response.destroy(); return;
        }
        return send(201, { order });
      }
      if (url.pathname === '/api/orders') {
        const key = url.searchParams.get('key');
        return send(200, { orders: Object.values(run.orders).filter(order => !key || order.idempotencyKey === key) });
      }
      const selected = /^\/api\/orders\/([^/]+)(?:\/(approve|check))?$/.exec(url.pathname);
      if (selected && run.orders[selected[1]]) {
        const order = run.orders[selected[1]];
        if (request.method === 'GET') return send(200, { order });
        if (request.method !== 'POST') return send(405, { error: 'method' });
        if (data.revision !== order.revision) return send(409, { error: 'revision_conflict', order });
        if (selected[2] === 'approve') {
          if (!data.agreement || !data.review) return send(422, { error: 'review_required' });
          order.approved = true; order.review = data.review; run.approvals++;
        } else if (selected[2] === 'check') {
          if (!order.approved || !data.note) return send(422, { error: 'approved_order_and_note_required' });
          order.checked = true; order.checkNote = data.note; run.flutterUpdates++;
        } else return send(404, { error: 'operation' });
        order.revision++; persist(); record({ type: 'commit', requestId, runId, operation: selected[2], order });
        return send(200, { order });
      }
      return send(404, { error: 'not_found' });
    } catch (error) { record({ type: 'server_error', requestId, error: String(error) }); if (!response.destroyed) send(500, { error: 'server_error' }); }
  });
  return new Promise(resolve => server.listen(port, host, () => {
    const endpoint = { port: server.address().port, host, directory, journalPath, statePath };
    fs.writeFileSync(path.join(directory, 'endpoint.json'), JSON.stringify(endpoint));
    resolve({ server, ...endpoint });
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) throw new Error('usage: node server.mjs /absolute/evidence-directory [port]');
  const started = await createLabServer({ directory: path.resolve(directory), port: Number(process.argv[3] || 0) });
  console.log(JSON.stringify({ port: started.port, directory: started.directory }));
}
