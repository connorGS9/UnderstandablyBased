import { deleteUser } from '../api';

export function UserRow({ id, name }: { id: string; name: string }) {
  const onDelete = () => deleteUser(id);
  return (
    <li>
      {name} <button onClick={onDelete}>Delete</button>
    </li>
  );
}

export function Badge({ text }: { text: string }) {
  return <span className="badge">{text}</span>;
}
