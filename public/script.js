const appState = {
  tickets: [],
  merch: [],
  cart: [],
  paymentPollTimer: null
};

const formatCurrency = (value) => new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0
}).format(value);

const toast = document.getElementById('toast');

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function addItemToCart(item, quantity = 1) {
  const existing = appState.cart.find((entry) => entry.id === item.id && entry.type === item.type);

  if (existing) {
    existing.quantity += quantity;
  } else {
    appState.cart.push({ ...item, quantity });
  }

  renderCart();
  updateCartButton();
  showToast(`${item.name} đã được thêm vào giỏ hàng.`);
}

function updateCartButton() {
  const navBookButton = document.getElementById('nav-book-button');
  if (!navBookButton) return;
  const itemCount = appState.cart.reduce((sum, item) => sum + item.quantity, 0);
  navBookButton.textContent = `Giỏ hàng: ${itemCount}`;
}

function removeCartItem(id, type) {
  appState.cart = appState.cart.filter((item) => !(item.id === id && item.type === type));
  renderCart();
  updateCartButton();
}

function changeCartQuantity(id, type, delta) {
  const item = appState.cart.find((entry) => entry.id === id && entry.type === type);
  if (!item) return;
  item.quantity = Math.max(1, item.quantity + delta);
  renderCart();
  updateCartButton();
}

function renderPaidOrderStatus(order) {
  const paymentInfoEl = document.getElementById('payment-account-info');
  if (!paymentInfoEl) return;

  if (order.status === 'Đã thanh toán') {
    const qrMarkup = order.qrCodeUrl
      ? `<img class="payment-qr checkin-qr" src="${order.qrCodeUrl}" alt="QR check-in đơn ${order.orderCode}" />`
      : '';

    paymentInfoEl.innerHTML = `
      <div class="payment-success-box">
        <h4>Đã thanh toán thành công</h4>
        <p class="payment-success">Hệ thống đã nhận được khoản chuyển khoản của bạn.</p>
        ${qrMarkup}
        <p><strong>Mã đơn hàng:</strong> ${order.orderCode}</p>
        <p><strong>Nơi nhận hàng:</strong> ${order.deliveryLocation || 'Nhận tại sự kiện'}</p>
        <p><strong>Trạng thái vé:</strong> ${order.ticketStatus || 'Chưa sử dụng'}</p>
        <p>QR check-in đã hiển thị trực tiếp trên màn hình. Bạn có thể in hoặc lưu lại để dùng khi vào sự kiện.</p>
        ${order.qrCodeUrl ? '<button type="button" class="btn btn-primary full-width" id="print-checkin-qr">In QR check-in</button>' : ''}
      </div>
    `;

    const printButton = document.getElementById('print-checkin-qr');
    if (printButton) {
      printButton.addEventListener('click', () => window.print());
    }
  }
}

