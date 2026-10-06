import { createFileRoute } from '@tanstack/react-router';
import { loadPost } from '../posts';

export const Route = createFileRoute('/posts/$postId')({
  loader: ({ params }) => loadPost(params.postId),
  component: PostPage,
});

function PostPage() {
  return <article />;
}
