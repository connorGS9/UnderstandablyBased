const express = require('express');
const orderService = require('../services/orderService');

const router = express.Router();

router.get('/', async (req, res) => {
  res.json(await orderService.listOrders(req.query.customer));
});

router.post('/:id/cancel', async (req, res) => {
  await orderService.cancelOrder(req.params.id);
  res.status(204).end();
});

module.exports = router;
