import axios from 'axios';

export async function fetchUsers() {
  const res = await axios.get('/api/users');
  return res.data;
}

export async function fetchUser(id: string) {
  return (await axios.get(`/api/users/${id}`)).data;
}
