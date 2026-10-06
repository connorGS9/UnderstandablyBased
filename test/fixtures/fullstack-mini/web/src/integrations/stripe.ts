// Calls Stripe, not our server: its paths must not be mistaken for our routes even when one looks alike.
async function stripeApiRequest(method: string, endpoint: string) {
  return fetch('https://api.stripe.com/v1' + endpoint, { method });
}

export const stripeUser = (id: string) => stripeApiRequest('GET', `/users/${id}`);
export const listCharges = () => stripeApiRequest('GET', '/charges');
export const createCustomer = () => stripeApiRequest('POST', '/customers');
