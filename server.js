require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'thuy-mong-data')
  : path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const BUNDLED_ITEMS_FILE = path.join(__dirname, 'data', 'items.json');

function readItems() {
  try {
    if (fs.existsSync(ITEMS_FILE)) {
      return JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error reading items:', error.message);
  }
  return [];
}

function saveItems(items) {
  try {
    fs.writeFileSync(ITEMS_FILE, JSON.stringify(items, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error saving items:', error.message);
    return false;
  }
}

const BUNDLED_ORDERS_FILE = path.join(__dirname, 'data', 'orders.json');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Khởi tạo orders.json
if (!fs.existsSync(ORDERS_FILE)) {
  if (fs.existsSync(BUNDLED_ORDERS_FILE)) {
    try {
      fs.copyFileSync(BUNDLED_ORDERS_FILE, ORDERS_FILE);
    } catch (_) {
      fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');
    }
  } else {
    fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');
  }
}

// Khởi tạo items.json
if (!fs.existsSync(ITEMS_FILE)) {
  if (fs.existsSync(BUNDLED_ITEMS_FILE)) {
    try {
      fs.copyFileSync(BUNDLED_ITEMS_FILE, ITEMS_FILE);
    } catch (_) {
      fs.writeFileSync(ITEMS_FILE, '[]', 'utf8');
    }
  } else {
    fs.writeFileSync(ITEMS_FILE, '[]', 'utf8');
  }
}

function readOrders() {
  const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
  try {
    return JSON.parse(raw) || [];
  } catch (error) {
    return [];
  }
}

const MAX_STORED_ORDERS = 700;

function writeOrders(orders) {
  const limitedOrders = Array.isArray(orders) ? orders.slice(-MAX_STORED_ORDERS) : [];
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(limitedOrders, null, 2), 'utf8');
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
  const trimmedOrders = orders.slice(-MAX_STORED_ORDERS);
  writeOrders(trimmedOrders);
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

async function readOrdersPersistent(timeoutMs = 2500) {
  const localOrders = readOrders();
  if (!supabaseEnabled) return localOrders;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders?select=order_data&order=created_at.desc&limit=50`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) return localOrders;
    const rows = await response.json();
    const remoteOrders = Array.isArray(rows) ? rows.map((r) => r.order_data).filter(Boolean) : [];
    return remoteOrders.length ? remoteOrders : localOrders;
  } catch (error) {
    clearTimeout(timer);
    console.warn('Supabase read failed, fallback to local store:', error.message);
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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/assets', express.static(path.join(__dirname, 'public')));

// Danh sách mặt hàng (vé, merch) nay được tải động từ data/items.json thông qua hàm readItems()

function generateOrderCode() {
  return `TM-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function calculateOrderTotal(items = []) {
  const normalizedItems = Array.isArray(items) ? items.map((item) => ({
    id: String(item.id || ''),
    price: Number(item.price) || 0,
    quantity: Number(item.quantity) || 0,
    type: String(item.type || 'ticket')
  })) : [];

  const ticketItems = normalizedItems.filter((item) => item.type === 'ticket');
  const merchItems = normalizedItems.filter((item) => item.type === 'merch');
  const ticketCount = ticketItems.reduce((sum, item) => sum + item.quantity, 0);
  const ticketTierIds = new Set(ticketItems.map((item) => item.id));
  const hasValueTicket = ticketTierIds.has('sao-may') || ticketTierIds.has('thanh-la') || ticketTierIds.has('y-mon');
  const hasTuLinh = ticketTierIds.has('tu-linh');
  const khanItem = merchItems.find((item) => item.id === 'khan');
  const comboItem = merchItems.find((item) => item.id === 'combo-merch');

  let subtotal = normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

  if (ticketCount >= 4) {
    const ticketSubtotal = ticketItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    subtotal -= ticketSubtotal * 0.1;
  }

  if ((hasValueTicket || hasTuLinh) && khanItem) {
    const rate = hasTuLinh ? 0.15 : 0.05;
    subtotal -= khanItem.price * khanItem.quantity * rate;
  }

  if (hasTuLinh && comboItem) {
    subtotal -= comboItem.price * comboItem.quantity;
  }

  return Math.round(Math.max(0, subtotal));
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

  const normalized = body && typeof body === 'object' ? body : {};
  const variants = [];

  if (normalized.data && typeof normalized.data === 'object') {
    variants.push(JSON.stringify(normalized.data));
  }

  variants.push(JSON.stringify(normalized));
  variants.push(JSON.stringify({ ...normalized, data: undefined }));

  const expected = variants
    .map((value) => crypto.createHmac('sha256', secret).update(value).digest('hex'))
    .includes(String(signature).trim());

  return expected;
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

function resolveResendRecipient(email) {
  const rawEmail = String(email || '').trim().toLowerCase();
  if (!rawEmail) return 'delivered@resend.dev';

  const allowTestSend = String(process.env.RESEND_ALLOW_TEST_EMAIL || '').toLowerCase() === 'true';
  const usesExampleDomain = rawEmail.endsWith('@example.com') || rawEmail.includes('example.com');

  if (usesExampleDomain && allowTestSend) {
    return process.env.RESEND_TEST_EMAIL || 'delivered@resend.dev';
  }

  return rawEmail;
}

async function sendGmailSmtpEmail(order) {
  const gmailUser = (process.env.GMAIL_USER || process.env.SMTP_USER || '').trim();
  const gmailPass = (process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS || '').trim().replace(/\s+/g, '');

  if (!gmailUser || !gmailPass || !nodemailer) {
    return null;
  }

  const recipient = String(order.customer?.email || '').trim();
  if (!recipient) {
    return { skipped: true, reason: 'Không có email người nhận.' };
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: gmailUser,
      pass: gmailPass
    }
  });

  const qrCodeUrl = order.qrCodeUrl || createQrCodeUrl(order);
  const attachments = [];
  try {
    const qrResponse = await fetchWithTimeout(qrCodeUrl, {}, 5000);
    if (qrResponse.ok) {
      const qrBuffer = Buffer.from(await qrResponse.arrayBuffer());
      attachments.push({
        filename: `qr-checkin-${order.orderCode}.png`,
        content: qrBuffer,
        cid: 'thuy-mong-checkin-qr'
      });
    }
  } catch (err) {
    console.warn('QR attachment download failed:', err.message);
  }

  const itemsList = (order.items || []).map((it) => `${it.name} x${it.quantity}`).join(', ');

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #222; line-height: 1.6; border: 1px solid #e8decb; border-radius: 12px; overflow: hidden; background: #ffffff;">
      <div style="background: #071a1d; color: #f6f2ea; padding: 24px; text-align: center;">
        <h1 style="color: #f1c66b; margin: 0 0 6px; font-family: Georgia, serif; letter-spacing: 2px;">THỦY MỘNG</h1>
        <p style="margin: 0; font-size: 14px; opacity: 0.85;">Vé & QR Check-in Sự Kiện Múa Rối Nước</p>
      </div>
      <div style="padding: 24px;">
        <h2 style="color: #071a1d; margin-top: 0;">Xin chào ${order.customer.name},</h2>
        <p>Chúc mừng bạn! Đơn hàng đặt vé sự kiện <strong>Thủy Mộng</strong> của bạn đã được xác nhận thanh toán thành công.</p>
        
        <div style="background: #fdfbf7; border: 1px solid #f1e4ce; border-radius: 8px; padding: 16px; margin: 18px 0;">
          <p style="margin: 6px 0;"><strong>Mã đơn hàng:</strong> <span style="font-size: 1.1em; color: #071a1d; font-weight: bold;">${order.orderCode}</span></p>
          <p style="margin: 6px 0;"><strong>Các mặt hàng:</strong> ${itemsList || '—'}</p>
          <p style="margin: 6px 0;"><strong>Nơi nhận hàng:</strong> ${order.deliveryLocation || 'Nhận tại sự kiện'}</p>
          <p style="margin: 6px 0;"><strong>Tổng tiền:</strong> <span style="color: #c99a61; font-weight: bold; font-size: 1.1em;">${new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(order.total)}</span></p>
          <p style="margin: 6px 0;"><strong>Giờ check in:</strong> 17:30 - 19:35 — Thứ Bảy, 17/10/2026</p>
          <p style="margin: 6px 0;"><strong>Địa điểm:</strong> Nhà Hát Múa Rối Việt Nam, 361 Trường Chinh, Thanh Xuân, Hà Nội</p>
        </div>

        <div style="text-align: center; margin: 24px 0;">
          <p style="font-weight: bold; margin-bottom: 12px; color: #071a1d; font-size: 15px;">MÃ QR CHECK-IN VÀO CỬA</p>
          <img src="${attachments.length ? 'cid:thuy-mong-checkin-qr' : qrCodeUrl}" alt="QR Check-in" style="width: 200px; height: 200px; border: 2px solid #f1c66b; border-radius: 12px; padding: 8px; background: white; box-shadow: 0 4px 12px rgba(0,0,0,0.08);" />
          <p style="font-size: 13px; color: #777; margin-top: 8px;">(Vui lòng mang theo email này hoặc lưu ảnh QR đính kèm để check-in tại cửa sự kiện)</p>
        </div>

        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="font-size: 13px; color: #666; margin: 0;">
          Mọi thắc mắc vui lòng liên hệ Ban tổ chức Thủy Mộng:<br />
          Hotline: <strong>096 775 20 06</strong> | Email: <strong>thuymongsukien2026@gmail.com</strong>
        </p>
      </div>
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"Thủy Mộng" <${gmailUser}>`,
    to: recipient,
    subject: `[Thủy Mộng] Vé & QR Check-in sự kiện ngày 17/10/2026 - ${order.orderCode}`,
    html: htmlContent,
    attachments
  });

  return { id: info.messageId, provider: 'gmail' };
}

async function sendResendEmail(order) {
  // Ưu tiên gửi qua Gmail SMTP nếu được cấu hình
  const gmailResult = await sendGmailSmtpEmail(order);
  if (gmailResult) {
    return gmailResult;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('Chưa cấu hình Gmail hay Resend API. Bỏ qua gửi email.');
    return { skipped: true };
  }

  const qrCodeUrl = order.qrCodeUrl || createQrCodeUrl(order);
  const fromAddress = process.env.RESEND_FROM || 'Thủy Mộng <onboarding@resend.dev>';
  const recipient = resolveResendRecipient(order.customer.email);
  const emailPayload = {
    from: fromAddress,
    to: [recipient],
    subject: `Xác nhận đặt vé Thủy Mộng - ${order.orderCode}`,
    html: `
      <h2>Xin chào ${order.customer.name},</h2>
      <p>Đơn hàng của bạn đã được xác nhận thanh toán thành công.</p>
      <p><strong>Mã đơn hàng:</strong> ${order.orderCode}</p>
      <p><strong>Nơi nhận hàng:</strong> ${order.deliveryLocation || 'Nhận tại sự kiện'}</p>
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

// API Quản lý Mặt Hàng (Admin) - Được định nghĩa ở cuối file

let inventoryCache = null;
let inventoryCacheTime = 0;

async function getInventory() {
  const now = Date.now();
  if (inventoryCache && (now - inventoryCacheTime < 60000)) {
    return inventoryCache;
  }

  let orders = readOrders();
  if (supabaseEnabled) {
    try {
      const rows = await supabaseRequest('orders?select=order_data');
      if (Array.isArray(rows)) {
        orders = rows.map(r => r.order_data).filter(Boolean);
      }
    } catch (e) {
      console.warn("Error fetching remote orders for inventory:", e.message);
    }
  }

  const soldQuantities = {};
  orders.forEach(order => {
    if (order.status === 'Đã thanh toán' || order.status === 'Chờ thanh toán' || !order.status) {
      if (Array.isArray(order.items)) {
        order.items.forEach(cartItem => {
          soldQuantities[cartItem.id] = (soldQuantities[cartItem.id] || 0) + (Number(cartItem.quantity) || 0);
        });
      }
    }
  });

  inventoryCache = soldQuantities;
  inventoryCacheTime = now;
  return inventoryCache;
}

app.get('/api/config', async (req, res) => {
  const allItems = readItems();
  const soldQuantities = await getInventory();

  const ticketTypes = allItems.filter(i => i.type === 'ticket').map(ticket => {
    if (ticket.baseQuantity !== undefined) {
      const sold = soldQuantities[ticket.id] || 0;
      ticket.quantity = Math.max(0, ticket.baseQuantity - sold);
    }
    return ticket;
  });
  
  const merchItems = allItems.filter(i => i.type === 'merch').map(merch => {
    if (merch.baseQuantity !== undefined) {
      const sold = soldQuantities[merch.id] || 0;
      merch.quantity = Math.max(0, merch.baseQuantity - sold);
    }
    return merch;
  });

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

  if (!customer || !cart || !Array.isArray(cart.items) || !customer.name || !customer.phone) {
    return res.status(400).json({ message: 'Thiếu thông tin khách hàng hoặc giỏ hàng.' });
  }

  const normalizedCustomer = {
    name: String(customer.name || '').trim(),
    phone: String(customer.phone || '').trim(),
    email: String(customer.email || '').trim()
  };

  if (!normalizedCustomer.name || !normalizedCustomer.phone || !normalizedCustomer.email) {
    return res.status(400).json({ message: 'Vui lòng nhập đầy đủ họ tên, số điện thoại và email để nhận QR check-in.' });
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
  const proofImage = String(req.body?.proofImage || '').trim();
  const deliveryLocation = String(req.body?.deliveryLocation || 'Nhận tại sự kiện').trim();

  const order = {
    id: `TM-${Date.now()}`,
    orderCode,
    customer: {
      name: normalizedCustomer.name,
      phone: normalizedCustomer.phone,
      email: normalizedCustomer.email
    },
    deliveryLocation: deliveryLocation || 'Nhận tại sự kiện',
    paymentMethod: normalizedPaymentMethod,
    items,
    total,
    status: 'Chờ thanh toán',
    ticketStatus: 'Chưa sử dụng',
    createdAt: now,
    qrCodeUrl: null,
    emailSent: false,
    sendEmail: false, // Thêm trường gửi mail mặc định
    checkedInAt: null,
    proofImage: proofImage || null,
    proofUploadedAt: proofImage ? now : null
  };

  let payment = createBankPayment(order);
  if (normalizedPaymentMethod === 'SEPAY' || normalizedPaymentMethod === 'PAYMENT_SEPAY') {
    payment = await createSePayPayment(order);
    order.paymentUrl = payment.paymentUrl;
    order.qrCodeUrl = payment.qrCodeUrl;
  }

  await saveOrderPersistent(order);
  inventoryCacheTime = 0;

  // Gửi webhook tới Google Sheet
  const sheetWebhookUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL || 'https://script.google.com/macros/s/AKfycbxXPPdHXDNbRcmQPYsSoqn3MlzIOIDkvdXrTJvFrXk2ZchFkMBQb1fmLJaQzthe9Y1yzg/exec';
  try {
    await fetchWithTimeout(sheetWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    }, 5000);
  } catch (err) {
    console.error('Lỗi gửi dữ liệu về Sheet:', err.message);
  }

  res.status(201).json({
    message: 'Đặt vé thành công!',
    order,
    payment
  });
});

app.get('/api/orders/:orderCode/status', async (req, res) => {
  const order = await findOrderPersistent(req.params.orderCode);
  const email = String(req.query.email || '').trim().toLowerCase();

  if (!order) {
    return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' });
  }

  if (email && String(order.customer.email || '').trim().toLowerCase() !== email) {
    return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' });
  }

  return res.json({
    order: {
      orderCode: order.orderCode,
      status: order.status,
      ticketStatus: order.ticketStatus,
      total: order.total,
      deliveryLocation: order.deliveryLocation || 'Nhận tại sự kiện',
      qrCodeUrl: order.qrCodeUrl,
      emailSent: order.emailSent,
      emailError: order.emailError || null,
      paidAt: order.paidAt || null,
      checkedInAt: order.checkedInAt || null,
      proofImage: order.proofImage || null,
      proofUploadedAt: order.proofUploadedAt || null
    }
  });
});

app.post('/api/orders/:orderCode/proof', async (req, res) => {
  const { orderCode } = req.params;
  const { proofImage } = req.body || {};

  if (!proofImage || typeof proofImage !== 'string' || !proofImage.trim()) {
    return res.status(400).json({ message: 'Vui lòng chọn ảnh chụp biên lai hợp lệ.' });
  }

  const order = await findOrderPersistent(orderCode);
  if (!order) {
    return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' });
  }

  order.proofImage = proofImage.trim();
  order.proofUploadedAt = new Date().toISOString();
  await saveOrderPersistent(order);

  return res.status(200).json({
    message: 'Tải ảnh biên lai thành công!',
    order: {
      orderCode: order.orderCode,
      proofImage: order.proofImage,
      proofUploadedAt: order.proofUploadedAt
    }
  });
});

app.post('/api/orders/:orderCode/confirm', async (req, res) => {
  const { orderCode } = req.params;

  const order = await findOrderPersistent(orderCode);
  if (!order) {
    return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' });
  }

  order.customerConfirmed = true;
  order.customerConfirmedAt = new Date().toISOString();
  await saveOrderPersistent(order);

  return res.status(200).json({
    message: 'Xác nhận thành công!',
    order: {
      orderCode: order.orderCode,
      customerConfirmed: order.customerConfirmed,
      customerConfirmedAt: order.customerConfirmedAt
    }
  });
});

function normalizeGoogleSheetRecord(row = {}) {
  const values = row && typeof row === 'object' ? row : {};
  const orderCode = String(values.orderCode || values.order_code || values['Mã đơn'] || values['order'] || values.reference || values.content || values.transferContent || values['Nội dung'] || '').trim();
  const amount = Number(values.amount ?? values.total ?? values['Số tiền'] ?? values.amountVnd ?? values.money ?? values.transferAmount ?? 0);
  const status = String(values.status || values['Trạng thái'] || values.paymentStatus || '').trim().toLowerCase();
  const content = String(values.transferContent || values['Nội dung'] || values.content || values.description || '').trim();
  const sendEmail = values.sendEmail || values['Gửi mail'] || values['Gửi Email'] || false;

  return {
    orderCode,
    amount,
    status,
    content,
    sendEmail
  };
}

async function readGoogleSheetTransactions() {
  const sheetUrl = (process.env.GOOGLE_SHEET_URL || '').trim();
  if (!sheetUrl) return [];

  try {
    const response = await fetchWithTimeout(sheetUrl, { method: 'GET' }, 12000);
    if (!response.ok) {
      console.warn('Google Sheet fetch failed:', response.status, response.statusText);
      return [];
    }

    const text = await response.text();
    if (!text) return [];
    if (/<\/?html|<!doctype\s+html/i.test(text)) {
      return [];
    }

    const json = (() => {
      try {
        return JSON.parse(text);
      } catch (error) {
        return null;
      }
    })();

    if (json && Array.isArray(json)) {
      return json.map(normalizeGoogleSheetRecord);
    }

    if (json && Array.isArray(json.values)) {
      const rows = json.values.slice(1).map((row) => ({
        orderCode: row[0],
        amount: row[1],
        transferContent: row[2],
        status: row[3]
      }));
      return rows.map(normalizeGoogleSheetRecord);
    }

    const lines = text.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];

    const headers = lines[0].split(',').map((value) => value.replace(/^\s+|\s+$/g, ''));
    return lines.slice(1).map((line) => {
      const cells = line.split(',');
      const row = {};
      headers.forEach((header, index) => {
        row[header] = cells[index] || '';
      });
      return normalizeGoogleSheetRecord(row);
    });
  } catch (error) {
    console.warn('Google Sheet verification unavailable:', error.message);
    return [];
  }
}

async function findGoogleSheetMatch(orderCode, amount) {
  const sheetUrl = (process.env.GOOGLE_SHEET_URL || '').trim();
  if (!sheetUrl) return null;

  const rows = await readGoogleSheetTransactions();
  const targetCode = String(orderCode || '').trim();
  const targetAmount = Number(amount || 0);

  const exactMatch = rows.find((row) => {
    if (!row.orderCode || !targetCode) return false;
    return row.orderCode === targetCode || row.content.includes(targetCode) || row.orderCode.includes(targetCode);
  });

  if (exactMatch) {
    if (targetAmount && exactMatch.amount && Number(exactMatch.amount) !== 0 && Number(exactMatch.amount) !== targetAmount) {
      return { matched: false, reason: 'amount-mismatch', row: exactMatch };
    }
    return { matched: true, row: exactMatch };
  }

  const contentMatch = rows.find((row) => {
    const source = String(row.content || row.orderCode || '');
    return source.includes(targetCode);
  });

  if (contentMatch) {
    if (targetAmount && contentMatch.amount && Number(contentMatch.amount) !== 0 && Number(contentMatch.amount) !== targetAmount) {
      return { matched: false, reason: 'amount-mismatch', row: contentMatch };
    }
    return { matched: true, row: contentMatch };
  }

  return null;
}

async function confirmOrderPaid(orderCode) {
  const order = await findOrderPersistent(orderCode);
  if (!order) {
    return null;
  }

  if (order.status === 'Đã thanh toán') {
    return order;
  }

  const sheetMatch = await findGoogleSheetMatch(order.orderCode, Number(order.total || 0));
  if (process.env.GOOGLE_SHEET_URL && sheetMatch === null) {
    throw new Error('Không tìm thấy giao dịch tương ứng trong Google Sheet.');
  }

  if (sheetMatch && sheetMatch.matched === false) {
    throw new Error('Giao dịch trong Google Sheet không khớp với đơn hàng.');
  }

  order.status = 'Đã thanh toán';
  order.ticketStatus = 'Chưa sử dụng';
  order.paidAt = new Date().toISOString();
  order.qrCodeUrl = order.qrCodeUrl || createQrCodeUrl(order);

  await saveOrderPersistent(order);

  // Gửi webhook cập nhật tới Google Sheet
  const sheetWebhookUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL || 'https://script.google.com/macros/s/AKfycbxXPPdHXDNbRcmQPYsSoqn3MlzIOIDkvdXrTJvFrXk2ZchFkMBQb1fmLJaQzthe9Y1yzg/exec';
  try {
    await fetchWithTimeout(sheetWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    }, 5000);
  } catch (err) {
    console.error('Lỗi gửi cập nhật về Sheet:', err.message);
  }

  try {
    const emailResult = await sendResendEmail(order);
    order.emailSent = !emailResult.skipped;
    order.emailId = emailResult.id || null;
    delete order.emailError;
    await saveOrderPersistent(order);
  } catch (error) {
    order.emailSent = false;
    order.emailError = error.message;
    await saveOrderPersistent(order);
  }

  return order;
}

app.get('/api/admin/orders', async (req, res) => {
  const { status, search } = req.query;
  
  // Lấy danh sách local trước
  const localOrders = readOrders();
  let allOrders = [...localOrders];

  // Thử lấy thêm từ Supabase nếu có
  if (supabaseEnabled) {
    try {
      const remoteOrders = await readOrdersPersistent();
      allOrders = remoteOrders;
    } catch (e) {
      console.warn('Lỗi lấy từ Supabase:', e);
    }
  }

  // Thử lấy từ Google Sheet (qua doGet)
  const sheetWebhookUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL || 'https://script.google.com/macros/s/AKfycbxXPPdHXDNbRcmQPYsSoqn3MlzIOIDkvdXrTJvFrXk2ZchFkMBQb1fmLJaQzthe9Y1yzg/exec';
  try {
    const sheetRes = await fetchWithTimeout(sheetWebhookUrl, { method: 'GET' }, 8000);
    if (sheetRes.ok) {
      const sheetData = await sheetRes.json();
      if (Array.isArray(sheetData) && sheetData.length > 0) {
        // Gộp dữ liệu từ Sheet (ưu tiên Sheet)
        const sheetOrderMap = new Map();
        sheetData.forEach(o => {
          if (o.orderCode) sheetOrderMap.set(o.orderCode, o);
        });
        
        allOrders = await Promise.all(allOrders.map(async o => {
          if (sheetOrderMap.has(o.orderCode)) {
            const so = sheetOrderMap.get(o.orderCode);
            // Ghi đè trạng thái từ Sheet
            const newStatus = so.status || o.status;
            let oEmailSent = o.emailSent;
            let oEmailError = o.emailError;

            const sendEmailChecked = so.sendEmail === true || String(so.sendEmail).trim().toLowerCase() === 'true';

            if (sendEmailChecked && !oEmailSent && newStatus === 'Đã thanh toán') {
              try {
                // Tự động gửi mail khi check box trong sheet
                const emailResult = await sendResendEmail(o);
                oEmailSent = !emailResult.skipped;
                o.emailId = emailResult.id || null;
                oEmailError = null;

                const localO = await findOrderPersistent(o.orderCode);
                if (localO) {
                  localO.emailSent = oEmailSent;
                  localO.emailId = o.emailId;
                  delete localO.emailError;
                  await saveOrderPersistent(localO);
                }
              } catch (err) {
                oEmailError = err.message;
                const localO = await findOrderPersistent(o.orderCode);
                if (localO) {
                  localO.emailError = oEmailError;
                  await saveOrderPersistent(localO);
                }
              }
            }

            return { 
              ...o, 
              status: newStatus,
              emailSent: oEmailSent,
              emailError: oEmailError
            };
          }
          return o;
        }));

        // Thêm các đơn chỉ có trong Sheet
        const localCodes = new Set(allOrders.map(o => o.orderCode));
        sheetData.forEach(o => {
          if (o.orderCode && String(o.orderCode).trim() !== '' && !localCodes.has(o.orderCode)) {
            allOrders.push({
              id: o.orderCode,
              orderCode: o.orderCode,
              customer: o.customer || {},
              deliveryLocation: o.deliveryLocation || '',
              status: o.status || 'Chờ thanh toán',
              total: o.total || 0,
              createdAt: o.createdAt || new Date().toISOString(),
              items: [], // Chỉ để hiển thị admin
              itemsStr: o.itemsStr || ''
            });
          }
        });
        
        // Tự động đồng bộ các đơn có trong web nhưng chưa có trong Sheet
        const missingOrders = allOrders.filter(o => o.orderCode && !sheetOrderMap.has(o.orderCode));
        if (missingOrders.length > 0) {
          console.log(`Đang tự động đồng bộ ${missingOrders.length} đơn sang Sheet...`);
          // Chạy ngầm
          (async () => {
            for (const order of missingOrders) {
              try {
                const orderPayload = { ...order, sendEmail: order.emailSent ? false : order.sendEmail || false };
                await fetchWithTimeout(sheetWebhookUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(orderPayload)
                }, 5000);
                await new Promise(r => setTimeout(r, 400));
              } catch (e) {
                console.warn(`Lỗi auto-sync đơn ${order.orderCode}:`, e.message);
              }
            }
          })();
        }
      }
    }
  } catch (err) {
    console.warn('Không thể kéo dữ liệu từ Google Sheet:', err.message);
  }

  const filteredOrders = allOrders.filter((order) => {
    const matchesStatus = !status || status === 'all' || order.status === status;
    const text = `${order.orderCode} ${order.customer.name} ${order.customer.phone} ${order.deliveryLocation || ''}`.toLowerCase();
    const matchesSearch = !search || text.includes(String(search).toLowerCase());
    return matchesStatus && matchesSearch;
  });

  res.json({
    summary: getOrderSummary(allOrders),
    orders: filteredOrders
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((order) => ({
        ...order,
        deliveryLocation: order.deliveryLocation || 'Nhận tại sự kiện',
        proofImage: order.proofImage || null,
        proofUploadedAt: order.proofUploadedAt || null
      }))
  });
});

app.post('/api/admin/confirm-payment', async (req, res) => {
  const { orderCode } = req.body || {};
  if (!orderCode) {
    return res.status(400).json({ message: 'Thiếu mã đơn hàng.' });
  }

  try {
    const order = await confirmOrderPaid(String(orderCode));
    if (!order) {
      return res.status(404).json({ message: 'Không tìm thấy đơn hàng.' });
    }

    return res.status(200).json({
      message: 'Đã xác nhận thanh toán thủ công.',
      order
    });
  } catch (error) {
    return res.status(409).json({ message: error.message || 'Xác nhận thanh toán thất bại.' });
  }
});

app.post('/api/admin/clear-orders', async (req, res) => {
  writeOrders([]);
  if (supabaseEnabled) {
    try {
      await supabaseRequest('orders?order_code=neq.__NEVER__', { method: 'DELETE' });
    } catch (err) {
      console.warn('Supabase clear orders failed:', err.message);
    }
  }
  inventoryCacheTime = 0;
  return res.status(200).json({ success: true, message: 'Đã xóa toàn bộ đơn hàng thành công.' });
});

app.post('/api/admin/cleanup-orders', async (req, res) => {
  try {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    let orders = readOrders();
    const toDeleteCodes = [];
    
    orders = orders.filter(o => {
      const createdTime = new Date(o.createdAt || Date.now()).getTime();
      const isOld = createdTime < oneHourAgo;
      const hasNoImage = !o.proofImage;
      const isUnpaid = o.status !== 'Đã thanh toán';
      
      if (isOld && hasNoImage && isUnpaid) {
        toDeleteCodes.push(o.orderCode);
        return false;
      }
      return true;
    });
    
    writeOrders(orders);
    
    if (supabaseEnabled && toDeleteCodes.length > 0) {
      try {
        const codesList = toDeleteCodes.map(encodeURIComponent).join(',');
        await supabaseRequest(`orders?order_code=in.(${codesList})`, { method: 'DELETE' });
      } catch (err) {
        console.warn('Supabase cleanup orders failed:', err.message);
      }
    }
    
    if (toDeleteCodes.length > 0) {
      inventoryCacheTime = 0;
    }
    
    return res.status(200).json({ 
      success: true, 
      message: `Đã dọn dẹp thành công ${toDeleteCodes.length} đơn rác.`,
      deletedCount: toDeleteCodes.length
    });
  } catch (error) {
    return res.status(500).json({ message: 'Lỗi dọn dẹp đơn hàng: ' + error.message });
  }
});

app.delete('/api/admin/orders/:orderCode', async (req, res) => {
  const code = String(req.params.orderCode || '').trim();
  if (!code) {
    return res.status(400).json({ message: 'Thiếu mã đơn hàng.' });
  }

  const orders = readOrders();
  const index = orders.findIndex((o) => o.orderCode === code);
  if (index !== -1) {
    orders.splice(index, 1);
    writeOrders(orders);
  }

  if (supabaseEnabled) {
    try {
      await supabaseRequest(`orders?order_code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });
    } catch (err) {
      console.warn('Supabase delete order failed:', err.message);
    }
  }

  inventoryCacheTime = 0;
  return res.status(200).json({ success: true, message: `Đã xóa đơn hàng ${code}.` });
});

app.post('/api/admin/resend-email', async (req, res) => {
  const { orderCode } = req.body || {};
  if (!orderCode) {
    return res.status(400).json({ message: 'Thiếu mã đơn hàng.' });
  }

  const order = await findOrderPersistent(orderCode);
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

  const orderCodeFromPayload = transaction.orderCode ||
    transaction.description ||
    transaction.reference ||
    transaction.referenceCode ||
    transaction.order_id ||
    transaction.content ||
    transaction.transactionContent ||
    transaction.transferContent ||
    payload.orderCode ||
    payload.description ||
    payload.reference ||
    payload.referenceCode ||
    payload.content ||
    payload.transactionContent ||
    payload.transferContent;

  const rawAmount = transaction.amount ?? transaction.transferAmount ?? transaction.transfer_amount ?? transaction.transfer_amount_in ?? payload.amount ?? payload.transferAmount ?? payload.transfer_amount ?? 0;
  const amount = Number(rawAmount || 0);

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
    String(transaction.content || '').includes(entry.orderCode) ||
    String(payload.description || '').includes(entry.orderCode) ||
    String(payload.transactionContent || '').includes(entry.orderCode) ||
    String(payload.content || '').includes(entry.orderCode)
  ));

  if (!order) {
    return res.status(404).json({ message: 'Không tìm thấy đơn hàng tương ứng.' });
  }

  const paymentSucceeded = transaction.code === undefined ||
    transaction.code === '00' ||
    transaction.code === 0 ||
    transaction.transferType === 'in' ||
    payload.code === undefined ||
    payload.code === '00' ||
    payload.code === 0 ||
    payload.transferType === 'in';

  if (!paymentSucceeded) {
    return res.status(200).json({ message: 'Giao dịch chưa thành công.', order });
  }

  if (Number(order.total) !== 0 && Number(order.total) !== amount) {
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
        message: 'Thanh toán thành công. QR check-in đã sẵn sàng trên web để bạn lưu/in.',
        order
      });
    }

    return res.status(200).json({
      message: 'Thanh toán thành công. QR check-in đã sẵn sàng trên web và email xác nhận đã được gửi.',
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

// API Quản lý mặt hàng (Items)
app.get('/api/admin/items', async (req, res) => {
  const items = readItems();
  const soldQuantities = await getInventory();

  const updatedItems = items.map(item => {
    if (item.baseQuantity !== undefined) {
      const sold = soldQuantities[item.id] || 0;
      item.quantity = Math.max(0, item.baseQuantity - sold);
    }
    return item;
  });

  res.json(updatedItems);
});

app.post('/api/admin/items', (req, res) => {
  const newItem = req.body;
  if (!newItem || !newItem.id || !newItem.name) {
    return res.status(400).json({ error: 'Thiếu thông tin bắt buộc (id, name).' });
  }
  
  let items = readItems();
  const index = items.findIndex(i => i.id === newItem.id);
  
  if (index !== -1) {
    if (newItem.quantity !== undefined) {
      newItem.baseQuantity = newItem.quantity;
      delete newItem.quantity;
    }
    items[index] = { ...items[index], ...newItem };
  } else {
    if (newItem.quantity !== undefined) {
      newItem.baseQuantity = newItem.quantity;
      delete newItem.quantity;
    }
    items.push(newItem);
  }
  
  if (saveItems(items)) {
    res.json({ success: true, item: items[index !== -1 ? index : items.length - 1] });
  } else {
    res.status(500).json({ error: 'Không thể lưu mặt hàng.' });
  }
});

app.delete('/api/admin/items/:id', (req, res) => {
  const id = req.params.id;
  let items = readItems();
  const initialLength = items.length;
  items = items.filter(i => i.id !== id);
  
  if (items.length === initialLength) {
    return res.status(404).json({ error: 'Không tìm thấy mặt hàng.' });
  }
  
  if (saveItems(items)) {
    res.json({ success: true, message: 'Đã xóa mặt hàng.' });
  } else {
    res.status(500).json({ error: 'Lỗi khi lưu dữ liệu.' });
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
