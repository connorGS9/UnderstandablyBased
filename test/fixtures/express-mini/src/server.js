const express = require('express');
const ordersRouter = require('./routes/orders');
const { requireAuth } = require('./middleware');

const app = express();
app.use(express.json());
app.use('/api/orders', requireAuth, ordersRouter);
app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(3000);
