(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const money = (value) => `৳${Number(value || 0).toLocaleString("en-US")}`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const orderStatuses = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "returned", "refunded"];
  let customers = [];
  let categories = [];

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData) && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const response = await fetch(path, { ...options, headers });
    const body = await response.text();
    let payload = null;
    if (body) {
      try {
        payload = JSON.parse(body);
      } catch {
        const error = new Error(response.ok ? "The server returned an invalid response." : `Request failed (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
      }
    }
    if (!response.ok) {
      const error = new Error(payload?.error || `The request could not be completed (HTTP ${response.status}).`);
      error.status = response.status;
      throw error;
    }
    if (payload === null) throw new Error("The server returned an empty response.");
    return payload;
  }

  function toast(message, isError = false) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("visible");
    element.classList.toggle("is-error", isError);
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove("visible"), 2800);
  }

  function handleError(error) {
    if (error.status === 401 || error.status === 403) {
      window.location.assign("/login.html?next=%2Fadmin.html");
      return;
    }
    toast(error.message, true);
  }

  function ensureDashboardMetrics() {
    const grid = $("#view-dashboard .stats-grid");
    const metrics = [
      ["totalSales", "Delivered sales", "BDT settled from delivered orders"],
      ["totalOrders", "Total orders", "All order statuses"],
      ["totalCustomers", "Customers", "Registered customer accounts"],
      ["pendingOrders", "Pending orders", "Awaiting confirmation"],
      ["outOfStock", "Out of stock", "Unavailable units"],
      ["averageOrderValue", "Average order", "Delivered orders only"]
    ];
    for (const [key, label, hint] of metrics) {
      if (grid.querySelector(`[data-admin-stat="${key}"]`)) continue;
      const card = document.createElement("article");
      card.className = "stat-card";
      card.innerHTML = `<div class="stat-top"><span>${label}</span><span class="stat-icon">↗</span></div><strong data-admin-stat="${key}">0</strong><small>${hint}</small>`;
      grid.append(card);
    }
  }

  function ensureSettingsForm() {
    const settingsView = $("#view-settings");
    if (!settingsView || $("#store-settings-form")) return;
    const panel = document.createElement("section");
    panel.className = "panel settings-panel";
    panel.innerHTML = '<h3>Store settings</h3><form id="store-settings-form" class="admin-commerce-form"><label>Delivery fee (৳)<input name="deliveryFee" type="number" min="0" step="1" required /></label><button class="button button-primary" type="submit">Save settings</button><span class="admin-commerce-status" id="settings-status" role="status"></span></form>';
    settingsView.querySelector(".view-heading").after(panel);
  }

  function setMetric(key, value) {
    const element = $(`[data-admin-stat="${key}"]`);
    if (element) element.textContent = ["totalSales", "averageOrderValue"].includes(key) ? money(value) : Number(value || 0).toLocaleString();
  }

  async function loadDashboard() {
    const data = await api("/api/admin/dashboard");
    for (const key of ["totalSales", "totalOrders", "totalCustomers", "totalProducts", "pendingOrders", "lowStock", "outOfStock", "averageOrderValue"]) setMetric(key, data[key]);
  }

  async function loadOrders() {
    const filter = $("#orders-filter").value;
    const rows = await api(`/api/admin/orders${filter ? `?status=${encodeURIComponent(filter)}` : ""}`);
    $("#admin-orders").innerHTML = rows.length ? rows.map((order) => `<tr><td><strong>${escapeHtml(order.orderNumber)}</strong></td><td>${escapeHtml(order.customer)}<br /><small>${escapeHtml(order.email)}</small></td><td>${new Date(order.createdAt).toLocaleDateString()}</td><td>${order.itemCount}</td><td>${money(order.total)}</td><td>${escapeHtml(order.paymentMethod)}<br /><small>${escapeHtml(order.paymentStatus)}</small></td><td><select data-order-status="${escapeHtml(order.id)}">${orderStatuses.map((status) => `<option value="${status}" ${status === order.status ? "selected" : ""}>${status}</option>`).join("")}</select></td><td><button type="button" class="icon-action" data-order-save="${escapeHtml(order.id)}">SAVE</button></td></tr>`).join("") : '<tr><td colspan="8" class="empty-state">No orders found.</td></tr>';
  }

  async function loadCustomers() {
    customers = await api("/api/admin/customers");
    renderCustomers();
  }

  function renderCustomers() {
    const query = $("#customer-search").value.trim().toLocaleLowerCase();
    const rows = customers.filter((customer) => [customer.name, customer.email, customer.phone].some((value) => String(value).toLocaleLowerCase().includes(query)));
    $("#admin-customers").innerHTML = rows.length ? rows.map((customer) => `<tr><td>${escapeHtml(customer.name)}</td><td>${escapeHtml(customer.email)}</td><td>${escapeHtml(customer.phone)}</td><td>${new Date(customer.joined).toLocaleDateString()}</td><td>${customer.orders}</td><td>${money(customer.totalSpent)}</td></tr>`).join("") : '<tr><td colspan="6" class="empty-state">No customers found.</td></tr>';
  }

  async function loadInventory() {
    const rows = await api("/api/admin/inventory");
    $("#admin-inventory").innerHTML = rows.length ? rows.map((item) => `<tr><td><div class="product-cell">${item.image ? `<img src="${escapeHtml(item.image)}" alt="" />` : ""}<span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.brand)}</small></span></div></td><td>${item.quantity ?? "Unknown"}</td><td>${item.reserved}</td><td>${item.available ?? "Unknown"}</td><td><span class="stock-label ${item.status === "in-stock" ? "in-stock" : item.status === "low-stock" ? "only-few" : item.status === "out-of-stock" ? "limited" : ""}">${escapeHtml(item.status)}</span></td><td><div class="admin-inline-edit"><input type="number" min="0" step="1" value="${item.quantity ?? ""}" placeholder="Unknown" data-stock-value="${escapeHtml(item.id)}" /><button type="button" class="icon-action" data-stock-save="${escapeHtml(item.id)}">SAVE</button></div></td></tr>`).join("") : '<tr><td colspan="6" class="empty-state">No inventory records.</td></tr>';
  }

  async function loadCategories() {
    categories = await api("/api/admin/categories");
    $("#category-table").innerHTML = categories.length ? categories.map((category) => `<tr><td><div class="category-table-cell">${category.image ? `<img src="${escapeHtml(category.image)}" alt="" />` : '<span class="category-table-placeholder">NO PHOTO</span>'}<span><strong>${escapeHtml(category.name)}</strong><small>${escapeHtml(category.id)}</small></span></div></td><td>${category.productCount}</td><td>${escapeHtml(category.description)}</td><td><div class="row-actions"><button class="icon-action" type="button" data-category-edit="${escapeHtml(category.id)}">EDIT</button><button class="icon-action delete" type="button" data-category-delete="${escapeHtml(category.id)}">DEL</button></div></td></tr>`).join("") : '<tr><td colspan="4" class="empty-state">No categories found.</td></tr>';
    updateCategorySelects();
  }

  function updateCategorySelects() {
    for (const select of [$("#product-category"), $("#filter-category")]) {
      if (!select) continue;
      const previous = select.value;
      const first = select === $("#filter-category") ? new Option("All categories", "") : null;
      select.replaceChildren(...(first ? [first] : []), ...categories.map((category) => new Option(category.name, category.id)));
      if (categories.some((category) => category.id === previous)) select.value = previous;
    }
  }

  let categoryPreviewObjectUrl = null;

  function setCategoryImagePreview(source) {
    if (categoryPreviewObjectUrl) URL.revokeObjectURL(categoryPreviewObjectUrl);
    categoryPreviewObjectUrl = String(source || "").startsWith("blob:") ? source : null;
    const preview = $("#category-image-preview");
    preview.hidden = !source;
    if (source) preview.src = source;
    else preview.removeAttribute("src");
    $("#category-image-placeholder").hidden = Boolean(source);
  }

  function resetCategoryForm() {
    const form = $("#category-form");
    form.reset();
    $("#category-id").value = "";
    $("#category-form-heading").textContent = "Add category";
    $("#category-save").textContent = "Add category";
    $("#category-cancel").hidden = true;
    setCategoryImagePreview("");
    $("#category-image-status").textContent = "Optional · JPG, PNG, or WEBP · up to 5 MB";
    $("#category-image-status").classList.remove("is-error");
  }

  function editCategory(category) {
    $("#category-id").value = category.id;
    $("#category-name").value = category.name;
    $("#category-description").value = category.description || "";
    $("#category-form-heading").textContent = `Edit ${category.name}`;
    $("#category-save").textContent = "Save changes";
    $("#category-cancel").hidden = false;
    setCategoryImagePreview(category.image || "");
    $("#category-image-status").textContent = category.image ? "Choose a new photo to replace this one." : "No photo uploaded yet.";
    $("#category-name").focus();
    $("#category-form").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function loadReviews() {
    const rows = await api("/api/admin/reviews");
    $("#admin-reviews").innerHTML = rows.length ? rows.map((review) => `<tr><td>${escapeHtml(review.product)}</td><td>${escapeHtml(review.customer)}</td><td>${"★".repeat(review.rating)}</td><td class="admin-review-text">${escapeHtml(review.review)}</td><td><select data-review-status="${escapeHtml(review.id)}"><option value="pending" ${review.status === "pending" ? "selected" : ""}>Pending</option><option value="approved" ${review.status === "approved" ? "selected" : ""}>Approved</option><option value="hidden" ${review.status === "hidden" ? "selected" : ""}>Hidden</option></select></td><td><button class="icon-action" type="button" data-review-save="${escapeHtml(review.id)}">SAVE</button><button class="icon-action delete" type="button" data-review-delete="${escapeHtml(review.id)}">DEL</button></td></tr>`).join("") : '<tr><td colspan="6" class="empty-state">No reviews have been submitted.</td></tr>';
  }

  function formatMonth(monthValue) {
    if (!monthValue) return "Unknown";
    const [year, month] = String(monthValue).split("-");
    if (!year || !month) return String(monthValue);
    return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }

  async function loadReports() {
    const data = await api("/api/admin/reports");
    $("#report-daily").innerHTML = data.dailySales.length ? data.dailySales.map((row) => `<tr><td>${escapeHtml(row.date)}</td><td>${row.orders}</td><td>${money(row.sales)}</td></tr>`).join("") : '<tr><td colspan="3" class="empty-state">No delivered sales in the last 30 days.</td></tr>';
    $("#report-monthly").innerHTML = data.monthlySales.length ? data.monthlySales.map((row) => `<tr><td>${escapeHtml(formatMonth(row.month))}</td><td>${row.orders}</td><td>${money(row.sales)}</td></tr>`).join("") : '<tr><td colspan="3" class="empty-state">No delivered sales in the last 12 months.</td></tr>';
    $("#report-status").innerHTML = data.ordersByStatus.length ? data.ordersByStatus.map((row) => `<tr><td>${escapeHtml(row.status)}</td><td>${row.count}</td></tr>`).join("") : '<tr><td colspan="2" class="empty-state">No orders.</td></tr>';
    $("#report-products").innerHTML = data.topProducts.length ? data.topProducts.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${row.units}</td><td>${money(row.sales)}</td></tr>`).join("") : '<tr><td colspan="3" class="empty-state">No delivered product sales.</td></tr>';
    $("#report-category").innerHTML = data.categorySales.length ? data.categorySales.map((row) => `<tr><td>${escapeHtml(row.category || "Uncategorized")}</td><td>${Number(row.units || 0)}</td><td>${money(row.sales)}</td></tr>`).join("") : '<tr><td colspan="3" class="empty-state">No category sales yet.</td></tr>';
    $("#report-stock").innerHTML = data.lowStock.length ? data.lowStock.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${row.quantity}</td><td>${row.low_stock_threshold}</td></tr>`).join("") : '<tr><td colspan="3" class="empty-state">No low-stock products.</td></tr>';
  }

  async function loadSettings() {
    const settings = await api("/api/admin/settings");
    $("#store-settings-form").elements.namedItem("deliveryFee").value = settings.deliveryFee;
  }

  const loaders = { dashboard: loadDashboard, orders: loadOrders, customers: loadCustomers, inventory: loadInventory, categories: loadCategories, reviews: loadReviews, reports: loadReports, settings: loadSettings };
  const titles = { dashboard: "Dashboard", orders: "Orders", customers: "Customers", inventory: "Inventory", categories: "Categories", reviews: "Reviews", reports: "Reports", settings: "Settings" };

  document.addEventListener("click", async (event) => {
    const nav = event.target.closest("[data-view-target]");
    if (nav && loaders[nav.dataset.viewTarget]) {
      $("#page-title").textContent = titles[nav.dataset.viewTarget];
      try { await loaders[nav.dataset.viewTarget](); } catch (error) { handleError(error); }
    }

    const saveOrder = event.target.closest("[data-order-save]");
    if (saveOrder) {
      const row = saveOrder.closest("tr");
      try {
        await api(`/api/admin/orders/${encodeURIComponent(saveOrder.dataset.orderSave)}/status`, { method: "PUT", body: JSON.stringify({ status: row.querySelector("[data-order-status]").value }) });
        toast("Order status updated.");
        await Promise.all([loadOrders(), loadDashboard()]);
      } catch (error) { handleError(error); }
    }

    const saveStock = event.target.closest("[data-stock-save]");
    if (saveStock) {
      const input = saveStock.closest("tr").querySelector("[data-stock-value]");
      if (input.value === "") return toast("Enter a stock quantity to save.", true);
      try {
        await api(`/api/admin/inventory/${encodeURIComponent(saveStock.dataset.stockSave)}`, { method: "PUT", body: JSON.stringify({ quantity: Number(input.value), reason: "Admin stock adjustment" }) });
        toast("Inventory updated.");
        await Promise.all([loadInventory(), loadDashboard()]);
      } catch (error) { handleError(error); }
    }

    const deleteCategory = event.target.closest("[data-category-delete]");
    if (deleteCategory && window.confirm("Delete this category? Categories with products cannot be deleted.")) {
      try { await api(`/api/admin/categories/${encodeURIComponent(deleteCategory.dataset.categoryDelete)}`, { method: "DELETE" }); await loadCategories(); toast("Category deleted."); }
      catch (error) { handleError(error); }
    }

    const saveReview = event.target.closest("[data-review-save]");
    if (saveReview) {
      const status = saveReview.closest("tr").querySelector("[data-review-status]").value;
      try { await api(`/api/admin/reviews/${encodeURIComponent(saveReview.dataset.reviewSave)}/status`, { method: "PUT", body: JSON.stringify({ status }) }); toast("Review status updated."); }
      catch (error) { handleError(error); }
    }

    const deleteReview = event.target.closest("[data-review-delete]");
    if (deleteReview && window.confirm("Delete this review permanently?")) {
      try { await api(`/api/admin/reviews/${encodeURIComponent(deleteReview.dataset.reviewDelete)}`, { method: "DELETE" }); await loadReviews(); toast("Review deleted."); }
      catch (error) { handleError(error); }
    }
  });

  $("#orders-filter").addEventListener("change", () => loadOrders().catch(handleError));
  $("#customer-search").addEventListener("input", renderCustomers);
  $("#category-table").addEventListener("click", (event) => {
    const button = event.target.closest("[data-category-edit]");
    if (!button) return;
    const category = categories.find((item) => item.id === button.dataset.categoryEdit);
    if (category) editCategory(category);
    else toast("Category data is not loaded. Refresh the Categories list and try again.", true);
  });
  $("#category-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    let categoryId = $("#category-id").value;
    const isNewCategory = !categoryId;
    const imageFile = $("#category-image-file").files?.[0] || null;
    if (imageFile && imageFile.size > 5 * 1024 * 1024) return toast("Category image must be 5 MB or smaller.", true);
    try {
      const category = { name: $("#category-name").value.trim(), description: $("#category-description").value.trim() };
      if (categoryId) {
        await api(`/api/admin/categories/${encodeURIComponent(categoryId)}`, { method: "PUT", body: JSON.stringify(category) });
      } else {
        const created = await api("/api/admin/categories", { method: "POST", body: JSON.stringify(category) });
        categoryId = created.id;
        $("#category-id").value = categoryId;
        $("#category-form-heading").textContent = `Edit ${created.name}`;
        $("#category-save").textContent = "Save changes";
        $("#category-cancel").hidden = false;
      }
      if (imageFile) {
        const body = new FormData();
        body.append("image", imageFile);
        await api(`/api/admin/categories/${encodeURIComponent(categoryId)}/image`, { method: "PUT", body });
      }
      resetCategoryForm();
      await loadCategories();
      toast(isNewCategory ? "Category added." : "Category updated.");
    } catch (error) { handleError(error); }
  });
  $("#category-cancel").addEventListener("click", resetCategoryForm);
  $("#category-image-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setCategoryImagePreview(URL.createObjectURL(file));
    $("#category-image-status").textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB`;
    $("#category-image-status").classList.toggle("is-error", file.size > 5 * 1024 * 1024);
  });

  $("#settings-status")?.closest("form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ deliveryFee: Number(new FormData(event.currentTarget).get("deliveryFee")) }) });
      $("#settings-status").textContent = `Saved · ${money(result.deliveryFee)}`;
      toast("Store settings saved.");
    } catch (error) { handleError(error); }
  });

  ensureDashboardMetrics();
  ensureSettingsForm();
  loadCategories().catch(handleError);
  loadDashboard().catch(handleError);
})();
