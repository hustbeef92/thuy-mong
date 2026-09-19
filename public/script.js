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
    paymentInfoEl.innerHTML = `
      <h4>Đã thanh toán thành công</h4>
      <p class="payment-success">Hệ thống đã nhận được khoản chuyển khoản của bạn.</p>
      ${order.qrCodeUrl ? `<img class="payment-qr checkin-qr" src="${order.qrCodeUrl}" alt="QR check-in đơn ${order.orderCode}" />` : ''}
      <p><strong>Mã đơn hàng:</strong> ${order.orderCode}</p>
      <p><strong>Trạng thái vé:</strong> ${order.ticketStatus}</p>
      <p>${order.emailSent ? 'QR check-in đã được gửi tới email của bạn.' : 'Email đang được xử lý, vui lòng kiểm tra lại sau ít phút.'}</p>
    `;
  }
}

function startPaymentStatusPolling(orderCode, email) {
  clearInterval(appState.paymentPollTimer);
  const checkStatus = async () => {
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderCode)}/status?email=${encodeURIComponent(email)}`);
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
        <div class="ticket-top">
          <h3>${ticket.name}</h3>
          <span class="ticket-price">${formatCurrency(ticket.price)}</span>
        </div>
        <p>${ticket.benefit}</p>
        <ul class="benefits-list">
          <li>Đảm bảo quyền lợi theo hạng vé</li>
          <li>Trải nghiệm nghệ thuật tối ưu</li>
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
        <div class="merch-art" aria-hidden="true">${item.id === 'shirt' ? 'ÁO' : item.id === 'bag' ? 'TÚI' : item.id === 'fan' ? 'QUẠT' : 'RỐI'}</div>
        <div class="ticket-top">
          <h3>${item.name}</h3>
          <span class="ticket-price">${formatCurrency(item.price)}</span>
        </div>
        <p>${item.id === 'shirt' ? 'Áo cotton in họa tiết chú Tễu và sóng nước, mực vàng kim.' : item.id === 'bag' ? 'Túi canvas dày dặn in họa tiết thủy đình dưới trăng.' : item.id === 'fan' ? 'Quạt giấy vẽ tay phong cách tranh Đông Hồ, nan tre.' : 'Móc khóa hình con rối nước, hoàn thiện sơn mài.'}</p>
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

function renderCart() {
  const cartItemsEl = document.getElementById('cart-items');
  const totalEl = document.getElementById('total-price');

  if (!appState.cart.length) {
    cartItemsEl.innerHTML = '<div class="empty-state">Giỏ hàng hiện đang trống. Hãy chọn vé hoặc merch để bắt đầu.</div>';
    totalEl.textContent = '0 VNĐ';
    updateCartButton();
    return;
  }

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

  const total = appState.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  totalEl.textContent = `${formatCurrency(total)}`;
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
      { id: 'pt', name: 'Vé Phổ Thông', price: 100000, benefit: 'Ghế khu vực tầng chính, tầm nhìn tiêu chuẩn, thưởng thức trọn vẹn suất diễn múa rối nước.' },
      { id: 'tc', name: 'Vé Tiêu Chuẩn', price: 130000, benefit: 'Ghế vị trí trung tâm rõ hơn, tặng kèm 01 quạt giấy lưu niệm thiết kế độc quyền sự kiện.' },
      { id: 'cc', name: 'Vé Cao Cấp', price: 160000, benefit: 'Ghế cận sân khấu view đẹp, tặng kèm 01 túi vải canvas "Thủy Mộng" và móc khóa nghệ thuật.' },
      { id: 'vip', name: 'Vé VIP', price: 200000, benefit: 'Ghế hàng đầu sát mặt nước, đặc quyền check-in lối đi riêng, nhận trọn bộ quà tặng và thư cảm ơn độc quyền.' }
    ];

    appState.merch = [
      { id: 'shirt', name: 'Áo thun Thủy Mộng', price: 240000 },
      { id: 'bag', name: 'Túi vải canvas Thủy Mộng', price: 180000 },
      { id: 'keychain', name: 'Móc khóa nghệ thuật', price: 65000 },
      { id: 'fan', name: 'Quạt giấy lưu niệm', price: 50000 }
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
checkoutForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!appState.cart.length) {
    showToast('Giỏ hàng đang trống. Vui lòng chọn ít nhất 1 mặt hàng.');
    return;
  }

  const formData = new FormData(checkoutForm);
  const payload = {
    customer: {
      name: formData.get('name'),
      phone: formData.get('phone'),
      email: formData.get('email')
    },
    paymentMethod: 'BANK',
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
        <p class="payment-note">Sau khi chuyển khoản thành công, hệ thống sẽ xác nhận và gửi QR check-in vào email của bạn.</p>
      `;
    }
    startPaymentStatusPolling(result.order.orderCode, result.order.customer.email);
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
