import { getNote, deleteNote } from '../models.server';

export async function loader({ params }) {
  return getNote(params.noteId);
}

export async function action({ params }) {
  return deleteNote(params.noteId);
}

export default function NotePage() {
  return <div />;
}
