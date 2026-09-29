(() => {
  const $ = (selector) => document.querySelector(selector);
  const money = (amount) => `৳${Number(amount || 0).toLocaleString("en-US")}`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const idempotencyKey = crypto.randomUUID();
  let cart = null;

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const payload = await response.json();
    if (!response.ok) { const error = new Error(payload.error || "The request could not be completed."); error.status = response.status; throw error; }
    return payload;
  }

  function login(error) {
    if (error.status === 401) window.location.assign(`/login.html?next=${encodeURIComponent("/checkout.html")}`);
  }

  function renderAddresses(addresses) {
    const target = $("#checkout-addresses");
    if (!addresses.length) {
      target.innerHTML = '<p class="customer-empty">Add a delivery address to continue.</p>';
      return;
    }
    target.innerHTML = addresses.map((address, index) => `<label class="address-option"><input type="radio" name="addressId" value="${address.id}" ${address.isDefault || (!addresses.some((item) => item.isDefault) && index === 0) ? "checked" : ""} /><span><strong>${address.fullName}${address.isDefault ? " · Default" : ""}</strong><small>${address.phone} · ${address.address}${address.area ? `, ${address.area}` : ""}, ${address.city} ${address.postalCode} · ${address.country}</small></span></label>`).join("");
  }

  function renderCart(value) {
    cart = value;
    $("#checkout-items").innerHTML = value.items.map((item) => `<article class="shop-line"><img src="${item.product.image}" alt="${item.product.name}" /><div><strong>${item.product.name}</strong><small>${item.quantity} × ${money(item.unitPrice)}</small></div><strong>${money(item.subtotal)}</strong></article>`).join("");
    $("#checkout-summary").innerHTML = `<div class="summary-list"><div class="summary-row"><span>Subtotal</span><strong>${money(value.subtotal)}</strong></div><div class="summary-row"><span>Delivery</span><strong>${money(value.deliveryFee)}</strong></div><div class="summary-row total"><span>Total</span><strong>${money(value.total)}</strong></div></div>`;
  }

  async function load() {
    try {
      const [addresses, value] = await Promise.all([api("/api/account/addresses"), api("/api/cart")]);
      if (!value.items.length) { window.location.replace("/cart.html"); return; }
      renderAddresses(addresses);
      renderCart(value);
    } catch (error) { login(error); $("#checkout-status").textContent = error.message; }
  }

  $("#place-order-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const addressId = document.querySelector("input[name=addressId]:checked")?.value;
    const status = $("#checkout-status");
    if (!addressId) { status.textContent = "Choose a delivery address or add one in your account."; status.classList.add("error"); return; }
    const button = $("#place-order-button");
    button.disabled = true;
    status.textContent = "Placing your order…";
    status.classList.remove("error");
    try {
      const order = await api("/api/orders", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ addressId, paymentMethod: "cash-on-delivery" })
      });
      window.location.assign(`/order-success.html?id=${encodeURIComponent(order.id)}`);
    } catch (error) {
      login(error);
      status.textContent = error.message;
      status.classList.add("error");
      button.disabled = false;
    }
  });

  load();
})();
