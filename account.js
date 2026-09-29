(() => {
  const $ = (selector) => document.querySelector(selector);
  const money = (amount) => `৳${Number(amount || 0).toLocaleString("en-US")}`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  let addresses = [];
  let orderSnapshot = "";
  let refreshingOrders = false;

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || "The request could not be completed.");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function showStatus(element, message, error = false) {
    element.textContent = message;
    element.classList.toggle("error", error);
  }

  function requireLogin(error) {
    if (error.status === 401) window.location.assign(`/login.html?next=${encodeURIComponent("/account.html")}`);
  }

  function renderOrders(orders) {
    const target = $("#account-orders");
    target.innerHTML = orders.length ? orders.map((order) => `<article class="customer-item"><div class="customer-item-copy"><strong>${escapeHtml(order.orderNumber)}</strong><small>${new Date(order.createdAt).toLocaleDateString()} · ${order.itemCount} items · ${money(order.total)}</small></div><div class="customer-item-actions"><span class="order-status">${order.status === "pending" ? "Placed" : escapeHtml(order.status)}</span><a class="customer-button secondary" href="order-details.html?id=${encodeURIComponent(order.id)}">Track order</a></div></article>`).join("") : '<p class="customer-empty">Your orders will appear here.</p>';
  }

  async function refreshOrders() {
    if (refreshingOrders || document.visibilityState !== "visible") return;
    refreshingOrders = true;
    try {
      const orders = await api("/api/account/orders");
      const snapshot = JSON.stringify(orders);
      if (snapshot !== orderSnapshot) {
        orderSnapshot = snapshot;
        renderOrders(orders);
      }
    } catch (error) {
      requireLogin(error);
    } finally {
      refreshingOrders = false;
    }
  }

  function renderAddresses() {
    const target = $("#address-list");
    target.innerHTML = addresses.length ? addresses.map((address) => `<article class="customer-item"><div class="customer-item-copy"><strong>${escapeHtml(address.fullName)}${address.isDefault ? " · Default" : ""}</strong><small>${escapeHtml(address.phone)} · ${escapeHtml(address.address)}${address.area ? `, ${escapeHtml(address.area)}` : ""}, ${escapeHtml(address.city)} ${escapeHtml(address.postalCode)} · ${escapeHtml(address.country)}</small></div><div class="customer-item-actions"><button class="customer-button secondary" type="button" data-address-edit="${escapeHtml(address.id)}">Edit</button>${address.isDefault ? "" : `<button class="customer-button secondary" type="button" data-address-default="${escapeHtml(address.id)}">Make default</button>`}<button class="customer-button danger" type="button" data-address-delete="${escapeHtml(address.id)}">Delete</button></div></article>`).join("") : '<p class="customer-empty">Add a delivery address to check out.</p>';
  }

  function resetAddressForm() {
    $("#address-form").reset();
    $("#address-form [name=id]").value = "";
    $("#address-form [name=country]").value = "Bangladesh";
    $("#address-submit").textContent = "Add address";
    $("#address-cancel").hidden = true;
  }

  async function load() {
    try {
      const [profile, orders, savedAddresses] = await Promise.all([api("/api/account"), api("/api/account/orders"), api("/api/account/addresses")]);
      $("#account-name").textContent = profile.name.split(" ")[0];
      $("#account-created").textContent = `Member since ${new Date(profile.createdAt).toLocaleDateString()}`;
      for (const [field, value] of Object.entries({ name: profile.name, email: profile.email, phone: profile.phone })) $("#profile-form").elements.namedItem(field).value = value;
      addresses = savedAddresses;
      orderSnapshot = JSON.stringify(orders);
      renderOrders(orders);
      renderAddresses();
    } catch (error) {
      requireLogin(error);
      if (error.status !== 401) showStatus($("#profile-status"), error.message, true);
    }
  }

  $("#profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const body = Object.fromEntries(new FormData(event.currentTarget));
      const profile = await api("/api/account", { method: "PUT", body: JSON.stringify(body) });
      $("#account-name").textContent = profile.name.split(" ")[0];
      showStatus($("#profile-status"), "Profile updated.");
    } catch (error) { requireLogin(error); showStatus($("#profile-status"), error.message, true); }
  });

  $("#password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = $("#password-status");
    try {
      const result = await api("/api/account/password", { method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      event.currentTarget.reset();
      const message = result.envSync === "updated" ? "Password updated and local environment config synced."
        : result.envSync === "failed" ? "Password updated, but local environment config could not be synced."
          : result.envSync === "managed" ? "Password updated. Hosting environment settings are managed separately."
            : "Password updated.";
      showStatus(status, message, result.envSync === "failed");
    } catch (error) { requireLogin(error); showStatus(status, error.message, true); }
  });

  $("#address-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    body.isDefault = form.elements.namedItem("isDefault").checked;
    const id = body.id;
    delete body.id;
    try {
      await api(id ? `/api/account/addresses/${encodeURIComponent(id)}` : "/api/account/addresses", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
      resetAddressForm();
      addresses = await api("/api/account/addresses");
      renderAddresses();
      showStatus($("#address-status"), id ? "Address updated." : "Address saved.");
    } catch (error) { requireLogin(error); showStatus($("#address-status"), error.message, true); }
  });

  $("#address-list").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-address-edit], button[data-address-default], button[data-address-delete]");
    if (!button) return;
    const address = addresses.find((item) => item.id === (button.dataset.addressEdit || button.dataset.addressDefault || button.dataset.addressDelete));
    if (!address) return;
    try {
      if (button.dataset.addressEdit) {
        const form = $("#address-form");
        for (const [key, value] of Object.entries({ id: address.id, ...address })) {
          const field = form.elements.namedItem(key);
          if (field?.type === "checkbox") field.checked = Boolean(value);
          else if (field) field.value = value ?? "";
        }
        $("#address-submit").textContent = "Save address";
        $("#address-cancel").hidden = false;
        form.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (button.dataset.addressDefault) {
        await api(`/api/account/addresses/${encodeURIComponent(address.id)}`, { method: "PUT", body: JSON.stringify({ ...address, isDefault: true }) });
        addresses = await api("/api/account/addresses");
        renderAddresses();
      } else if (window.confirm("Delete this delivery address?")) {
        await api(`/api/account/addresses/${encodeURIComponent(address.id)}`, { method: "DELETE" });
        addresses = await api("/api/account/addresses");
        renderAddresses();
      }
    } catch (error) { requireLogin(error); showStatus($("#address-status"), error.message, true); }
  });

  $("#address-cancel").addEventListener("click", resetAddressForm);
  $("#logout-button").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } finally { window.location.assign("/"); }
  });
  load();
  window.setInterval(refreshOrders, 3000);
})();