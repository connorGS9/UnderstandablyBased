import { db } from './db.server';

export async function getNote(id: string) {
  const rows = await db.query('SELECT * FROM notes WHERE id = $1', [id]);
  return rows[0];
}

export async function deleteNote(id: string) {
  return db.query('DELETE FROM notes WHERE id = $1', [id]);
}
