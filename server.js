require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'thuy-mong-data')
  : path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');
}

function readOrders() {
  const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
  try {
    return JSON.parse(raw) || [];
  } catch (error) {
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

function findOrderByCode(code) {
  return readOrders().find((order) => order.orderCode === code) || null;
}

function saveOrder(order) {
  const orders = readOrders();
  const index = orders.findIndex((entry) => entry.orderCode === order.orderCode);
  if (index >= 0) {
    orders[index] = order;
  } else {
    orders.push(order);
  }
  writeOrders(orders);
  return order;
}

const supabaseEnabled = Boolean((process.env.SUPABASE_URL || '').trim() && (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim());

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function supabaseRequest(pathname, options = {}) {
  const response = await fetchWithTimeout(`${process.env.SUPABASE_URL}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  }, 4000);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase API error: ${response.status} ${errorText}`);
  }

  if (response.status === 204) return null;
  const responseText = await response.text();
  if (!responseText) return null;
  return JSON.parse(responseText);
}

async function readOrdersPersistent() {
  const localOrders = readOrders();
  if (!supabaseEnabled) return localOrders;

  try {
    const rows = await Promise.race([
      supabaseRequest('orders?select=order_data&order=created_at.desc'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase query timeout')), 1500))
    ]);

    const remoteOrders = Array.isArray(rows) ? rows.map((row) => row.order_data).filter(Boolean) : [];
    return remoteOrders.length ? remoteOrders : localOrders;
  } catch (error) {
    console.warn('Supabase read failed, falling back to local file store:', error.message);
    return localOrders;
  }
}

async function findOrderPersistent(orderCode) {
  const localOrder = findOrderByCode(orderCode);
  if (!supabaseEnabled) return localOrder;

  try {
    const rows = await Promise.race([
      supabaseRequest(`orders?order_code=eq.${encodeURIComponent(orderCode)}&select=order_data&limit=1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase lookup timeout')), 1500))
    ]);

    if (rows?.[0]?.order_data) return rows[0].order_data;
    return localOrder;
  } catch (error) {
    console.warn('Supabase lookup failed, falling back to local file store:', error.message);
    return localOrder;
  }
}

async function saveOrderPersistent(order) {
  const localSaved = saveOrder(order);
  if (!supabaseEnabled) return localSaved;

  try {
    await Promise.race([
      supabaseRequest('orders?on_conflict=order_code', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          order_code: order.orderCode,
          order_data: order,
          updated_at: new Date().toISOString()
        })
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase save timeout')), 1500))
    ]);
    return order;
  } catch (error) {
    console.warn('Supabase save failed, falling back to local file store:', error.message);
    return localSaved;
  }
}

function getOrderSummary(orders) {
  const totalRevenue = orders
    .filter((order) => order.status === 'Đã thanh toán')
    .reduce((sum, order) => sum + Number(order.total || 0), 0);

  return {
    totalRevenue,
    totalOrders: orders.length,
    paidOrders: orders.filter((order) => order.status === 'Đã thanh toán').length,
    pendingOrders: orders.filter((order) => order.status === 'Chờ thanh toán').length,
    usedTickets: orders.filter((order) => order.ticketStatus === 'Đã sử dụng').length
  };
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/assets', express.static(path.join(__dirname, 'public')));

const ticketTypes = [
  {
    id: 'pt',
    name: 'Vé Phổ Thông',
    price: 100000,
    benefit: 'Ghế khu vực tầng chính, tầm nhìn tiêu chuẩn, thưởng thức trọn vẹn suất diễn múa rối nước.'
  },
  {
    id: 'tc',
    name: 'Vé Tiêu Chuẩn',
    price: 130000,
    benefit: 'Ghế vị trí trung tâm rõ hơn, tặng kèm 01 quạt giấy lưu niệm thiết kế độc quyền sự kiện.'
  },
  {
    id: 'cc',
    name: 'Vé Cao Cấp',
    price: 160000,
    benefit: 'Ghế cận sân khấu view đẹp, tặng kèm 01 túi vải canvas "Thủy Mộng" và móc khóa nghệ thuật.'
  },
  {
    id: 'vip',
    name: 'Vé VIP',
    price: 200000,
    benefit: 'Ghế hàng đầu sát mặt nước, đặc quyền check-in lối đi riêng, nhận trọn bộ quà tặng (Áo thun, túi vải, móc khóa, quạt giấy) và thư cảm ơn độc quyền.'
  }
];

const merchItems = [
  { id: 'shirt', name: 'Áo thun Thủy Mộng', price: 240000 },
  { id: 'bag', name: 'Túi vải canvas Thủy Mộng', price: 180000 },
  { id: 'keychain', name: 'Móc khóa nghệ thuật', price: 65000 },
  { id: 'fan', name: 'Quạt giấy lưu niệm', price: 50000 }
];

function generateOrderCode() {
  return `TM-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function calculateOrderTotal(items = []) {
  return items.reduce((sum, item) => {
    const unitPrice = Number(item.price) || 0;
    const quantity = Number(item.quantity) || 0;
    return sum + unitPrice * quantity;
  }, 0);
}

function createQrCodeUrl(order) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(getQrPayload(order))}`;
}

function createBankPayment(order) {
  const bankCode = 'MB';
  const accountNumber = '0000022225519';
  const accountName = 'CHU ANH GIANG';
  const paymentQrUrl = `https://img.vietqr.io/image/${bankCode}-${accountNumber}-compact2.png?amount=${order.total}&addInfo=${encodeURIComponent(order.orderCode)}&accountName=${encodeURIComponent(accountName)}`;

  return {
    provider: 'bank-transfer',
    bankName: 'MB Bank',
    accountNumber,
    accountName,
    paymentQrUrl,
    transferContent: order.orderCode
  };
}

function getQrPayload(order) {
  return `THUY_MONG|${order.orderCode}|${order.customer.email}|${order.customer.name}|${order.createdAt}`;
}

function verifySePaySignature(body, signature) {
  const secret = process.env.SEPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return true;
  const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
  return expected === signature;
}

async function createSePayPayment(order) {
  const sePayApiUrl = process.env.SEPAY_PAYMENT_URL;
  const apiKey = process.env.SEPAY_API_KEY;
  const baseReturnUrl = process.env.SEPAY_RETURN_URL || 'http://localhost:3000/';

  if (!sePayApiUrl || !apiKey) {
    return {
      provider: 'mock',
      paymentUrl: `${baseReturnUrl}?orderCode=${encodeURIComponent(order.orderCode)}&amount=${order.total}`,
      qrCodeUrl: createQrCodeUrl(order),
      message: 'SePay chưa được cấu hình. Đang dùng mock payment URL cho local testing.'
    };
  }

  try {
    const response = await fetchWithTimeout(sePayApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        orderCode: order.orderCode,
        amount: order.total,
        description: order.orderCode,
        returnUrl: baseReturnUrl
      })
    }, 8000);

    if (!response.ok) {
      throw new Error(`SePay payment API error: ${response.status}`);
    }

    const data = await response.json();
    return {
      provider: 'sepay',
      paymentUrl: data.paymentUrl || data.url || data.checkoutUrl || data.link || `${baseReturnUrl}?orderCode=${encodeURIComponent(order.orderCode)}`,
      qrCodeUrl: data.qrCodeUrl || data.qr || data.qrcode || createQrCodeUrl(order),
      raw: data
    };
  } catch (error) {
    console.error('SePay payment creation failed:', error.message);
    return {
      provider: 'mock',
      paymentUrl: `${baseReturnUrl}?orderCode=${encodeURIComponent(order.orderCode)}&amount=${order.total}`,
      qrCodeUrl: createQrCodeUrl(order),
      message: 'SePay API lỗi, đang dùng mock URL để giữ luồng demo.'
    };
  }
}

function decodeQrPayload(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') return null;
  const [prefix, orderCode] = rawValue.split('|');
  if (!orderCode || prefix !== 'THUY_MONG') return null;
  return orderCode;
}

async function sendResendEmail(order) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('RESEND_API_KEY not configured. Skipping email delivery.');
    return { skipped: true };
  }

  const qrCodeUrl = order.qrCodeUrl || createQrCodeUrl(order);
  const fromAddress = process.env.RESEND_FROM || 'Thủy Mộng <onboarding@resend.dev>';
  const emailPayload = {
    from: fromAddress,
    to: [order.customer.email],
    subject: `Xác nhận đặt vé Thủy Mộng - ${order.orderCode}`,
    html: `
      <h2>Xin chào ${order.customer.name},</h2>
      <p>Đơn hàng của bạn đã được xác nhận thanh toán thành công.</p>
      <p><strong>Mã đơn hàng:</strong> ${order.orderCode}</p>
      <p><strong>Tổng tiền:</strong> ${new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(order.total)}</p>
      <p><strong>Sự kiện:</strong> Thủy Mộng - 17/10/2026</p>
      <p><strong>QR Check-in:</strong></p>
      <img src="cid:thuy-mong-checkin-qr" alt="QR Check-in Thủy Mộng" style="width: 180px; height: 180px;" />
      <p>QR cũng được đính kèm dưới dạng ảnh PNG. Vui lòng mang mã QR này khi đến sự kiện để check-in.</p>
      <p>Trân trọng,<br />Ban tổ chức Thủy Mộng</p>
    `
  };

  try {
    const qrResponse = await fetchWithTimeout(qrCodeUrl, {}, 5000);
    if (qrResponse.ok) {
      const qrBuffer = Buffer.from(await qrResponse.arrayBuffer());
      emailPayload.attachments = [{
        filename: `qr-checkin-${order.orderCode}.png`,
        content: qrBuffer.toString('base64'),
        content_id: 'thuy-mong-checkin-qr'
      }];
    }
  } catch (error) {
    console.warn('QR attachment unavailable; sending email with inline QR URL:', error.message);
  }

  const response = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailPayload)
  }, 8000);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend API error: ${response.status} ${errorText}`);
  }

  return response.json();
}

app.get('/api/config', (req, res) => {
  res.json({
    eventName: 'Thủy Mộng',
    eventDate: '2026-10-17',
    formattedDate: '17/10/2026',
    tickets: ticketTypes,
    merch: merchItems,
    contact: {
      unit: 'Nhà Hát Múa Rối Việt Nam',
      address: '361 Trường Chinh, Thanh Xuân, Hà Nội',
      phone: '096 775 20 06',
      email: 'thuymongsukien2026@gmail.com'
    },
    payment: {
      bankName: 'MB Bank',
      accountNumber: '0000022225519',
      accountName: 'CHU ANH GIANG',
      webhookUrl: 'https://thuy-mong.vercel.app/api/sepay-webhook'
    }
  });
});

app.get('/api/health', async (req, res) => {
  const startedAt = Date.now();
  if (!supabaseEnabled) {
    return res.json({ ok: true, supabase: 'not-configured' });
  }

  try {
    await supabaseRequest('orders?select=order_code&limit=1');
    return res.json({ ok: true, supabase: 'connected', durationMs: Date.now() - startedAt });
  } catch (error) {
    return res.status(503).json({ ok: false, supabase: 'error', durationMs: Date.now() - startedAt, error: error.message });
  }
});

app.post('/api/orders', async (req, res) => {
  const { customer, cart, paymentMethod } = req.body || {};

  if (!customer || !cart || !Array.isArray(cart.items) || !customer.name || !customer.phone || !customer.email) {
    return res.status(400).json({ message: 'Thiếu thông tin khách hàng hoặc giỏ hàng.' });
  }

  const items = cart.items.map((item) => ({
    id: item.id,
    name: item.name,
    price: Number(item.price) || 0,
    quantity: Number(item.quantity) || 0,
    type: item.type || 'ticket'
  }));

  const total = calculateOrderTotal(items);
  const orderCode = generateOrderCode();
  const now = new Date().toISOString();
  const normalizedPaymentMethod = String(paymentMethod || 'COD').toUpperCase();
  const order = {
    id: `TM-${Date.now()}`,
    orderCode,
    customer: {
      name: customer.name,
      phone: customer.phone,
      email: customer.email
    },
    paymentMethod: normalizedPaymentMethod,
    items,
    total,
    status: 'Chờ thanh toán',
    ticketStatus: 'Chưa sử dụng',
    createdAt: now,
    qrCodeUrl: null,
    emailSent: false,
    checkedInAt: null
  };

  let payment = createBankPayment(order);
  if (normalizedPaymentMethod === 'SEPAY' || normalizedPaymentMethod === 'PAYMENT_SEPAY') {
    payment = await createSePayPayment(order);
    order.paymentUrl = payment.paymentUrl;
    order.qrCodeUrl = payment.qrCodeUrl;
  }

  await saveOrderPersistent(order);

  res.status(201).json({
    message: 'Đặt vé thành công!',
    order,
    payment
  });
});

app.get('/api/orders/:orderCode/status', async (req, res) => {
  const order = await findOrderPersistent(req.params.orderCode);
  const email = String(req.query.email || '').trim().toLowerCase();

  if (!order || !email || order.customer.email.toLowerCase() !== email) {
    return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' });
  }

  return res.json({
    order: {
      orderCode: order.orderCode,
      status: order.status,
      ticketStatus: order.ticketStatus,
      total: order.total,
      qrCodeUrl: order.qrCodeUrl,
      emailSent: order.emailSent,
      emailError: order.emailError || null,
      paidAt: order.paidAt || null,
      checkedInAt: order.checkedInAt || null
    }
  });
});

app.get('/api/admin/orders', async (req, res) => {
  const { status, search } = req.query;
  const allOrders = readOrders();

  const filteredOrders = allOrders.filter((order) => {
    const matchesStatus = !status || status === 'all' || order.status === status;
    const text = `${order.orderCode} ${order.customer.name} ${order.customer.phone}`.toLowerCase();
    const matchesSearch = !search || text.includes(String(search).toLowerCase());
    return matchesStatus && matchesSearch;
  });

  res.json({
    summary: getOrderSummary(allOrders),
    orders: filteredOrders
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  });
});

app.post('/api/admin/checkin', async (req, res) => {
  const { qrCode } = req.body || {};
  if (!qrCode) {
    return res.status(400).json({ message: 'Thiếu dữ liệu mã QR.' });
  }

  const orderCode = decodeQrPayload(qrCode);
  if (!orderCode) {
    return res.status(400).json({ message: 'Mã QR không hợp lệ.' });
  }

  const order = await findOrderPersistent(orderCode);
  if (!order) {
    return res.status(404).json({ message: 'Không tìm thấy vé tương ứng với mã QR.' });
  }

  if (order.status !== 'Đã thanh toán') {
    return res.status(409).json({ message: 'Vé chưa được thanh toán, chưa thể check-in.' });
  }

  if (order.ticketStatus === 'Đã sử dụng') {
    return res.status(409).json({
      message: 'Vé này đã được check-in trước đó!',
      order
    });
  }

  order.ticketStatus = 'Đã sử dụng';
  order.checkedInAt = new Date().toISOString();
  await saveOrderPersistent(order);

  return res.status(200).json({
    message: 'Check-in thành công!',
    order
  });
});

app.get('/api/sepay-webhook', (req, res) => {
  res.json({
    ok: true,
    message: 'SePay webhook is ready. Send POST transactions to this URL.',
    url: 'https://thuy-mong.vercel.app/api/sepay-webhook'
  });
});

app.post('/api/sepay-webhook', async (req, res) => {
  const payload = req.body || {};
  const transaction = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const rawSignature = req.headers['x-signature'] || req.headers['signature'] || req.headers['x-sepay-signature'];
  const orderCodeFromPayload = transaction.orderCode || transaction.description || transaction.reference || transaction.referenceCode || transaction.order_id || transaction.content || transaction.transactionContent || transaction.transferContent;
  const amount = Number(transaction.amount ?? transaction.transferAmount ?? transaction.transfer_amount ?? transaction.transfer_amount_in ?? 0);

  if (process.env.SEPAY_WEBHOOK_SECRET && rawSignature && !verifySePaySignature(payload, rawSignature)) {
    return res.status(401).json({ message: 'Chữ ký webhook SePay không hợp lệ.' });
  }

  if (!orderCodeFromPayload) {
    return res.status(400).json({ message: 'Thiếu mã đơn hàng trong webhook SePay.' });
  }

  const orderCodeText = String(orderCodeFromPayload || '');
  const existingOrders = await readOrdersPersistent();
  const order = await findOrderPersistent(orderCodeText) || existingOrders.find((entry) => (
    orderCodeText.includes(entry.orderCode) ||
    String(transaction.description || '').includes(entry.orderCode) ||
    String(transaction.transactionContent || '').includes(entry.orderCode) ||
    String(transaction.content || '').includes(entry.orderCode)
  ));

  if (!order) {
    return res.status(404).json({ message: 'Không tìm thấy đơn hàng tương ứng.' });
  }

  const paymentSucceeded = transaction.code === undefined || transaction.code === '00' || transaction.code === 0 || transaction.transferType === 'in';
  if (!paymentSucceeded) {
    return res.status(200).json({ message: 'Giao dịch chưa thành công.', order });
  }

  if (Number(order.total) !== amount) {
    return res.status(200).json({ message: 'Số tiền không khớp với đơn hàng.', order });
  }

  if (order.status === 'Đã thanh toán' && order.emailSent) {
    return res.status(200).json({ message: 'Webhook đã được xử lý trước đó.', order });
  }

  order.status = 'Đã thanh toán';
  order.ticketStatus = 'Chưa sử dụng';
  order.paidAt = new Date().toISOString();
  order.qrCodeUrl = createQrCodeUrl(order);

  await saveOrderPersistent(order);

  try {
    const emailResult = await sendResendEmail(order);
    order.emailSent = !emailResult.skipped;
    order.emailId = emailResult.id || null;
    delete order.emailError;
    await saveOrderPersistent(order);

    if (emailResult.skipped) {
      return res.status(200).json({
        message: 'Đã thanh toán thành công. Email xác nhận chưa được gửi vì cấu hình email chưa được thiết lập.',
        order
      });
    }

    return res.status(200).json({
      message: 'Thanh toán thành công và email xác nhận đã được gửi.',
      order
    });
  } catch (error) {
    order.emailSent = false;
    order.emailError = error.message;
    await saveOrderPersistent(order);
    return res.status(200).json({
      message: 'Đã thanh toán nhưng gửi email xác nhận thất bại.',
      order
    });
  }
});

app.post('/api/orders/:orderCode/resend-email', async (req, res) => {
  const order = await findOrderPersistent(req.params.orderCode);
  if (!order) {
    return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' });
  }

  if (order.status !== 'Đã thanh toán') {
    return res.status(409).json({ message: 'Đơn hàng chưa được thanh toán.' });
  }

  order.qrCodeUrl = order.qrCodeUrl || createQrCodeUrl(order);
  try {
    const emailResult = await sendResendEmail(order);
    order.emailSent = !emailResult.skipped;
    order.emailId = emailResult.id || null;
    delete order.emailError;
    await saveOrderPersistent(order);
    return res.status(200).json({ message: 'Đã gửi lại email QR check-in.', order });
  } catch (error) {
    order.emailSent = false;
    order.emailError = error.message;
    await saveOrderPersistent(order);
    return res.status(502).json({ message: 'Gửi lại email thất bại.', error: error.message, order });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/contact', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function startServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`Thủy Mộng app is running at http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  readOrders,
  findOrderByCode,
  saveOrder,
  createQrCodeUrl,
  sendResendEmail,
  decodeQrPayload,
  getOrderSummary
};
