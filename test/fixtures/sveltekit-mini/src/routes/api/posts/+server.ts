import { json } from '@sveltejs/kit';
import { savePost } from '$lib/db';

export async function GET() {
  return json([]);
}

export const POST = async ({ request }) => {
  const body = await request.json();
  await savePost(body.title);
  return json({ ok: true });
};
