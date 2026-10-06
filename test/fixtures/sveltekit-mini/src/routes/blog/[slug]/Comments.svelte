<script lang="ts">
  let { postId } = $props();
  async function load() {
    return fetch('/api/posts');
  }
</script>

<button on:click={() => load()}>Show comments</button>
