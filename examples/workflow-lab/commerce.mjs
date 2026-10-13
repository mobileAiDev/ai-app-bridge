const product = index => ({
  id: `P${String(index + 1).padStart(3, '0')}`, name: ['随行保温杯', '轻量背包', '桌面收纳盒'][index % 3],
  category: ['生活', '出行', '办公'][index % 3], description: `第 ${index + 1} 款：选择规格后加入购物车。同意说明不代表同意购买。`,
  image: `/images/product-${index % 12}.png`, sold: 200 + index * 17, rating: (4.5 + index % 5 / 10).toFixed(1),
  variants: ['标准款', '升级款'].map((name, offset) => ({ id: `V${index + 1}-${offset}`, name, price: 2500 + index * 100 + offset * 700, stock: 12 })),
});

export function newCommerceState() {
  return { products: Array.from({ length: 144 }, (_, index) => product(index)), cart: [], cartRevision: 0,
    addresses: [], claimedCoupons: [],
    quotes: {}, orders: {}, ledger: [], orderAttempts: 0, paymentAttempts: 0, priceVersion: 1, faults: [] };
}

function cartLines(shop) {
  return shop.cart.map(line => {
    const item = shop.products.find(item => item.id === line.productId);
    const variant = item.variants.find(variant => variant.id === line.variantId);
    return { ...line, name: item.name, variantName: variant.name, price: variant.price, stock: variant.stock, subtotal: variant.price * line.quantity };
  });
}

function totals(lines, coupon) {
  const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
  const discount = coupon === 'SAVE10' && subtotal >= 5000 ? 1000 : 0;
  const shipping = subtotal >= 7500 ? 0 : 600;
  return { subtotal, discount, shipping, payable: subtotal - discount + shipping };
}

