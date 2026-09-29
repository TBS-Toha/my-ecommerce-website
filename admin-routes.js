const crypto = require("node:crypto");

const ORDER_STATUSES = new Set(["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "returned", "refunded"]);
const TERMINAL_STATUSES = new Set(["cancelled", "returned", "refunded"]);

class AdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseProduct(row) {
  const product = JSON.parse(row.data);
  product.id = row.id;
  product.image = row.image_path;
  return product;
}

function updateProductStock(database, productId, quantity) {
  const row = database.prepare("SELECT data FROM products WHERE id = ?").get(productId);
  if (!row) return;
  const product = JSON.parse(row.data);
  product.stockQuantity = quantity;
  product.stockStatus = quantity === 0 ? "out-of-stock" : quantity <= 5 ? "only-few" : "in-stock";
  database.prepare("UPDATE products SET data = ? WHERE id = ?").run(JSON.stringify(product), productId);
}

function registerAdminRoutes(app, database, adminOnly, requireUser, cleanupManagedImages = () => {}) {
    app.get("/api/categories", (_request, response) => {
      const rows = database.prepare(`SELECT c.id,c.name,c.description,c.image_path,
        (SELECT COUNT(*) FROM products p WHERE json_extract(p.data,'$.category')=c.id AND json_extract(p.data,'$.catalogVisible') IS NOT 0) AS product_count
        FROM categories c ORDER BY c.name`).all();
      response.json(rows.map((row) => ({ id: row.id, name: row.name, description: row.description, image: row.image_path, productCount: row.product_count })));
    });

  app.get("/api/admin/dashboard", adminOnly, (_request, response) => {
    const sales = database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='delivered' THEN total ELSE 0 END),0) AS total_sales,
      COALESCE(SUM(CASE WHEN status='delivered' AND date(created_at)=date('now') THEN total ELSE 0 END),0) AS today_sales,
      COALESCE(SUM(CASE WHEN status='delivered' AND date(created_at)>=date('now','-6 days') THEN total ELSE 0 END),0) AS week_sales,
      COALESCE(SUM(CASE WHEN status='delivered' AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now') THEN total ELSE 0 END),0) AS month_sales,
      SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered_count
      FROM orders`).get();
    const counts = database.prepare(`SELECT
      (SELECT COUNT(*) FROM orders) AS total_orders,
      (SELECT COUNT(*) FROM orders WHERE status='pending') AS pending_orders,
      (SELECT COUNT(*) FROM users u WHERE NOT EXISTS (SELECT 1 FROM admins a WHERE a.user_id=u.id)) AS total_customers,
      (SELECT COUNT(*) FROM products) AS total_products,
      (SELECT COUNT(*) FROM inventory WHERE quantity IS NOT NULL AND quantity > 0 AND quantity <= low_stock_threshold) AS low_stock,
      (SELECT COUNT(*) FROM inventory WHERE quantity=0) AS out_of_stock`).get();
    response.json({
      totalOrders: counts.total_orders,
      pendingOrders: counts.pending_orders,
      totalCustomers: counts.total_customers,
      totalProducts: counts.total_products,
      lowStock: counts.low_stock,
      outOfStock: counts.out_of_stock,
      totalSales: sales.total_sales,
      todaySales: sales.today_sales,
      weekSales: sales.week_sales,
      monthSales: sales.month_sales,
      averageOrderValue: sales.delivered_count ? Math.round(sales.total_sales / sales.delivered_count) : 0
    });
  });

  app.get("/api/admin/orders", adminOnly, (request, response) => {
    const status = String(request.query.status || "");
    if (status && !ORDER_STATUSES.has(status)) throw new AdminError(400, "Choose a valid order status.");
    const rows = database.prepare(`SELECT o.*,u.full_name,u.email,u.phone,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id=o.id) AS item_count,
      (SELECT method FROM payments p WHERE p.order_id=o.id ORDER BY created_at LIMIT 1) AS payment_method,
      (SELECT status FROM payments p WHERE p.order_id=o.id ORDER BY created_at LIMIT 1) AS payment_status
      FROM orders o JOIN users u ON u.id=o.user_id
      WHERE (?='' OR o.status=?) ORDER BY o.created_at DESC LIMIT 300`).all(status, status);
    response.json(rows.map((row) => ({ id: row.id, orderNumber: row.order_number, customer: row.full_name, email: row.email, phone: row.phone, status: row.status, total: row.total, subtotal: row.subtotal, deliveryFee: row.delivery_fee, itemCount: row.item_count, paymentMethod: row.payment_method, paymentStatus: row.payment_status, createdAt: row.created_at })));
  });

  app.put("/api/admin/orders/:id/status", adminOnly, (request, response) => {
    const status = String(request.body?.status || "");
    if (!ORDER_STATUSES.has(status)) throw new AdminError(400, "Choose a valid order status.");
    database.exec("BEGIN IMMEDIATE");
    try {
      const order = database.prepare("SELECT * FROM orders WHERE id = ?").get(request.params.id);
      if (!order) throw new AdminError(404, "Order not found.");
      if (TERMINAL_STATUSES.has(order.status) && status !== order.status) throw new AdminError(409, "A cancelled, returned, or refunded order cannot be reopened.");
      if (status === "cancelled" && order.status !== "cancelled") {
        const items = database.prepare(`SELECT oi.product_id,oi.quantity,i.quantity AS stock FROM order_items oi
          LEFT JOIN inventory i ON i.product_id=oi.product_id WHERE oi.order_id=?`).all(order.id);
        const restore = database.prepare("UPDATE inventory SET quantity=quantity+?,updated_at=? WHERE product_id=? AND quantity IS NOT NULL");
        for (const item of items) {
          if (item.stock === null || item.stock === undefined || !item.product_id) continue;
          const updated = restore.run(item.quantity, new Date().toISOString(), item.product_id);
          if (updated.changes) updateProductStock(database, item.product_id, item.stock + item.quantity);
        }
      }
      const now = new Date().toISOString();
      database.prepare("UPDATE orders SET status=?,updated_at=? WHERE id=?").run(status, now, order.id);
      if (status === "delivered") database.prepare("UPDATE payments SET status='paid' WHERE order_id=? AND method='cash-on-delivery'").run(order.id);
      if (status === "cancelled") database.prepare("UPDATE payments SET status='failed' WHERE order_id=? AND status='pending'").run(order.id);
      if (status === "refunded") database.prepare("UPDATE payments SET status='refunded' WHERE order_id=?").run(order.id);
      database.exec("COMMIT");
      response.json({ id: order.id, orderNumber: order.order_number, status });
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });

  app.get("/api/admin/inventory", adminOnly, (_request, response) => {
    const rows = database.prepare(`SELECT p.id,p.data,p.image_path,i.quantity,i.reserved,i.low_stock_threshold,i.updated_at
      FROM products p JOIN inventory i ON i.product_id=p.id ORDER BY i.quantity IS NULL,i.quantity ASC`).all();
    response.json(rows.map((row) => {
      const product = parseProduct(row);
      const available = row.quantity === null ? null : row.quantity - row.reserved;
      const status = available === null ? "unknown" : available === 0 ? "out-of-stock" : available <= row.low_stock_threshold ? "low-stock" : "in-stock";
      return { id: row.id, name: product.name, brand: product.brand, image: row.image_path, quantity: row.quantity, reserved: row.reserved, available, lowStockThreshold: row.low_stock_threshold, status, updatedAt: row.updated_at };
    }));
  });

  app.put("/api/admin/inventory/:productId", adminOnly, (request, response) => {
    const quantity = Number(request.body?.quantity);
    const reason = String(request.body?.reason || "manual adjustment").trim();
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000) throw new AdminError(400, "Enter a whole-number stock quantity of 0 or more.");
    database.exec("BEGIN IMMEDIATE");
    try {
      const inventory = database.prepare("SELECT quantity,reserved FROM inventory WHERE product_id=?").get(request.params.productId);
      if (!inventory) throw new AdminError(404, "Inventory record not found.");
      if (quantity < inventory.reserved) throw new AdminError(409, "Stock cannot be set below the reserved quantity.");
      const delta = quantity - (inventory.quantity ?? 0);
      const now = new Date().toISOString();
      database.prepare("UPDATE inventory SET quantity=?,updated_at=? WHERE product_id=?").run(quantity, now, request.params.productId);
      database.prepare("INSERT INTO inventory_movements (id,product_id,delta,reason,created_at) VALUES (?,?,?,?,?)").run(crypto.randomUUID(), request.params.productId, delta, reason || "manual adjustment", now);
      updateProductStock(database, request.params.productId, quantity);
      database.exec("COMMIT");
      response.json({ productId: request.params.productId, quantity, available: quantity - inventory.reserved, updatedAt: now });
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });

  app.get("/api/admin/customers", adminOnly, (_request, response) => {
    const rows = database.prepare(`SELECT u.id,u.full_name,u.email,u.phone,u.created_at,
      COUNT(DISTINCT o.id) AS order_count,
      COALESCE(SUM(CASE WHEN o.status='delivered' THEN o.total ELSE 0 END),0) AS total_spent
      FROM users u LEFT JOIN admins a ON a.user_id=u.id LEFT JOIN orders o ON o.user_id=u.id
      WHERE a.user_id IS NULL GROUP BY u.id ORDER BY u.created_at DESC`).all();
    response.json(rows.map((row) => ({ id: row.id, name: row.full_name, email: row.email, phone: row.phone, joined: row.created_at, orders: row.order_count, totalSpent: row.total_spent })));
  });

  app.get("/api/admin/categories", adminOnly, (_request, response) => {
    const rows = database.prepare(`SELECT c.id,c.name,c.description,c.image_path,c.created_at,
      (SELECT COUNT(*) FROM products p WHERE json_extract(p.data,'$.category')=c.id) AS product_count
      FROM categories c ORDER BY c.name`).all();
    response.json(rows.map((row) => ({ id: row.id, name: row.name, description: row.description, image: row.image_path, productCount: row.product_count, createdAt: row.created_at })));
  });

  app.post("/api/admin/categories", adminOnly, (request, response) => {
    const name = String(request.body?.name || "").trim();
    const id = String(request.body?.id || name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new AdminError(400, "Enter a valid category name and ID.");
    try {
      database.prepare("INSERT INTO categories (id,name,description,created_at) VALUES (?,?,?,?)").run(id, name, String(request.body?.description || "").trim(), new Date().toISOString());
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) throw new AdminError(409, "A category with that name or ID already exists.");
      throw error;
    }
    response.status(201).json({ id, name });
  });

  app.put("/api/admin/categories/:id", adminOnly, (request, response) => {
    const name = String(request.body?.name || "").trim();
    if (!name) throw new AdminError(400, "Enter a category name.");
    let result;
    try {
      result = database.prepare("UPDATE categories SET name=?,description=? WHERE id=?")
        .run(name, String(request.body?.description || "").trim(), request.params.id);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) throw new AdminError(409, "A category with that name already exists.");
      throw error;
    }
    if (!result.changes) throw new AdminError(404, "Category not found.");
    response.json({ id: request.params.id, name });
  });

  app.delete("/api/admin/categories/:id", adminOnly, (request, response) => {
    const count = database.prepare("SELECT COUNT(*) AS count FROM products WHERE json_extract(data,'$.category')=?").get(request.params.id).count;
    if (count) throw new AdminError(409, "Reassign or remove this category's products before deleting it.");
    const result = database.prepare("DELETE FROM categories WHERE id=?").run(request.params.id);
    if (!result.changes) throw new AdminError(404, "Category not found.");
    cleanupManagedImages();
    response.json({ deleted: true });
  });

  app.get("/api/admin/settings", adminOnly, (_request, response) => {
    const values = Object.fromEntries(database.prepare("SELECT key,value FROM settings").all().map((row) => [row.key, row.value]));
    response.json({ storeName: values.store_name || "TOHA'S MART", storeEmail: values.store_email || "", storePhone: values.store_phone || "", storeAddress: values.store_address || "", deliveryFee: Number(values.delivery_fee || 0), lowStockThreshold: Number(values.low_stock_threshold || 5), currency: values.currency || "BDT", orderPrefix: values.order_prefix || "ORD" });
  });

  app.put("/api/admin/settings", adminOnly, (request, response) => {
    const deliveryFee = Number(request.body?.deliveryFee);
    if (!Number.isSafeInteger(deliveryFee) || deliveryFee < 0 || deliveryFee > 1000000) throw new AdminError(400, "Enter a valid delivery fee.");
    const now = new Date().toISOString();
    database.prepare("INSERT INTO settings(key,value,updated_at) VALUES('delivery_fee',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(String(deliveryFee), now);
    response.json({ deliveryFee });
  });

  app.get("/api/admin/reports", adminOnly, (_request, response) => {
    const dailySales = database.prepare(`SELECT date(created_at) AS date,SUM(total) AS sales,COUNT(*) AS orders FROM orders
      WHERE status='delivered' AND date(created_at)>=date('now','-29 days') GROUP BY date(created_at) ORDER BY date`).all();
    const monthlySales = database.prepare(`SELECT strftime('%Y-%m',created_at) AS month,SUM(total) AS sales,COUNT(*) AS orders FROM orders
      WHERE status='delivered' AND created_at>=datetime('now','-11 months') GROUP BY strftime('%Y-%m',created_at) ORDER BY month`).all();
    const ordersByStatus = database.prepare("SELECT status,COUNT(*) AS count FROM orders GROUP BY status ORDER BY status").all();
    const topProducts = database.prepare(`SELECT product_name AS name,COALESCE(SUM(quantity),0) AS units,COALESCE(SUM(line_total),0) AS sales FROM order_items oi
      JOIN orders o ON o.id=oi.order_id WHERE o.status='delivered' GROUP BY product_name ORDER BY units DESC LIMIT 10`).all();
    const lowStock = database.prepare(`SELECT p.id,json_extract(p.data,'$.name') AS name,i.quantity,i.low_stock_threshold FROM inventory i
      JOIN products p ON p.id=i.product_id WHERE i.quantity IS NOT NULL AND i.quantity>0 AND i.quantity<=i.low_stock_threshold ORDER BY i.quantity`).all();
    const categorySales = database.prepare(`SELECT c.name AS category,SUM(oi.line_total) AS sales,SUM(oi.quantity) AS units FROM order_items oi
      JOIN orders o ON o.id=oi.order_id JOIN categories c ON c.id=json_extract(oi.product_snapshot,'$.category')
      WHERE o.status='delivered' GROUP BY c.id ORDER BY sales DESC`).all();
    response.json({ dailySales, monthlySales, ordersByStatus, topProducts, lowStock, categorySales });
  });

  app.get("/api/admin/reviews", adminOnly, (_request, response) => {
    const rows = database.prepare(`SELECT r.*,u.full_name,p.data AS product_data FROM reviews r
      JOIN users u ON u.id=r.user_id JOIN products p ON p.id=r.product_id ORDER BY r.created_at DESC LIMIT 300`).all();
    response.json(rows.map((row) => ({ id: row.id, customer: row.full_name, productId: row.product_id, product: JSON.parse(row.product_data).name, orderId: row.order_id, rating: row.rating, review: row.review, status: row.status, createdAt: row.created_at })));
  });

  app.get("/api/reviews", (_request, response) => {
    const rows = database.prepare(`SELECT r.id,r.rating,r.review,r.created_at,u.full_name,p.data AS product_data
      FROM reviews r JOIN users u ON u.id=r.user_id JOIN products p ON p.id=r.product_id
      WHERE r.status='approved' ORDER BY r.created_at DESC LIMIT 4`).all();
    response.json(rows.map((row) => ({
      id: row.id,
      customer: row.full_name,
      product: JSON.parse(row.product_data).name,
      rating: row.rating,
      review: row.review,
      createdAt: row.created_at
    })));
  });

  app.put("/api/admin/reviews/:id/status", adminOnly, (request, response) => {
    const status = String(request.body?.status || "");
    if (!["pending", "approved", "hidden"].includes(status)) throw new AdminError(400, "Choose a valid review status.");
    const result = database.prepare("UPDATE reviews SET status=? WHERE id=?").run(status, request.params.id);
    if (!result.changes) throw new AdminError(404, "Review not found.");
    response.json({ id: request.params.id, status });
  });

  app.delete("/api/admin/reviews/:id", adminOnly, (request, response) => {
    const result = database.prepare("DELETE FROM reviews WHERE id=?").run(request.params.id);
    if (!result.changes) throw new AdminError(404, "Review not found.");
    response.json({ deleted: true });
  });

  app.get("/api/products/:id/reviews", (request, response) => {
    const rows = database.prepare(`SELECT r.id,r.rating,r.review,r.created_at,u.full_name FROM reviews r JOIN users u ON u.id=r.user_id
      WHERE r.product_id=? AND r.status='approved' ORDER BY r.created_at DESC`).all(request.params.id);
    response.json(rows.map((row) => ({ id: row.id, rating: row.rating, review: row.review, createdAt: row.created_at, customer: row.full_name })));
  });

  app.post("/api/reviews", requireUser(database), (request, response) => {
    const productId = String(request.body?.productId || "");
    const orderId = String(request.body?.orderId || "");
    const rating = Number(request.body?.rating);
    const review = String(request.body?.review || "").trim();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !review) throw new AdminError(400, "Enter a rating and review.");
    const purchased = database.prepare(`SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE o.id=? AND o.user_id=? AND o.status='delivered' AND oi.product_id=?`).get(orderId, request.authUser.id, productId);
    if (!purchased) throw new AdminError(403, "A delivered order is required to review this product.");
    const id = crypto.randomUUID();
    try {
      database.prepare("INSERT INTO reviews (id,user_id,product_id,order_id,rating,review,status,created_at) VALUES (?,?,?,?,?,?,'pending',?)")
        .run(id, request.authUser.id, productId, orderId, rating, review, new Date().toISOString());
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) throw new AdminError(409, "You have already reviewed this product for that order.");
      throw error;
    }
    response.status(201).json({ id, status: "pending" });
  });
}

module.exports = { registerAdminRoutes };
