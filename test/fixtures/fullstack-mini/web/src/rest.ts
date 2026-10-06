// A project-specific wrapper (like n8n's makeRestApiRequest): the base URL is added inside it.
export async function makeRestApiRequest(ctx: { baseUrl: string }, method: string, endpoint: string) {
  return fetch(ctx.baseUrl + endpoint, { method });
}

export const fetchUser = (ctx: { baseUrl: string }, id: string) => makeRestApiRequest(ctx, 'GET', `/users/${id}`);
export const removeUser = (ctx: { baseUrl: string }, id: string) => makeRestApiRequest(ctx, 'DELETE', `/users/${id}`);
