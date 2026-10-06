import pg from 'pg';
const pool = new pg.Pool();
export async function findPost(slug: string) {
  return (await pool.query('SELECT * FROM posts WHERE slug = $1', [slug])).rows[0];
}
export async function savePost(title: string) {
  return pool.query('INSERT INTO posts (title) VALUES ($1)', [title]);
}
