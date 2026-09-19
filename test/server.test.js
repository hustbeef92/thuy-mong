const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { app } = require('../server');

const request = async (fetchImpl, method, path, body, port) => {
  const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json();
  return { status: response.status, json };
};

test('POST /api/orders creates a pending order with total and orderCode', async () => {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const result = await request(global.fetch, 'POST', '/api/orders', {
      customer: { name: 'Nguyễn Văn A', phone: '0900000000', email: 'a@example.com' },
      cart: { items: [{ id: 'pt', name: 'Vé Phổ Thông', price: 100000, quantity: 2, type: 'ticket' }] },
      paymentMethod: 'BANK'
    }, port);

    assert.equal(result.status, 201);
    assert.equal(result.json.message, 'Đặt vé thành công!');
    assert.equal(result.json.order.status, 'Chờ thanh toán');
    assert.equal(result.json.order.total, 200000);
    assert.ok(result.json.order.orderCode);

    const status = await request(global.fetch, 'GET', `/api/orders/${result.json.order.orderCode}/status?email=a%40example.com`, null, port);
    assert.equal(status.status, 200);
    assert.equal(status.json.order.status, 'Chờ thanh toán');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/sepay-webhook accepts webhook signatures generated from raw request body', async () => {
  const originalFetch = global.fetch;
  const server = app.listen(0);

  try {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.SEPAY_WEBHOOK_SECRET = 'test-secret';

    const port = server.address().port;
    const created = await request(global.fetch, 'POST', '/api/orders', {
      customer: { name: 'Nguyễn Văn C', phone: '0902222222', email: 'c@example.com' },
      cart: { items: [{ id: 'cc', name: 'Vé Cao Cấp', price: 160000, quantity: 1, type: 'ticket' }] },
      paymentMethod: 'MOMO'
    }, port);

    const orderCode = created.json.order.orderCode;
    const payload = {
      amount: 160000,
      orderCode,
      code: '00',
      description: orderCode,
      transferType: 'in'
    };
    const rawBody = '{"amount":160000,"orderCode":"' + orderCode + '","code":"00","description":"' + orderCode + '","transferType":"in"}';
    const signature = crypto.createHmac('sha256', process.env.SEPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');

    global.fetch = async (url, options) => {
      if (String(url).includes('api.resend.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'email-2' }),
          text: async () => ''
        };
      }
      return originalFetch(url, options);
    };

    const response = await fetch(`http://127.0.0.1:${port}/api/sepay-webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signature
      },
      body: rawBody
    });

    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.order.status, 'Đã thanh toán');
    assert.ok(result.order.qrCodeUrl);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/sepay-webhook updates status, creates QR and sends email when amount matches', async () => {
  const originalFetch = global.fetch;
  const server = app.listen(0);
  const calls = [];

  try {
    process.env.RESEND_API_KEY = 'test-key';
    const port = server.address().port;
    const created = await request(global.fetch, 'POST', '/api/orders', {
      customer: { name: 'Nguyễn Văn B', phone: '0901111111', email: 'b@example.com' },
      cart: { items: [{ id: 'tc', name: 'Vé Tiêu Chuẩn', price: 130000, quantity: 1, type: 'ticket' }] },
      paymentMethod: 'MOMO'
    }, port);

    const orderCode = created.json.order.orderCode;
    global.fetch = async (url, options) => {
      if (String(url).includes('api.resend.com')) {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'email-1' }),
          text: async () => ''
        };
      }
      return originalFetch(url, options);
    };

    const result = await request(originalFetch, 'POST', '/api/sepay-webhook', {
      code: '00',
      orderCode,
      amount: 130000,
      description: orderCode,
      transferType: 'in'
    }, port);

    assert.equal(result.status, 200);
    assert.equal(result.json.order.status, 'Đã thanh toán');
    assert.ok(result.json.order.qrCodeUrl);
    assert.equal(calls.length >= 1, true);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('paid order email includes QR attachment and check-in is single-use', async () => {
  const originalFetch = global.fetch;
  const server = app.listen(0);
  let resendPayload;

  try {
    process.env.RESEND_API_KEY = 'test-key';
    const port = server.address().port;
    const created = await request(originalFetch, 'POST', '/api/orders', {
      customer: { name: 'Nguyễn Văn D', phone: '0903333333', email: 'd@example.com' },
      cart: { items: [{ id: 'vip', name: 'Vé VIP', price: 200000, quantity: 1, type: 'ticket' }] },
      paymentMethod: 'BANK'
    }, port);

    const order = created.json.order;
    global.fetch = async (url, options) => {
      if (String(url).includes('api.qrserver.com')) {
        return {
          ok: true,
          arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer
        };
      }
      if (String(url).includes('api.resend.com')) {
        resendPayload = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'email-qr' }),
          text: async () => ''
        };
      }
      return originalFetch(url, options);
    };

    const paid = await request(originalFetch, 'POST', '/api/sepay-webhook', {
      code: '00',
      orderCode: order.orderCode,
      amount: 200000,
      description: order.orderCode,
      transferType: 'in'
    }, port);

    assert.equal(paid.status, 200);
    assert.equal(paid.json.order.emailSent, true);
    assert.equal(resendPayload.attachments.length, 1);
    assert.equal(resendPayload.attachments[0].filename, `qr-checkin-${order.orderCode}.png`);
    assert.match(resendPayload.html, /cid:thuy-mong-checkin-qr/);

    const qrPayload = `THUY_MONG|${order.orderCode}|${order.customer.email}|${order.customer.name}|${order.createdAt}`;
    const checkedIn = await request(originalFetch, 'POST', '/api/admin/checkin', { qrCode: qrPayload }, port);
    const repeated = await request(originalFetch, 'POST', '/api/admin/checkin', { qrCode: qrPayload }, port);

    assert.equal(checkedIn.status, 200);
    assert.equal(checkedIn.json.order.ticketStatus, 'Đã sử dụng');
    assert.equal(repeated.status, 409);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SePay transactionContent payload updates payment and sends QR email', async () => {
  const originalFetch = global.fetch;
  const server = app.listen(0);
  try {
    process.env.RESEND_API_KEY = 'test-key';
    const port = server.address().port;
    const created = await request(originalFetch, 'POST', '/api/orders', {
      customer: { name: 'SePay Customer', phone: '0904444444', email: 'sepay@example.com' },
      cart: { items: [{ id: 'pt', name: 'Vé Phổ Thông', price: 100000, quantity: 1, type: 'ticket' }] },
      paymentMethod: 'BANK'
    }, port);
    const order = created.json.order;

    global.fetch = async (url, options) => {
      if (String(url).includes('api.qrserver.com')) {
        return { ok: true, arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer };
      }
      if (String(url).includes('api.resend.com')) {
        return { ok: true, status: 200, json: async () => ({ id: 'email-sepay' }), text: async () => '' };
      }
      return originalFetch(url, options);
    };

    const result = await request(originalFetch, 'POST', '/api/sepay-webhook', {
      id: 123,
      transferType: 'in',
      transferAmount: 100000,
      transactionContent: `Thanh toan ${order.orderCode}`,
      referenceCode: 'FT123'
    }, port);

    assert.equal(result.status, 200);
    assert.equal(result.json.order.status, 'Đã thanh toán');
    assert.equal(result.json.order.emailSent, true);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});
