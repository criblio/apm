import { Outlet } from 'react-router-dom';
import NavBar from './NavBar';
import { useDataset } from '../hooks/useDataset';
import s from './AppShell.module.css';

export default function AppShell() {
  const dataset = useDataset();
  return (
    <div className={s.shell}>
      <NavBar />
      <main className={s.content}>
        {/*
         * Keying the outlet on the active dataset forces every routed
         * page to remount when the user switches datasets on the
         * Settings page. That guarantees fresh queries without wiring
         * a dataset dep into every page's useEffect.
         */}
        <Outlet key={dataset} />
      </main>
    </div>
  );
}
