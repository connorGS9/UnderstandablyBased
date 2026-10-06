export async function loadPost(id: string) {
  return (await fetch(`https://api.example.com/posts/${id}`)).json();
}
