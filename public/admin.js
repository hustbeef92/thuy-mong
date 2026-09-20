const statusFilter = document.getElementById('statusFilter');
const searchInput = document.getElementById('searchInput');
const ordersTableBody = document.getElementById('ordersTableBody');
const totalRevenueEl = document.getElementById('totalRevenue');
const totalOrdersEl = document.getElementById('totalOrders');
const paidOrdersEl = document.getElementById('paidOrders');
const usedTicketsEl = document.getElementById('usedTickets');

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const scanResultEl = document.getElementById('scanResult');
const startScannerBtn = document.getElementById('startScannerBtn');
const stopScannerBtn = document.getElementById('stopScannerBtn');
const manualCheckinForm = document.getElementById('manualCheckinForm');
const manualQrCodeInput = document.getElementById('manualQrCode');

const formatCurrency = (value) => new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0
}).format(Number(value || 0));

function formatScanInfo(order = {}) {
  const customer = order.customer || {};
  const items = Array.isArray(order.items) && order.items.length
    ? order.items.map((item) => `${item.name} x${item.quantity}`).join(', ')
    : '—';

  return `
    <div class="scan-info-wrap">
      <div><strong>Mã đơn:</strong> ${order.orderCode || '—'}</div>
      <div><strong>Khách:</strong> ${customer.name || '—'}</div>
      <div><strong>SĐT:</strong> ${customer.phone || '—'}</div>
      <div><strong>Email:</strong> ${customer.email || '—'}</div>
      <div><strong>Nơi nhận:</strong> ${order.deliveryLocation || 'Nhận tại sự kiện'}</div>
      <div><strong>Vé:</strong> ${items}</div>
      <div><strong>Trạng thái:</strong> ${order.ticketStatus || 'Chưa sử dụng'}</div>
    </div>
  `;
}

async function loadOrders() {
  try {
    const status = statusFilter.value;
    const search = searchInput.value.trim();
    const params = new URLSearchParams();
    if (status && status !== 'all') params.set('status', status);
    if (search) params.set('search', search);

    const response = await fetch(`/api/admin/orders?${params.toString()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Admin API ${response.status}`);
    const data = await response.json();

  const summary = data.summary || {};
  totalRevenueEl.textContent = formatCurrency(summary.totalRevenue || 0);
  totalOrdersEl.textContent = summary.totalOrders || 0;
  paidOrdersEl.textContent = summary.paidOrders || 0;
  usedTicketsEl.textContent = summary.usedTickets || 0;

    ordersTableBody.innerHTML = (data.orders || [])
    .map((order) => {
      const customerName = order.customer?.name || 'Khách hàng';
      const phone = order.customer?.phone || '—';
      const deliveryLocation = order.deliveryLocation || 'Nhận tại sự kiện';
      const isNeu = deliveryLocation.toLowerCase().includes('neu');
      const deliveryBadgeClass = isNeu ? 'neu' : 'event';
      const itemsText = (order.items || []).map((item) => `${item.name} x${item.quantity}`).join(', ');
      const statusClass = order.status === 'Đã thanh toán' ? 'paid' : 'pending';
      const ticketClass = order.ticketStatus === 'Đã sử dụng' ? 'used' : 'pending';
      const confirmButton = order.status !== 'Đã thanh toán'
        ? `<button type="button" class="btn btn-small confirm-payment" data-order-code="${order.orderCode}">Xác nhận</button>`
        : '';
      const rawProofUrl = typeof order.proofImage === 'string' ? order.proofImage.trim() : '';
      const isSafeProofUrl = rawProofUrl.startsWith('data:image/') || /^https?:\/\//i.test(rawProofUrl);
      const proofImage = isSafeProofUrl
        ? `<a class="proof-link" href="${encodeURI(rawProofUrl)}" target="_blank" rel="noopener noreferrer">Mở ảnh</a>`
        : '<span>—</span>';

      return `
        <tr>
          <td>${order.orderCode}</td>
          <td>${customerName}</td>
          <td>${phone}</td>
          <td><span class="delivery-badge ${deliveryBadgeClass}">${deliveryLocation}</span></td>
          <td>${itemsText || '—'}</td>
          <td>${formatCurrency(order.total || 0)}</td>
          <td>${proofImage}</td>
          <td><span class="badge ${statusClass}">${order.status}</span></td>
          <td>
            <span class="badge ${ticketClass}">${order.ticketStatus || 'Chưa sử dụng'}</span>
            ${confirmButton}
          </td>
        </tr>
      `;
    })
      .join('') || '<tr><td colspan="9">Không có dữ liệu phù hợp.</td></tr>';
  } catch (error) {
    console.error('Unable to refresh orders:', error);
  }
}

