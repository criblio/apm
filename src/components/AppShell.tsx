import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useDataset } from '../hooks/useDataset';
import s from './AppShell.module.css';

export default function AppShell() {
  const dataset = useDataset();
  return (
    <div className={s.shell}>
      <Sidebar />
      <main className={s.content}>
        <Outlet key={dataset} />
      </main>
    </div>
  );
}
