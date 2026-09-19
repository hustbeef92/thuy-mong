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
      const itemsText = (order.items || []).map((item) => `${item.name} x${item.quantity}`).join(', ');
      const statusClass = order.status === 'Đã thanh toán' ? 'paid' : 'pending';
      const ticketClass = order.ticketStatus === 'Đã sử dụng' ? 'used' : 'pending';
      return `
        <tr>
          <td>${order.orderCode}</td>
          <td>${customerName}</td>
          <td>${phone}</td>
          <td>${itemsText || '—'}</td>
          <td>${formatCurrency(order.total || 0)}</td>
          <td><span class="badge ${statusClass}">${order.status}</span></td>
          <td><span class="badge ${ticketClass}">${order.ticketStatus || 'Chưa sử dụng'}</span></td>
        </tr>
      `;
    })
      .join('') || '<tr><td colspan="7">Không có dữ liệu phù hợp.</td></tr>';
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
      scanResultEl.textContent = `Check-in thành công! Khách: ${result.order.customer.name} | Vé: ${result.order.items.map((item) => `${item.name} x${item.quantity}`).join(', ')}`;
      await loadOrders();
    } else {
      scanResultEl.className = 'scan-result error';
      scanResultEl.textContent = result.message || 'Quét thất bại.';
    }

    setTimeout(() => {
      scanResultEl.className = 'scan-result neutral';
      scanResultEl.textContent = 'Camera đang chờ quét QR tiếp theo...';
    }, 3000);
  } catch (error) {
    scanResultEl.className = 'scan-result error';
    scanResultEl.textContent = 'Lỗi khi gửi dữ liệu check-in.';
  }
}

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
