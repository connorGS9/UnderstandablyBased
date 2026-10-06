import { useStore } from './store';
import { Landing } from './pages/Landing';
import { Loading } from './pages/Loading';
import { Workspace } from './pages/Workspace';

export function App() {
  const summary = useStore((s) => s.summary);
  const opening = useStore((s) => s.opening);
  if (opening) return <Loading />;
  if (!summary) return <Landing />;
  return <Workspace />;
}
