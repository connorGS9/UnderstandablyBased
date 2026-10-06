const express = require('express');
const usersRouter = require('./users');
const db = require('./db');

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);
app.get('/api/invoices', async (req, res) => res.json((await db.query('SELECT * FROM invoices')).rows));
app.listen(3000);
