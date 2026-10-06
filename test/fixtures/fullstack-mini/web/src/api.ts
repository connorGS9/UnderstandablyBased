import axios from 'axios';

const API = '/api';
const api = axios.create({ baseURL: '/api' });

export const getUsers = () => api.get('/users');
export const getUser = (id: string) => api.get(`/users/${id}`);

export function createUser(name: string) {
  return fetch(API + '/users', { method: 'POST', body: JSON.stringify({ name }) });
}

async function apiRequest(method: string, url: string) {
  return fetch(url, { method });
}

export function deleteUser(id: string) {
  return apiRequest('DELETE', `/api/users/${id}`);
}

export const getWeather = () => fetch('https://api.weather.example.com/today');
