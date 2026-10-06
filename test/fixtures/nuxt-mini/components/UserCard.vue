<script setup lang="ts">
defineProps<{ user: { name: string } }>();
</script>
<template><div>{{ user.name }}</div></template>
