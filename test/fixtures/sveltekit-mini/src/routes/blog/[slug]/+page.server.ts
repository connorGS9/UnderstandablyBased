import { findPost } from '$lib/db';

export const load = async ({ params }) => {
  return { post: await findPost(params.slug) };
};