// Values are cents. This ledger is deliberately local to the test environment;
// clients still use the complete order/payment protocol over actual HTTP.
export function commerceRequest({ run, method, url, data, commit, send, loseResponse }) {
  const shop = run.commerce;
  const route = url.pathname.slice('/api/shop'.length);
  const finish = (status, value) => { commit(); send(status, value); };
  if (method === 'GET' && route === '/shops') {
    const query = url.searchParams.get('q') || '', category = url.searchParams.get('category') || '';
    const shops = Array.from({ length: 48 }, (_, index) => ({ id: `S${String(index + 1).padStart(3, '0')}`,
      name: ['青禾生活', '城市优选', '邻里好物', '四季杂货'][index % 4], branch: ['科技园店', '中心广场店', '车站店'][index % 3],
      category: ['生活', '出行', '办公'][index % 3], image: `/images/product-${index % 12}.png`,
      rating: (4.5 + index % 5 / 10).toFixed(1), sold: 1200 + index * 37, minutes: 20 + index % 20,
      distance: `${(0.5 + index / 10).toFixed(1)}km`, tags: ['满50减10', index % 2 ? '品牌配送' : '新客福利', '支持退款'],
    })).filter(shop => `${shop.name} ${shop.branch} ${shop.id}`.includes(query) && (!category || category === shop.category));
    const page = Number(url.searchParams.get('page') || 0);
    return send(200, { shops: shops.slice(page * 8, (page + 1) * 8), total: shops.length, page });
  }
  if (route === '/addresses') {
    if (method === 'POST') {
      if (!data.recipient || !/^1\d{10}$/.test(data.phone || '') || (data.street || '').length < 6) return send(422, { error: 'address_invalid' });
      const address = { id: `A${shop.addresses.length + 1}`, recipient: data.recipient, phone: data.phone, street: data.street, label: data.label || '公司' };
      shop.addresses.push(address); return finish(201, { address });
    }
    return send(200, { addresses: shop.addresses });
  }
  if (route === '/coupons') {
    if (method === 'POST') {
      if (!['SAVE10', 'CITY5'].includes(data.code) || data.agreement !== true) return send(422, { error: 'coupon_agreement_required' });
      if (!shop.claimedCoupons.includes(data.code)) shop.claimedCoupons.push(data.code);
      return finish(200, { claimed: shop.claimedCoupons });
    }
    return send(200, { coupons: [{ code: 'SAVE10', title: '店铺满50减10', amount: 1000, minimum: 5000 },
      { code: 'CITY5', title: '平台满40减5', amount: 500, minimum: 4000 }], claimed: shop.claimedCoupons });
  }
  if (method === 'GET' && route === '/catalog') {
    const query = url.searchParams.get('q') || '', category = url.searchParams.get('category');
    const filtered = shop.products.filter(item => `${item.name} ${item.id}`.includes(query) && (!category || item.category === category));
    const page = Number(url.searchParams.get('page') || 0);
    return send(200, { products: filtered.slice(page * 6, (page + 1) * 6), total: filtered.length, page });
  }
  if (route === '/cart') {
    if (method === 'POST') {
      if (data.revision !== shop.cartRevision) return send(409, { error: 'cart_changed', revision: shop.cartRevision, lines: cartLines(shop) });
      const item = shop.products.find(item => item.id === data.productId);
      const variant = item?.variants.find(variant => variant.id === data.variantId);
      if (!variant || !Number.isInteger(data.quantity) || data.quantity < 0) return send(422, { error: 'invalid_item_or_quantity' });
      if (data.quantity > variant.stock) return send(409, { error: 'stock_insufficient', stock: variant.stock });
      shop.cart = shop.cart.filter(line => line.variantId !== variant.id);
      if (data.quantity) shop.cart.push({ productId: item.id, variantId: variant.id, quantity: data.quantity });
      shop.cartRevision++;
      commit();
    } else if (method !== 'GET') return send(405, { error: 'method' });
    const lines = cartLines(shop);
    return send(200, { lines, revision: shop.cartRevision, ...totals(lines, '') });
  }
  if (method === 'POST' && route === '/quote') {
    if (!shop.cart.length) return send(422, { error: 'cart_empty' });
    if (data.cartRevision !== shop.cartRevision) return send(409, { error: 'cart_changed' });
    if (!data.address?.recipient || !/^1\d{10}$/.test(data.address?.phone || '') || (data.address?.street || '').length < 6)
      return send(422, { error: 'address_invalid' });
    if (data.coupon && data.coupon !== 'SAVE10') return send(422, { error: 'coupon_invalid' });
    const lines = cartLines(shop);
    if (data.platformCoupon && (data.platformCoupon !== 'CITY5' || !shop.claimedCoupons.includes('CITY5'))) return send(422, { error: 'coupon_not_claimed' });
    if (data.deliverySlot && !['尽快送达', '今天 18:00–18:30', '今天 19:00–19:30'].includes(data.deliverySlot)) return send(422, { error: 'delivery_slot_unavailable' });
    const quote = { id: `Q${Object.keys(shop.quotes).length + 1}`, cartRevision: shop.cartRevision,
      priceVersion: shop.priceVersion, address: data.address, coupon: data.coupon || '', lines, ...totals(lines, data.coupon) };
    quote.platformDiscount = data.platformCoupon === 'CITY5' && quote.subtotal >= 4000 ? 500 : 0;
    quote.payable -= quote.platformDiscount;
    quote.deliverySlot = data.deliverySlot || '尽快送达';
    shop.quotes[quote.id] = quote;
    return finish(201, { quote });
  }
  if (route === '/orders' && method === 'POST') {
    if (typeof data.idempotencyKey !== 'string' || !data.idempotencyKey) return send(422, { error: 'idempotency_key_required' });
    shop.orderAttempts++;
    const existing = Object.values(shop.orders).find(order => order.idempotencyKey === data.idempotencyKey);
    if (existing) return finish(200, { order: existing, repeated: true });
    const quote = shop.quotes[data.quoteId];
    if (!quote) return finish(422, { error: 'quote_required' });
    if (run.config.stalePriceOnce && !shop.faults.includes('price_changed')) {
      shop.priceVersion++; shop.products[0].variants[0].price += 100;
      shop.faults.push('price_changed');
    }
    if (quote.priceVersion !== shop.priceVersion) return finish(409, { error: 'price_changed', committed: false });
    if (quote.cartRevision !== shop.cartRevision) return finish(409, { error: 'cart_changed', committed: false });
    for (const line of quote.lines) {
      const variant = shop.products.find(item => item.id === line.productId).variants.find(item => item.id === line.variantId);
      if (variant.stock < line.quantity) return finish(409, { error: 'stock_insufficient', committed: false });
    }
    const order = { ...quote, id: `BUY${Object.keys(shop.orders).length + 1}`, idempotencyKey: data.idempotencyKey,
      status: 'awaiting_payment', payment: null, refund: null, revision: 1 };
    shop.orders[order.id] = order;
    for (const line of order.lines) shop.products.find(item => item.id === line.productId).variants.find(item => item.id === line.variantId).stock -= line.quantity;
    shop.cart = []; shop.cartRevision++;
    return finish(201, { order });
  }
  if (route === '/orders' && method === 'GET') return send(200, { orders: Object.values(shop.orders) });
  const selected = /^\/orders\/([^/]+)(?:\/(pay|cancel|refund))?$/.exec(route);
  if (!selected || !shop.orders[selected[1]]) return send(404, { error: 'not_found' });
  const order = shop.orders[selected[1]], action = selected[2];
  if (method === 'GET' && !action) return send(200, { order });
  if (method !== 'POST') return send(405, { error: 'method' });
  if (action === 'pay') {
    if (!data.idempotencyKey) return send(422, { error: 'idempotency_key_required' });
    shop.paymentAttempts++;
    if (order.payment?.key === data.idempotencyKey) return finish(200, { order, repeated: true });
    if (order.status !== 'awaiting_payment') return finish(409, { error: 'order_not_payable', order });
    order.status = 'paid'; order.revision++;
    order.payment = { key: data.idempotencyKey, amount: order.payable, id: `PAY${shop.ledger.length + 1}` };
    shop.ledger.push({ type: 'payment', orderId: order.id, ...order.payment });
    commit();
    if (run.config.paymentResponseLostOnce && !shop.faults.includes('payment_response_lost')) {
      shop.faults.push('payment_response_lost'); commit(); return loseResponse('payment_response_lost_after_commit');
    }
    return send(200, { order });
  }
  if (action === 'refund') {
    if (!data.idempotencyKey || !data.reason) return send(422, { error: 'refund_reason_and_key_required' });
    if (order.refund?.key === data.idempotencyKey) return send(200, { order, repeated: true });
    if (order.status !== 'paid') return send(409, { error: 'order_not_refundable', order });
    order.status = 'refunded'; order.revision++;
    order.refund = { key: data.idempotencyKey, reason: data.reason, amount: order.payment.amount, id: `REF${shop.ledger.length + 1}` };
    shop.ledger.push({ type: 'refund', orderId: order.id, ...order.refund });
  } else if (action === 'cancel') {
    if (order.status === 'cancelled') return send(200, { order, repeated: true });
    if (order.status !== 'awaiting_payment') return send(409, { error: 'order_not_cancellable', order });
    order.status = 'cancelled'; order.revision++;
  } else return send(404, { error: 'operation' });
  for (const line of order.lines) shop.products.find(item => item.id === line.productId).variants.find(item => item.id === line.variantId).stock += line.quantity;
  return finish(200, { order });
}
