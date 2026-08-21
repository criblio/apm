import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import ProvisioningBanners from './ProvisioningBanners';
import { useDataset } from '@criblio/app-utils/dataset';
import s from './AppShell.module.css';

export default function AppShell() {
  const dataset = useDataset();
  return (
    <div className={s.shell}>
      <Sidebar />
      <main className={s.content}>
        <ProvisioningBanners />
        <Outlet key={dataset} />
      </main>
    </div>
  );
}
