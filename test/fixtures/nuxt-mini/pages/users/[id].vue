<script setup lang="ts">
const route = useRoute();
const { data: user } = await useFetch(`/api/users/${route.params.id}`);

async function remove() {
  await $fetch(`/api/users/${route.params.id}`, { method: 'DELETE' });
}
</script>

<template>
  <UserCard :user="user" />
  <button @click="remove">Delete</button>
</template>
