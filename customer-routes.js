const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { hashPassword, verifyPassword } = require("./auth-routes");

class CommerceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cleanText(value) {
  return String(value ?? "").trim();
}

async function updateLocalAdminPassword(password) {
  const envPath = path.join(__dirname, ".env");
  const current = await fs.readFile(envPath, "utf8");
  const assignment = `ADMIN_PASSWORD=${JSON.stringify(password)}`;
  const updated = /^ADMIN_PASSWORD\s*=.*$/m.test(current)
    ? current.replace(/^ADMIN_PASSWORD\s*=.*$/m, assignment)
    : `${current}${current.endsWith("\n") ? "" : "\n"}${assignment}\n`;
  const temporaryPath = `${envPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, updated, "utf8");
    await fs.rename(temporaryPath, envPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

function addressPayload(value) {
  const address = {
    fullName: cleanText(value?.fullName),
    phone: cleanText(value?.phone),
    address: cleanText(value?.address),
    area: cleanText(value?.area),
    city: cleanText(value?.city),
    postalCode: cleanText(value?.postalCode),
    country: cleanText(value?.country || "Bangladesh"),
    isDefault: Boolean(value?.isDefault)
  };
    if (!address.fullName || !/^\+?[0-9\s().-]*[0-9][0-9\s().-]*$/.test(address.phone)
      || !address.address || !address.city || !address.country) {
    throw new CommerceError(400, "Enter a name, valid phone, street address, city, and country.");
  }
  return address;
}

function productForCart(row) {
  const product = JSON.parse(row.data);
  product.id = row.id;
  product.image = row.image_path;
  product.stockQuantity = row.quantity ?? null;
  return product;
}

function cartForUser(database, userId) {
  const rows = database.prepare(`
    SELECT p.id, p.data, p.image_path, ci.quantity AS cart_quantity, i.quantity, i.reserved
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    LEFT JOIN inventory i ON i.product_id = p.id
    WHERE ci.user_id = ?
    ORDER BY ci.updated_at DESC
  `).all(userId);
  const items = rows.map((row) => {
    const product = productForCart(row);
    const unitPrice = Number(product.price);
    return { product, quantity: row.cart_quantity, unitPrice, subtotal: unitPrice * row.cart_quantity };
  });
  const subtotal = items.reduce((total, item) => total + item.subtotal, 0);
  const deliveryFee = Number(database.prepare("SELECT value FROM settings WHERE key = 'delivery_fee'").get()?.value || 0);
  return { items, subtotal, deliveryFee, total: subtotal + deliveryFee };
}

function requireActiveProduct(database, productId) {
  const row = database.prepare(`
    SELECT p.id, p.data, p.image_path, i.quantity, i.reserved
    FROM products p LEFT JOIN inventory i ON i.product_id = p.id
    WHERE p.id = ?
  `).get(productId);
  if (!row) throw new CommerceError(404, "Product not found.");
  const product = productForCart(row);
  if (product.active === false) throw new CommerceError(409, "This product is not available.");
  return { row, product, available: row.quantity === null || row.quantity === undefined ? null : row.quantity - row.reserved };
}

function ensureAvailable(available, requested) {
  if (available !== null && available < requested) {
    if (available <= 0) throw new CommerceError(409, "This product is out of stock.");
    throw new CommerceError(409, `Only ${available} units are available.`);
  }
}

function addressRow(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone,
    address: row.address,
    area: row.area,
    city: row.city,
    postalCode: row.postal_code,
    country: row.country,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at
  };
}

function orderRow(database, row) {
  const payment = database.prepare("SELECT method, status FROM payments WHERE order_id = ? ORDER BY created_at LIMIT 1").get(row.id);
  const items = database.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?").get(row.id).count;
  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    subtotal: row.subtotal,
    deliveryFee: row.delivery_fee,
    discount: row.discount,
    total: row.total,
    itemCount: items,
    paymentMethod: payment?.method || "cash-on-delivery",
    paymentStatus: payment?.status || "pending",
    createdAt: row.created_at
  };
}

function registerCustomerRoutes(app, database, requireUser) {
  const account = requireUser(database);

  app.get("/api/account", account, (request, response) => {
    const row = database.prepare("SELECT full_name, email, phone, created_at FROM users WHERE id = ?").get(request.authUser.id);
    response.json({ id: request.authUser.id, name: row.full_name, email: row.email, phone: row.phone, createdAt: row.created_at });
  });

  app.put("/api/account", account, (request, response) => {
    const name = cleanText(request.body?.name);
    const phone = cleanText(request.body?.phone);
    if (!name || !/^\+?[0-9\s().-]*[0-9][0-9\s().-]*$/.test(phone)) {
      throw new CommerceError(400, "Enter your name and a valid phone number.");
    }
    database.prepare("UPDATE users SET full_name = ?, phone = ?, updated_at = ? WHERE id = ?")
      .run(name, phone, new Date().toISOString(), request.authUser.id);
    response.json({ id: request.authUser.id, name, email: request.authUser.email, phone });
  });

  app.put("/api/account/password", account, async (request, response) => {
    const currentPassword = String(request.body?.currentPassword || "");
    const password = String(request.body?.password || "");
    const confirmPassword = String(request.body?.confirmPassword || "");
    if (password.length < 10 || password.length > 128) throw new CommerceError(400, "Password must be between 10 and 128 characters.");
    if (password !== confirmPassword) throw new CommerceError(400, "Passwords do not match.");
    const row = database.prepare("SELECT password_hash FROM users WHERE id = ?").get(request.authUser.id);
    if (!(await verifyPassword(currentPassword, row.password_hash))) throw new CommerceError(400, "Current password is incorrect.");
    const passwordHash = await hashPassword(password);
    database.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(passwordHash, new Date().toISOString(), request.authUser.id);
    const isAdmin = Boolean(database.prepare("SELECT 1 FROM admins WHERE user_id = ?").get(request.authUser.id));
    let envSync = "not-applicable";
    if (isAdmin && process.env.NODE_ENV === "production") {
      envSync = "managed";
    } else if (isAdmin) {
      try {
        await updateLocalAdminPassword(password);
        process.env.ADMIN_PASSWORD = password;
        envSync = "updated";
      } catch (error) {
        console.error("Admin password changed, but local .env sync failed:", error.message);
        envSync = "failed";
      }
    }
    response.json({ updated: true, envSync });
  });

  app.get("/api/account/addresses", account, (request, response) => {
    const rows = database.prepare("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC").all(request.authUser.id);
    response.json(rows.map(addressRow));
  });

  app.post("/api/account/addresses", account, (request, response) => {
    const address = addressPayload(request.body);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const existingCount = database.prepare("SELECT COUNT(*) AS count FROM addresses WHERE user_id = ?").get(request.authUser.id).count;
    database.exec("BEGIN IMMEDIATE");
    try {
      if (address.isDefault || existingCount === 0) database.prepare("UPDATE addresses SET is_default = 0 WHERE user_id = ?").run(request.authUser.id);
      database.prepare(`INSERT INTO addresses (id,user_id,full_name,phone,address,area,city,postal_code,country,is_default,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, request.authUser.id, address.fullName, address.phone, address.address, address.area, address.city, address.postalCode, address.country, address.isDefault || existingCount === 0 ? 1 : 0, now, now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    response.status(201).json(addressRow(database.prepare("SELECT * FROM addresses WHERE id = ?").get(id)));
  });

  app.put("/api/account/addresses/:id", account, (request, response) => {
    const address = addressPayload(request.body);
    const existing = database.prepare("SELECT id FROM addresses WHERE id = ? AND user_id = ?").get(request.params.id, request.authUser.id);
    if (!existing) throw new CommerceError(404, "Address not found.");
    database.exec("BEGIN IMMEDIATE");
    try {
      if (address.isDefault) database.prepare("UPDATE addresses SET is_default = 0 WHERE user_id = ?").run(request.authUser.id);
      database.prepare(`UPDATE addresses SET full_name=?,phone=?,address=?,area=?,city=?,postal_code=?,country=?,is_default=?,updated_at=?
        WHERE id=? AND user_id=?`).run(address.fullName, address.phone, address.address, address.area, address.city, address.postalCode, address.country, address.isDefault ? 1 : 0, new Date().toISOString(), request.params.id, request.authUser.id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    response.json(addressRow(database.prepare("SELECT * FROM addresses WHERE id = ?").get(request.params.id)));
  });

  app.delete("/api/account/addresses/:id", account, (request, response) => {
    const existing = database.prepare("SELECT is_default FROM addresses WHERE id = ? AND user_id = ?").get(request.params.id, request.authUser.id);
    if (!existing) throw new CommerceError(404, "Address not found.");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("DELETE FROM addresses WHERE id = ? AND user_id = ?").run(request.params.id, request.authUser.id);
      if (existing.is_default) {
        const next = database.prepare("SELECT id FROM addresses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(request.authUser.id);
        if (next) database.prepare("UPDATE addresses SET is_default = 1 WHERE id = ?").run(next.id);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    response.json({ deleted: true });
  });

  app.get("/api/cart", account, (request, response) => response.json(cartForUser(database, request.authUser.id)));

  app.post("/api/cart", account, (request, response) => {
    const productId = String(request.body?.productId || "");
    const quantity = Number(request.body?.quantity ?? 1);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) throw new CommerceError(400, "Quantity must be between 1 and 99.");
    const { available } = requireActiveProduct(database, productId);
    const current = database.prepare("SELECT quantity FROM cart_items WHERE user_id = ? AND product_id = ?").get(request.authUser.id, productId)?.quantity || 0;
      if (current + quantity > 99) throw new CommerceError(400, "A cart item cannot exceed 99 units.");
    ensureAvailable(available, current + quantity);
    database.prepare(`INSERT INTO cart_items (user_id,product_id,quantity,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=excluded.quantity,updated_at=excluded.updated_at`)
      .run(request.authUser.id, productId, current + quantity, new Date().toISOString());
    response.status(201).json(cartForUser(database, request.authUser.id));
  });

  app.put("/api/cart/:productId", account, (request, response) => {
    const quantity = Number(request.body?.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) throw new CommerceError(400, "Quantity must be between 1 and 99.");
    const { available } = requireActiveProduct(database, request.params.productId);
    ensureAvailable(available, quantity);
    const result = database.prepare("UPDATE cart_items SET quantity = ?, updated_at = ? WHERE user_id = ? AND product_id = ?")
      .run(quantity, new Date().toISOString(), request.authUser.id, request.params.productId);
    if (!result.changes) throw new CommerceError(404, "Cart item not found.");
    response.json(cartForUser(database, request.authUser.id));
  });

  app.delete("/api/cart/:productId", account, (request, response) => {
    database.prepare("DELETE FROM cart_items WHERE user_id = ? AND product_id = ?").run(request.authUser.id, request.params.productId);
    response.json(cartForUser(database, request.authUser.id));
  });

  app.delete("/api/cart", account, (request, response) => {
    database.prepare("DELETE FROM cart_items WHERE user_id = ?").run(request.authUser.id);
    response.json(cartForUser(database, request.authUser.id));
  });

  app.get("/api/wishlist", account, (request, response) => {
    const rows = database.prepare(`SELECT p.id,p.data,p.image_path,i.quantity FROM wishlist_items w
      JOIN products p ON p.id=w.product_id LEFT JOIN inventory i ON i.product_id=p.id
      WHERE w.user_id=? ORDER BY w.created_at DESC`).all(request.authUser.id);
    response.json(rows.map((row) => productForCart(row)));
  });

  app.post("/api/wishlist", account, (request, response) => {
    const productId = String(request.body?.productId || "");
    requireActiveProduct(database, productId);
    database.prepare("INSERT OR IGNORE INTO wishlist_items (user_id,product_id,created_at) VALUES (?,?,?)")
      .run(request.authUser.id, productId, new Date().toISOString());
    response.status(201).json({ wishlist: database.prepare("SELECT COUNT(*) AS count FROM wishlist_items WHERE user_id = ?").get(request.authUser.id).count });
  });

  app.delete("/api/wishlist/:productId", account, (request, response) => {
    database.prepare("DELETE FROM wishlist_items WHERE user_id = ? AND product_id = ?").run(request.authUser.id, request.params.productId);
    response.json({ wishlist: database.prepare("SELECT COUNT(*) AS count FROM wishlist_items WHERE user_id = ?").get(request.authUser.id).count });
  });

  app.post("/api/orders", account, (request, response) => {
    const clientIdempotencyKey = String(request.get("Idempotency-Key") || "").trim();
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(clientIdempotencyKey)) throw new CommerceError(400, "A valid Idempotency-Key header is required.");
    const idempotencyKey = crypto.createHash("sha256").update(`${request.authUser.id}:${clientIdempotencyKey}`).digest("hex");
    if ((request.body?.paymentMethod || "cash-on-delivery") !== "cash-on-delivery") throw new CommerceError(400, "Only cash on delivery is currently available.");

    database.exec("BEGIN IMMEDIATE");
    let orderId;
    let reused = false;
    try {
      const previous = database.prepare("SELECT id FROM orders WHERE user_id = ? AND idempotency_key = ?").get(request.authUser.id, idempotencyKey);
      if (previous) {
        orderId = previous.id;
        reused = true;
        database.exec("COMMIT");
      } else {
        const address = database.prepare("SELECT * FROM addresses WHERE id = ? AND user_id = ?").get(String(request.body?.addressId || ""), request.authUser.id);
        if (!address) throw new CommerceError(400, "Choose a saved delivery address.");
        const cartRows = database.prepare(`SELECT p.id,p.data,p.image_path,ci.quantity AS cart_quantity,i.quantity,i.reserved
          FROM cart_items ci JOIN products p ON p.id=ci.product_id LEFT JOIN inventory i ON i.product_id=p.id
          WHERE ci.user_id=?`).all(request.authUser.id);
        if (!cartRows.length) throw new CommerceError(400, "Your cart is empty.");
        const items = cartRows.map((row) => {
          const product = productForCart(row);
          if (product.active === false) throw new CommerceError(409, `${product.name} is no longer available.`);
          const available = row.quantity === null || row.quantity === undefined ? null : row.quantity - row.reserved;
          ensureAvailable(available, row.cart_quantity);
          const unitPrice = Number(product.price);
          if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) throw new CommerceError(409, `${product.name} has an invalid price.`);
          return { row, product, unitPrice, quantity: row.cart_quantity, lineTotal: unitPrice * row.cart_quantity };
        });
        const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
        const deliveryFee = Number(database.prepare("SELECT value FROM settings WHERE key = 'delivery_fee'").get()?.value || 0);
        const total = subtotal + deliveryFee;
        const now = new Date().toISOString();
        const orderNumber = `ORD-${Number(database.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(order_number, 5) AS INTEGER)), 10000) AS last FROM orders").get().last) + 1}`;
        orderId = crypto.randomUUID();
        const addressSnapshot = addressRow(address);
        database.prepare(`INSERT INTO orders (id,order_number,user_id,address_id,shipping_address,subtotal,delivery_fee,discount,total,status,idempotency_key,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?)`).run(orderId, orderNumber, request.authUser.id, address.id, JSON.stringify(addressSnapshot), subtotal, deliveryFee, 0, total, idempotencyKey, now, now);
        const insertItem = database.prepare(`INSERT INTO order_items (id,order_id,product_id,product_name,brand,image_path,unit_price,quantity,line_total,product_snapshot)
          VALUES (?,?,?,?,?,?,?,?,?,?)`);
        const changeInventory = database.prepare("UPDATE inventory SET quantity = quantity - ?, updated_at = ? WHERE product_id = ? AND quantity IS NOT NULL AND quantity - reserved >= ?");
        const changeProduct = database.prepare("UPDATE products SET data = ? WHERE id = ?");
        for (const item of items) {
          insertItem.run(crypto.randomUUID(), orderId, item.product.id, item.product.name, item.product.brand || "", item.product.image, item.unitPrice, item.quantity, item.lineTotal, JSON.stringify(item.product));
          if (item.row.quantity !== null && item.row.quantity !== undefined) {
            const updated = changeInventory.run(item.quantity, now, item.product.id, item.quantity);
            if (!updated.changes) throw new CommerceError(409, `Stock changed while placing the order for ${item.product.name}. Please review your cart.`);
            const nextQuantity = item.row.quantity - item.quantity;
            item.product.stockQuantity = nextQuantity;
            item.product.stockStatus = nextQuantity === 0 ? "out-of-stock" : nextQuantity <= 5 ? "only-few" : "in-stock";
            changeProduct.run(JSON.stringify(item.product), item.product.id);
          }
        }
        database.prepare("INSERT INTO payments (id,order_id,method,amount,status,created_at) VALUES (?,?, 'cash-on-delivery',?,'pending',?)")
          .run(crypto.randomUUID(), orderId, total, now);
        database.prepare("DELETE FROM cart_items WHERE user_id = ?").run(request.authUser.id);
        database.exec("COMMIT");
      }
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const row = database.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(orderId, request.authUser.id);
    const items = database.prepare("SELECT product_id AS productId,product_name AS name,brand,image_path AS image,unit_price AS unitPrice,quantity,line_total AS lineTotal,product_snapshot AS productSnapshot FROM order_items WHERE order_id = ?").all(orderId)
      .map((item) => ({ ...item, productSnapshot: JSON.parse(item.productSnapshot) }));
    response.status(reused ? 200 : 201).json({ ...orderRow(database, row), shippingAddress: JSON.parse(row.shipping_address), items });
  });

  app.get("/api/account/orders", account, (request, response) => {
    const rows = database.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC").all(request.authUser.id);
    response.json(rows.map((row) => orderRow(database, row)));
  });

  app.get("/api/orders/:id", account, (request, response) => {
    const row = database.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(request.params.id, request.authUser.id);
    if (!row) throw new CommerceError(404, "Order not found.");
    const items = database.prepare("SELECT product_id AS productId,product_name AS name,brand,image_path AS image,unit_price AS unitPrice,quantity,line_total AS lineTotal,product_snapshot AS productSnapshot FROM order_items WHERE order_id = ?").all(row.id)
      .map((item) => ({ ...item, productSnapshot: JSON.parse(item.productSnapshot) }));
    response.json({ ...orderRow(database, row), shippingAddress: JSON.parse(row.shipping_address), items });
  });
}

module.exports = { registerCustomerRoutes };
