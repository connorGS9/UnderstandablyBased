const db = require('../db');

async function listOrders(customerId) {
  return db.query('SELECT id, total FROM orders WHERE customer_id = $1', [customerId]);
}

async function cancelOrder(id) {
  await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [id]);
  await notifyWarehouse(id);
}

async function notifyWarehouse(id) {
  await fetch('https://warehouse.example.com/api/cancellations', { method: 'POST', body: JSON.stringify({ id }) });
}

module.exports = { listOrders, cancelOrder };
