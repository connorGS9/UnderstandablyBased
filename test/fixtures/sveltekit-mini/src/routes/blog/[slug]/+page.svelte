<script lang="ts">
  import Comments from './Comments.svelte';
  let { data } = $props();

  async function like() {
    await fetch(`/api/posts/${data.post.id}/like`, { method: 'POST' });
  }
</script>

<h1>{data.post.title}</h1>
<button onclick={like}>Like</button>
<Comments postId={data.post.id} />