statusFilter.addEventListener('change', loadOrders);
searchInput.addEventListener('input', loadOrders);

async function startScanner() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    await video.play();
    scanResultEl.className = 'scan-result neutral';
    scanResultEl.textContent = 'Camera đã mở. Hãy quét mã QR vé của khách.';
    captureLoop();
  } catch (error) {
    scanResultEl.className = 'scan-result error';
    scanResultEl.textContent = 'Không thể truy cập camera. Vui lòng cấp quyền truy cập camera.';
  }
}

async function captureLoop() {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const scan = async () => {
    if (video.readyState >= 2) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = await decodeFromCanvas(imageData, canvas.width, canvas.height);
      if (code) {
        await submitCheckin(code);
        return;
      }
    }

    requestAnimationFrame(scan);
  };

  requestAnimationFrame(scan);
}

async function decodeFromCanvas(imageData, width, height) {
  try {
    const { BrowserQRCodeReader } = await import('https://cdn.jsdelivr.net/npm/@zxing/browser@latest/esm/index.js');
    const reader = new BrowserQRCodeReader();
    const result = await reader.decodeFromImageBitmap(createImageBitmap(new ImageData(imageData.data, width, height)));
    return result?.getText?.() || null;
  } catch (error) {
    return null;
  }
}

async function submitCheckin(qrCode) {
  try {
    const response = await fetch('/api/admin/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qrCode })
    });
    const result = await response.json();

    if (response.ok) {
      scanResultEl.className = 'scan-result success';
      scanResultEl.innerHTML = `
        <div><strong>Check-in thành công</strong></div>
        ${formatScanInfo(result.order)}
      `;
      await loadOrders();
    } else {
      scanResultEl.className = 'scan-result error';
      const detailHtml = result.order ? formatScanInfo(result.order) : '';
      scanResultEl.innerHTML = `
        <div>${result.message || 'Quét thất bại.'}</div>
        ${detailHtml}
      `;
    }

    setTimeout(() => {
      scanResultEl.className = 'scan-result neutral';
      scanResultEl.innerHTML = 'Camera đang chờ quét QR tiếp theo...';
    }, 3000);
  } catch (error) {
    scanResultEl.className = 'scan-result error';
    scanResultEl.textContent = 'Lỗi khi gửi dữ liệu check-in.';
  }
}

async function confirmPendingPayment(orderCode) {
  try {
    const response = await fetch('/api/admin/confirm-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderCode })
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Xác nhận thanh toán thất bại.');
    }

    scanResultEl.className = 'scan-result success';
    scanResultEl.textContent = `Đã xác nhận thanh toán cho ${result.order.orderCode}.`;
    await loadOrders();
  } catch (error) {
    scanResultEl.className = 'scan-result error';
    scanResultEl.textContent = error.message || 'Lỗi xác nhận thanh toán.';
  }
}

ordersTableBody.addEventListener('click', async (event) => {
  const button = event.target.closest('.confirm-payment');
  if (!button) return;
  const orderCode = button.dataset.orderCode;
  if (!orderCode) return;
  await confirmPendingPayment(orderCode);
});

function stopScanner() {
  if (video.srcObject) {
    const tracks = video.srcObject.getTracks();
    tracks.forEach((track) => track.stop());
    video.srcObject = null;
  }
  scanResultEl.className = 'scan-result neutral';
  scanResultEl.textContent = 'Camera đã dừng.';
}

startScannerBtn.addEventListener('click', startScanner);
stopScannerBtn.addEventListener('click', stopScanner);

manualCheckinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const qrCode = manualQrCodeInput.value.trim();
  if (!qrCode) {
    scanResultEl.className = 'scan-result error';
    scanResultEl.textContent = 'Vui lòng nhập mã QR cần check-in.';
    return;
  }

  await submitCheckin(qrCode);
  manualQrCodeInput.value = '';
});

loadOrders();
setInterval(loadOrders, 5000);
