import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createLabServer } from './server.mjs';

test('missing static assets fail their request while the fixture remains usable', async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-workflow-missing-assets-')));
  for (const name of ['server.mjs', 'commerce.mjs']) fs.copyFileSync(new URL(name, import.meta.url), path.join(directory, name));
  const child = spawn(process.execPath, [path.join(directory, 'server.mjs'), path.join(directory, 'state')]);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; fs.rmSync(directory, { recursive: true }); });
  const [ready] = await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error(`Fixture exited before listening: ${stderr}`); })]);
  const { port } = JSON.parse(ready.toString());
  const base = `http://127.0.0.1:${port}`;
  for (const route of ['/images/product-0.png', '/campaign.html']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 500, stderr);
    assert.equal((await response.json()).error, 'server_error');
  }
  const response = await fetch(base + '/__state');
  assert.equal(response.status, 200, stderr);
  assert.deepEqual(await response.json(), {});
  assert.equal(child.exitCode, null, stderr);
});

async function fixture(t, config = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-workflow-'));
  const { server, port } = await createLabServer({ directory });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true }); });
  const base = `http://127.0.0.1:${port}`;
  let token;
  async function call(route, body) {
    const response = await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}run=test`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, ...await response.json() };
  }
  await call('/__control', { runId: 'test', config: { delayMs: 1, ...config } });
  const login = async () => { const result = await call('/api/session', { account: 'bridge@example.test', password: 'fixture-password', agreement: true }); token = result.session; return result; };
  await login();
  const quote = async () => {
    const cart = await call('/api/shop/cart');
    return call('/api/shop/quote', { cartRevision: cart.revision, address: { recipient: '测试员', phone: '13800000000', street: '测试路 100 号' }, coupon: 'SAVE10' });
  };
  return { call, login, quote };
}

test('real HTTP checkout calculates cents, reserves stock, and payment/refund are idempotent', async t => {
  const { call, quote } = await fixture(t);
  assert.equal((await call('/api/shop/cart', { productId: 'P001', variantId: 'V1-0', quantity: 3, revision: 0 })).status, 200);
  const priced = (await quote()).quote;
  assert.deepEqual([priced.subtotal, priced.discount, priced.shipping, priced.payable], [7500, 1000, 0, 6500]);
  const created = await call('/api/shop/orders', { quoteId: priced.id, idempotencyKey: 'checkout-1' });
  assert.equal(created.order.status, 'awaiting_payment');
  assert.equal((await call('/api/shop/orders', { quoteId: priced.id, idempotencyKey: 'checkout-1' })).order.id, created.order.id);
  const route = `/api/shop/orders/${created.order.id}`;
  await Promise.all([call(`${route}/pay`, { idempotencyKey: 'pay-1' }), call(`${route}/pay`, { idempotencyKey: 'pay-1' })]);
  await Promise.all([call(`${route}/refund`, { idempotencyKey: 'refund-1', reason: '测试退款' }), call(`${route}/refund`, { idempotencyKey: 'refund-1', reason: '测试退款' })]);
  const state = await call('/__state');
  assert.equal(Object.keys(state.commerce.orders).length, 1);
  assert.equal(state.commerce.orders.BUY1.status, 'refunded');
  assert.deepEqual(state.commerce.ledger.map(entry => [entry.type, entry.amount]), [['payment', 6500], ['refund', 6500]]);
  assert.equal(state.commerce.products[0].variants[0].stock, 12);
});

test('lost payment response is recoverable by query without a second payment request', async t => {
  const { call, quote } = await fixture(t, { paymentResponseLostOnce: true });
  await call('/api/shop/cart', { productId: 'P001', variantId: 'V1-0', quantity: 2, revision: 0 });
  const priced = (await quote()).quote;
  const { order } = await call('/api/shop/orders', { quoteId: priced.id, idempotencyKey: 'checkout' });
  await assert.rejects(call(`/api/shop/orders/${order.id}/pay`, { idempotencyKey: 'pay' }), /fetch failed/);
  assert.equal((await call(`/api/shop/orders/${order.id}`)).order.status, 'paid');
  const state = await call('/__state');
  assert.equal(state.commerce.paymentAttempts, 1);
  assert.equal(state.commerce.ledger.length, 1);
});

test('expired session and changed quote preserve cart; cancellation releases reserved stock', async t => {
  const { call, login, quote } = await fixture(t, { expireSessionOnceAt: '/api/shop/quote', stalePriceOnce: true });
  await call('/api/shop/cart', { productId: 'P001', variantId: 'V1-0', quantity: 2, revision: 0 });
  assert.equal((await quote()).error, 'session_expired');
  assert.equal((await login()).session, 'lab-test-2');
  const stale = (await quote()).quote;
  assert.equal((await call('/api/shop/orders', { quoteId: stale.id, idempotencyKey: 'checkout' })).error, 'price_changed');
  const fresh = (await quote()).quote;
  assert.equal(fresh.payable, 4800);
  const { order } = await call('/api/shop/orders', { quoteId: fresh.id, idempotencyKey: 'checkout' });
  assert.equal((await call(`/api/shop/orders/${order.id}/cancel`, {})).order.status, 'cancelled');
  await call(`/api/shop/orders/${order.id}/cancel`, {});
  assert.equal((await call('/__state')).commerce.products[0].variants[0].stock, 12);
});

test('native order response loss remains queryable and a same-key retry creates no duplicate', async t => {
  const { call } = await fixture(t, { firstSave: 'lost-response' });
  const payload = { idempotencyKey: 'draft', siteId: 'SITE-001', assignee: '测试员', note: '验收记录' };
  await assert.rejects(call('/api/orders', payload), /fetch failed/);
  assert.equal((await call('/api/orders?key=draft')).orders.length, 1);
  assert.equal((await call('/api/orders', payload)).repeated, true);
  const state = await call('/__state');
  assert.equal(Object.keys(state.orders).length, 1);
  assert.equal(state.saveAttempts, 2);
});

test('city journey persists native addresses, pages duplicate-name shops and stacks claimed H5 coupons', async t => {
  const { call } = await fixture(t);
  const shops = await call('/api/shop/shops');
  assert.equal(shops.total, 48); assert.equal(shops.shops.length, 8);
  const next = await call('/api/shop/shops?page=1');
  assert.equal(new Set([...shops.shops, ...next.shops].map(shop => shop.id)).size, 16);
  const address = { recipient: '测试员', phone: '13800000000', street: '科技园测试路 100 号' };
  assert.equal((await call('/api/shop/addresses', { ...address, phone: '123' })).status, 422);
  assert.equal((await call('/api/shop/addresses', address)).address.id, 'A1');
  await call('/api/shop/cart', { productId: 'P001', variantId: 'V1-0', quantity: 2, revision: 0 });
  const query = { cartRevision: 1, address, coupon: 'SAVE10', platformCoupon: 'CITY5', deliverySlot: '今天 18:00–18:30' };
  assert.equal((await call('/api/shop/quote', query)).error, 'coupon_not_claimed');
  assert.equal((await call('/api/shop/coupons', { code: 'CITY5', agreement: false })).status, 422);
  await call('/api/shop/coupons', { code: 'CITY5', agreement: true });
  await call('/api/shop/coupons', { code: 'CITY5', agreement: true });
  const priced = (await call('/api/shop/quote', query)).quote;
  assert.deepEqual([priced.subtotal, priced.discount, priced.platformDiscount, priced.shipping, priced.payable], [5000, 1000, 500, 600, 4100]);
  assert.equal(priced.deliverySlot, query.deliverySlot);
  assert.equal((await call('/__state')).commerce.claimedCoupons.length, 1);
  assert.equal((await call('/api/shop/addresses')).addresses.length, 1);
});
