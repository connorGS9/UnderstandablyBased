import { useEffect, useState } from 'react';
import { getUsers, createUser } from '../api';
import { UserRow, Badge } from '../components/UserRow';

export default function Users() {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    getUsers().then((r) => setUsers(r.data));
  }, []);
  const onAdd = async () => {
    await createUser('new');
  };
  return (
    <div>
      <Badge text="Users" />
      <button onClick={onAdd}>Add</button>
      <ul>
        {users.map((u) => (
          <UserRow key={u.id} id={u.id} name={u.name} />
        ))}
      </ul>
    </div>
  );
}
