<template>
  <ul>
    <li v-for="u in users" :key="u.id">{{ u.name }}</li>
  </ul>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { fetchUsers } from '../api/users';

const users = ref([]);
onMounted(async () => {
  users.value = await fetchUsers();
});
</script>
