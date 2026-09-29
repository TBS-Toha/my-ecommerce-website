(() => {
  const $ = (selector) => document.querySelector(selector);
  const money = (amount) => `৳${Number(amount || 0).toLocaleString("en-US")}`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const statusSteps = ["pending", "confirmed", "processing", "shipped", "delivered"];
  let currentStatus = "";

  function renderTimeline(status) {
    const currentIndex = statusSteps.indexOf(status);
    const terminal = ["cancelled", "returned", "refunded"].includes(status);
    const timeline = terminal ? [status] : statusSteps;
    $("#order-timeline").innerHTML = timeline.map((step, index) => `<div class="customer-item"><span>${terminal ? "•" : index <= currentIndex ? "✓" : "○"}</span><span class="order-status">${step === "pending" ? "Placed" : escapeHtml(step)}</span></div>`).join("");
  }

  async function refreshStatus() {
    if (!currentStatus || document.visibilityState !== "visible") return;
    const orderId = new URLSearchParams(window.location.search).get("id");
    if (!orderId) return;
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}`);
      const order = await response.json();
      if (response.status === 401) { window.location.assign(`/login.html?next=${encodeURIComponent(window.location.pathname + window.location.search)}`); return; }
      if (response.ok && order.status !== currentStatus) {
        currentStatus = order.status;
        renderTimeline(currentStatus);
      }
    } catch {}
  }

  async function load() {
    const orderId = new URLSearchParams(window.location.search).get("id");
    if (!orderId) { $("#order-error").textContent = "Order not found."; return; }
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}`);
      const order = await response.json();
      if (response.status === 401) { window.location.assign(`/login.html?next=${encodeURIComponent(window.location.pathname + window.location.search)}`); return; }
      if (!response.ok) throw new Error(order.error || "Order details could not be loaded.");
      $("#order-title").textContent = order.orderNumber;
      $("#order-date").textContent = new Date(order.createdAt).toLocaleString();
      const address = order.shippingAddress;
      $("#order-address").textContent = `${address.fullName} · ${address.phone} · ${address.address}${address.area ? `, ${address.area}` : ""}, ${address.city} ${address.postalCode} · ${address.country}`;
      $("#order-items").innerHTML = order.items.map((item) => `<article class="shop-line"><img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" /><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.brand)} · ${item.quantity} × ${money(item.unitPrice)}</small></div><strong>${money(item.lineTotal)}</strong></article>`).join("");
      $("#order-summary").innerHTML = `<div class="summary-list"><div class="summary-row"><span>Subtotal</span><strong>${money(order.subtotal)}</strong></div><div class="summary-row"><span>Delivery</span><strong>${money(order.deliveryFee)}</strong></div><div class="summary-row total"><span>Total</span><strong>${money(order.total)}</strong></div><div class="summary-row"><span>Payment</span><strong>Cash on delivery · ${escapeHtml(order.paymentStatus)}</strong></div></div>`;
      currentStatus = order.status;
      renderTimeline(currentStatus);
          if (order.status === "delivered") {
            $("#order-review-panel").hidden = false;
            $("#order-reviews").innerHTML = order.items.filter((item) => item.productId).map((item) => `<form class="customer-form review-form" data-review-form data-product-id="${escapeHtml(item.productId)}"><strong>${escapeHtml(item.name)}</strong><label>Rating<select name="rating" required><option value="5">5 · Excellent</option><option value="4">4 · Good</option><option value="3">3 · Average</option><option value="2">2 · Poor</option><option value="1">1 · Very poor</option></select></label><label>Your review<textarea name="review" required></textarea></label><button class="customer-button" type="submit">Submit review</button><p class="customer-status" role="status"></p></form>`).join("") || '<p class="customer-empty">No reviewable products in this order.</p>';
          }
    } catch (error) { $("#order-error").textContent = error.message; $("#order-error").classList.add("error"); }
  }

  $("#order-reviews")?.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-review-form]");
    if (!form) return;
    event.preventDefault();
    const status = form.querySelector(".customer-status");
    try {
      const fields = Object.fromEntries(new FormData(form));
      await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: form.dataset.productId, orderId: new URLSearchParams(window.location.search).get("id"), ...fields })
      }).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Review could not be submitted.");
        return payload;
      });
      status.textContent = "Review submitted for approval.";
      form.querySelector("button[type=submit]").disabled = true;
    } catch (error) { status.textContent = error.message; status.classList.add("error"); }
  });

  load();
  window.setInterval(refreshStatus, 3000);
})();