function startPaymentStatusPolling(orderCode, email) {
  clearInterval(appState.paymentPollTimer);
  const query = email ? `?email=${encodeURIComponent(email)}` : '';

  const checkStatus = async () => {
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderCode)}/status${query}`);
      if (!response.ok) return;
      const result = await response.json();
      renderPaidOrderStatus(result.order);
      if (result.order.status === 'Đã thanh toán') {
        clearInterval(appState.paymentPollTimer);
        showToast('Đã nhận thanh toán và cập nhật trạng thái đơn hàng.');
      }
    } catch (error) {
      console.warn('Unable to refresh payment status:', error);
    }
  };

  checkStatus();
  appState.paymentPollTimer = setInterval(checkStatus, 5000);
}

function renderTickets() {
  const container = document.getElementById('ticket-grid');
  container.innerHTML = appState.tickets
    .map((ticket) => `
      <article class="ticket-card">
        <img src="${ticket.id}.jpg" alt="${ticket.name}" class="ticket-card-img" />
        <div class="ticket-top">
          <h3>${ticket.name} (${formatCurrency(ticket.price)})</h3>
          <span class="ticket-price">${formatCurrency(ticket.price)}</span>
        </div>
        <p>${ticket.benefit}</p>
        <ul class="benefits-list">
          <li>Nhận quyền lợi theo hạng vé</li>
          <li>Đăng ký từ 4 ấn phẩm trở lên được giảm 10%</li>
        </ul>
        <div class="choose-row">
          <div class="qty-control">
            <button type="button" class="qty-btn" data-action="decrease" data-id="${ticket.id}" data-type="ticket">−</button>
            <span data-qty="${ticket.id}">1</span>
            <button type="button" class="qty-btn" data-action="increase" data-id="${ticket.id}" data-type="ticket">+</button>
          </div>
          <button class="add-to-cart" data-add="${ticket.id}" data-type="ticket">Thêm</button>
        </div>
      </article>
    `)
    .join('');

  bindQuantityButtons(container);
  bindAddButtons(container);
}

function renderMerch() {
  const container = document.getElementById('merch-grid');
  container.innerHTML = appState.merch
    .map((item) => `
      <article class="merch-card">
        <div class="merch-art" aria-hidden="true">${item.id === 'combo-merch' ? 'COMBO' : 'KHĂN'}</div>
        <div class="ticket-top">
          <h3>${item.name} (${formatCurrency(item.price)})</h3>
          <span class="ticket-price">${formatCurrency(item.price)}</span>
        </div>
        <p>${item.id === 'combo-merch' ? 'Combo merch gồm quạt, móc khóa, sticker.' : 'Khăn độc quyền sự kiện, có thể áp dụng ưu đãi giảm giá theo hạng vé mua.'}</p>
        <div class="choose-row">
          <div class="qty-control">
            <button type="button" class="qty-btn" data-action="decrease" data-id="${item.id}" data-type="merch">−</button>
            <span data-qty="${item.id}">1</span>
            <button type="button" class="qty-btn" data-action="increase" data-id="${item.id}" data-type="merch">+</button>
          </div>
          <button class="add-to-cart" data-add="${item.id}" data-type="merch">Thêm</button>
        </div>
      </article>
    `)
    .join('');

  bindQuantityButtons(container);
  bindAddButtons(container);
}

function updateQtyValue(id, type, delta) {
  const qtyEl = document.querySelector(`[data-qty="${id}"]`);
  if (!qtyEl) return;

  const current = Number(qtyEl.textContent) || 1;
  const next = Math.max(1, current + delta);
  qtyEl.textContent = next;

  const addButton = document.querySelector(`[data-add="${id}"][data-type="${type}"]`);
  if (addButton) {
    addButton.dataset.qty = next;
  }
}

function bindQuantityButtons(container) {
  container.querySelectorAll('.qty-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const { action, id, type } = button.dataset;
      const qtyEl = document.querySelector(`[data-qty="${id}"]`);
      if (!qtyEl) return;

      const current = Number(qtyEl.textContent) || 1;
      const next = action === 'increase' ? current + 1 : Math.max(1, current - 1);
      qtyEl.textContent = next;
      const addButton = document.querySelector(`[data-add="${id}"][data-type="${type}"]`);
      if (addButton) addButton.dataset.qty = next;
    });
  });
}

function bindAddButtons(container) {
  container.querySelectorAll('[data-add]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.add;
      const type = button.dataset.type;
      const quantity = Number(button.dataset.qty || document.querySelector(`[data-qty="${id}"]`)?.textContent || 1);

      const source = type === 'ticket' ? appState.tickets : appState.merch;
      const item = source.find((entry) => entry.id === id);
      if (!item) return;

      addItemToCart({ ...item, type }, quantity);
    });
  });
}

function calculateCartDiscountSummary(items = []) {
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
  const discounts = [];

  if (ticketCount >= 4) {
    const ticketSubtotal = ticketItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const discountAmount = ticketSubtotal * 0.1;
    discounts.push({
      label: 'Giảm 10% cho ấn phẩm tham dự sự kiện (từ 4 vé trở lên)',
      amount: discountAmount
    });
    subtotal -= discountAmount;
  }

  if ((hasValueTicket || hasTuLinh) && khanItem) {
    const rate = hasTuLinh ? 0.15 : 0.05;
    const discountAmount = khanItem.price * khanItem.quantity * rate;
    discounts.push({
      label: hasTuLinh ? 'Giảm 15% khi mua khăn độc quyền cho Tứ Linh' : 'Giảm 5% khi mua khăn độc quyền',
      amount: discountAmount
    });
    subtotal -= discountAmount;
  }

  if (hasTuLinh && comboItem) {
    const discountAmount = comboItem.price * comboItem.quantity;
    discounts.push({
      label: 'Tặng 01 combo merch khi mua Tứ Linh',
      amount: discountAmount
    });
    subtotal -= discountAmount;
  }

  return {
    subtotal: Math.max(0, subtotal + (discounts.reduce((sum, item) => sum + item.amount, 0))),
    discountTotal: discounts.reduce((sum, item) => sum + item.amount, 0),
    total: Math.max(0, subtotal),
    discounts
  };
}

function renderCart() {
  const cartItemsEl = document.getElementById('cart-items');
  const totalEl = document.getElementById('total-price');

  if (!appState.cart.length) {
    cartItemsEl.innerHTML = '<div class="empty-state">Giỏ hàng hiện đang trống. Hãy chọn vé hoặc merch để bắt đầu.</div>';
    totalEl.textContent = '0 VNĐ';
    updateCartButton();
    return;
  }

  const summary = calculateCartDiscountSummary(appState.cart);

  cartItemsEl.innerHTML = appState.cart
    .map((item) => `
      <div class="cart-item">
        <div class="cart-item-info">
          <strong>${item.name}</strong>
          <span>${item.quantity} x ${formatCurrency(item.price)}</span>
        </div>
        <div class="cart-item-actions">
          <button type="button" class="cart-qty-btn" data-cart-action="decrease" data-id="${item.id}" data-type="${item.type}">−</button>
          <button type="button" class="cart-qty-btn" data-cart-action="increase" data-id="${item.id}" data-type="${item.type}">+</button>
          <strong>${formatCurrency(item.price * item.quantity)}</strong>
          <button type="button" class="cart-remove" data-cart-action="remove" data-id="${item.id}" data-type="${item.type}">Xóa</button>
        </div>
      </div>
    `)
    .join('');

  const discountMarkup = summary.discounts.length
    ? `
      <div class="discount-summary">
        <div class="discount-row"><span>Giá gốc</span><strong>${formatCurrency(summary.subtotal)}</strong></div>
        ${summary.discounts.map((discount) => `
          <div class="discount-row discount-line"><span>${discount.label}</span><strong>- ${formatCurrency(discount.amount)}</strong></div>
        `).join('')}
        <div class="discount-row total-line"><span>Tổng thanh toán</span><strong>${formatCurrency(summary.total)}</strong></div>
      </div>
    `
    : '';

  cartItemsEl.insertAdjacentHTML('beforeend', discountMarkup);
  totalEl.textContent = formatCurrency(summary.total);
  totalEl.title = summary.discounts.map((discount) => `${discount.label}: -${formatCurrency(discount.amount)}`).join(' | ') || 'Không có ưu đãi';
  updateCartButton();
  document.querySelectorAll('[data-cart-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const { cartAction, id, type } = button.dataset;
      if (cartAction === 'remove') removeCartItem(id, type);
      if (cartAction === 'increase') changeCartQuantity(id, type, 1);
      if (cartAction === 'decrease') changeCartQuantity(id, type, -1);
    });
  });
}

async function loadData() {
  try {
    const response = await fetch('/api/config');
    const data = await response.json();

    appState.tickets = data.tickets;
    appState.merch = data.merch;

    const footerList = document.querySelectorAll('.site-footer li');
    if (data.contact && footerList.length >= 4) {
      footerList[0].textContent = data.contact.unit;
      footerList[1].textContent = data.contact.address;
      footerList[2].textContent = data.contact.phone;
      footerList[3].textContent = data.contact.email;
    }

    renderTickets();
    renderMerch();
    renderCart();
  } catch (error) {
    console.error('Failed to load data:', error);

    appState.tickets = [
      { id: 'pt', name: 'Vé Phổ Thông', price: 1000, benefit: 'Ghế khu vực tầng chính, tầm nhìn tiêu chuẩn, thưởng thức trọn vẹn suất diễn múa rối nước.' },
      { id: 'tc', name: 'Vé Tiêu Chuẩn', price: 1000, benefit: 'Ghế vị trí trung tâm rõ hơn, tặng kèm 01 quạt giấy lưu niệm thiết kế độc quyền sự kiện.' },
      { id: 'cc', name: 'Vé Cao Cấp', price: 1000, benefit: 'Ghế cận sân khấu view đẹp, tặng kèm 01 túi vải canvas "Thủy Mộng" và móc khóa nghệ thuật.' },
      { id: 'vip', name: 'Vé VIP', price: 1000, benefit: 'Ghế hàng đầu sát mặt nước, đặc quyền check-in lối đi riêng, nhận trọn bộ quà tặng và thư cảm ơn độc quyền.' }
    ];

    appState.merch = [
      { id: 'shirt', name: 'Áo thun Thủy Mộng', price: 1000 },
      { id: 'bag', name: 'Túi vải canvas Thủy Mộng', price: 1000 },
      { id: 'keychain', name: 'Móc khóa nghệ thuật', price: 1000 },
      { id: 'fan', name: 'Quạt giấy lưu niệm', price: 1000 }
    ];

    renderTickets();
    renderMerch();
    renderCart();
  }
}

const scrollButtons = document.querySelectorAll('[data-scroll]');
scrollButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const target = document.querySelector(button.dataset.scroll);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

const checkoutForm = document.getElementById('checkout-form');
const paymentProofInput = document.getElementById('payment-proof-input');

async function readPaymentProofAsDataUrl(file) {
  if (!file) return '';

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement('canvas');
          const maxWidth = 1200;
          const maxHeight = 1200;
          let { width, height } = image;

          if (width > maxWidth || height > maxHeight) {
            const scale = Math.min(maxWidth / width, maxHeight / height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }

          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(image, 0, 0, width, height);

          const compressed = canvas.toDataURL('image/jpeg', 0.72);
          resolve(String(compressed || ''));
        };
        image.onerror = () => reject(new Error('Không đọc được ảnh chuyển khoản.'));
        image.src = String(reader.result || '');
      } catch (error) {
        reject(new Error('Không đọc được ảnh chuyển khoản.'));
      }
    };
    reader.onerror = () => reject(new Error('Không đọc được ảnh chuyển khoản.'));
    reader.readAsDataURL(file);
  });
}

checkoutForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!appState.cart.length) {
    showToast('Giỏ hàng đang trống. Vui lòng chọn ít nhất 1 mặt hàng.');
    return;
  }

  const formData = new FormData(checkoutForm);
  let proofImage = '';

  try {
    if (paymentProofInput && paymentProofInput.files && paymentProofInput.files[0]) {
      proofImage = await readPaymentProofAsDataUrl(paymentProofInput.files[0]);
    }
  } catch (error) {
    showToast(error.message || 'Không thể đọc ảnh thanh toán.');
    return;
  }

  const payload = {
    customer: {
      name: formData.get('name'),
      phone: formData.get('phone'),
      email: formData.get('email') || ''
    },
    deliveryLocation: formData.get('deliveryLocation') || 'Nhận tại sự kiện',
    paymentMethod: 'BANK',
    proofImage,
    cart: {
      items: appState.cart.map((item) => ({
        id: item.id,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
        type: item.type
      }))
    }
  };

  try {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Xử lý đặt vé thất bại');
    }

    const payment = result.payment;
    const paymentInfoEl = document.getElementById('payment-account-info');
    if (paymentInfoEl && payment) {
      paymentInfoEl.innerHTML = `
        <h4>Quét QR để thanh toán</h4>
        <img class="payment-qr" src="${payment.paymentQrUrl}" alt="QR thanh toán đơn ${result.order.orderCode}" />
        <p><strong>Số tiền:</strong> ${formatCurrency(result.order.total)}</p>
        <p><strong>Nội dung chuyển khoản:</strong> ${payment.transferContent}</p>
        <p><strong>Ngân hàng:</strong> ${payment.bankName} · <strong>STK:</strong> ${payment.accountNumber}</p>
        <p class="payment-note">Sau khi chuyển khoản thành công, hệ thống sẽ tự động xác nhận thanh toán và hiển thị QR check-in ngay trên màn hình cho bạn.</p>
        <div class="proof-upload-box" style="margin-top: 18px; padding: 14px; border: 1px dashed var(--line); border-radius: 12px; background: rgba(255,255,255,0.03);">
          <p style="margin: 0 0 8px; font-weight: 600;">Đã chuyển khoản xong? Tải ảnh biên lai/màn hình tại đây hoặc xác nhận:</p>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
            <input type="file" id="post-payment-proof" accept="image/*" style="font-size: 0.85rem;" />
            <button type="button" class="btn btn-outline" id="btn-upload-proof" style="padding: 6px 14px; font-size: 0.85rem;">Gửi ảnh biên lai</button>
            <button type="button" class="btn btn-primary" id="btn-confirm-payment" style="padding: 6px 14px; font-size: 0.85rem;">Xác nhận đã thanh toán</button>
          </div>
          <div id="proof-status-msg" style="margin-top: 8px; font-size: 0.85rem;"></div>
        </div>
      `;

      const postPaymentInput = document.getElementById('post-payment-proof');
      const btnUploadProof = document.getElementById('btn-upload-proof');
      const proofStatusMsg = document.getElementById('proof-status-msg');

      if (btnUploadProof && postPaymentInput) {
        btnUploadProof.addEventListener('click', async () => {
          if (!postPaymentInput.files || !postPaymentInput.files[0]) {
            showToast('Vui lòng chọn ảnh chụp biên lai/màn hình.');
            return;
          }
          try {
            btnUploadProof.disabled = true;
            btnUploadProof.textContent = 'Đang tải lên...';
            proofStatusMsg.textContent = 'Đang xử lý và gửi ảnh...';
            proofStatusMsg.style.color = 'var(--gold)';
            const proofData = await readPaymentProofAsDataUrl(postPaymentInput.files[0]);
            const uploadRes = await fetch(`/api/orders/${result.order.orderCode}/proof`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ proofImage: proofData })
            });
            const uploadJson = await uploadRes.json();
            if (!uploadRes.ok) throw new Error(uploadJson.message || 'Tải ảnh thất bại');
            proofStatusMsg.textContent = '✓ Đã tải ảnh biên lai thành công! Admin sẽ kiểm tra và xác nhận.';
            proofStatusMsg.style.color = '#2da76d';
            showToast('Đã tải ảnh biên lai thành công!');
          } catch (err) {
            proofStatusMsg.textContent = 'Lỗi: ' + (err.message || 'Không thể tải ảnh');
            proofStatusMsg.style.color = '#e74c3c';
            showToast(err.message || 'Tải ảnh thất bại');
          } finally {
            btnUploadProof.disabled = false;
            btnUploadProof.textContent = 'Gửi ảnh biên lai';
          }
        });
      }

      const btnConfirmPayment = document.getElementById('btn-confirm-payment');
      if (btnConfirmPayment) {
        btnConfirmPayment.addEventListener('click', async () => {
          try {
            btnConfirmPayment.disabled = true;
            btnConfirmPayment.textContent = 'Đang xác nhận...';
            proofStatusMsg.textContent = 'Đang gửi thông báo xác nhận...';
            proofStatusMsg.style.color = 'var(--gold)';
            
            const confirmRes = await fetch(`/api/orders/${result.order.orderCode}/confirm`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
            
            const confirmJson = await confirmRes.json();
            if (!confirmRes.ok) throw new Error(confirmJson.message || 'Xác nhận thất bại');
            
            proofStatusMsg.textContent = '✓ Bạn đã báo Đã thanh toán! Ban tổ chức sẽ kiểm tra và xác nhận sớm.';
            proofStatusMsg.style.color = '#2da76d';
            showToast('Đã gửi xác nhận thanh toán!');
          } catch (err) {
            proofStatusMsg.textContent = 'Lỗi: ' + (err.message || 'Không thể xác nhận');
            proofStatusMsg.style.color = '#e74c3c';
            showToast(err.message || 'Xác nhận thất bại');
          } finally {
            btnConfirmPayment.disabled = false;
            btnConfirmPayment.textContent = 'Xác nhận đã thanh toán';
          }
        });
      }
    }
    startPaymentStatusPolling(result.order.orderCode, result.order.customer.email || '');
    showToast('Đơn hàng đã tạo. Vui lòng quét QR để thanh toán.');
    appState.cart = [];
    renderCart();
    updateCartButton();
    document.getElementById('checkout').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    showToast(error.message || 'Có lỗi xảy ra khi đặt vé.');
  }
});

const navBookButton = document.getElementById('nav-book-button');
if (navBookButton) {
  navBookButton.addEventListener('click', () => {
    document.getElementById('tickets').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

loadData();
