const express = require('express');
const db = require('./db');

const router = express.Router();

async function listUsers() {
  return (await db.query('SELECT id, name FROM users')).rows;
}

async function insertUser(name, email) {
  return db.query('INSERT INTO users (name, email) VALUES ($1, $2)', [name, email]);
}

router.get('/', async (req, res) => res.json(await listUsers()));
router.get('/:id', async (req, res) => res.json((await db.query('SELECT * FROM users WHERE id = $1', [req.params.id])).rows[0]));
router.post('/', async (req, res) => {
  await insertUser(req.body.name, req.body.email);
  res.status(201).end();
});
router.delete('/:id', async (req, res) => {
  await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

module.exports = router;
