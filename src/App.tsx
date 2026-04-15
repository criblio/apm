import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AppShell from './components/AppShell';
import DatasetProvider from './components/DatasetProvider';
import HomePage from './routes/HomePage';
import SearchPage from './routes/SearchPage';
import TraceView from './routes/TraceView';
import ComparePage from './routes/ComparePage';
import SystemArchPage from './routes/SystemArchPage';
import ServiceDetailPage from './routes/ServiceDetailPage';
import LogsPage from './routes/LogsPage';
import MetricsPage from './routes/MetricsPage';
import InvestigatePage from './routes/InvestigatePage';
import SettingsPage from './routes/SettingsPage';

export default function App() {
  return (
    <DatasetProvider>
      <BrowserRouter basename={window.CRIBL_BASE_PATH ?? '/'}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/trace/:traceId" element={<TraceView />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/compare/:idA/:idB" element={<ComparePage />} />
            <Route path="/architecture" element={<SystemArchPage />} />
            <Route path="/service/:serviceName" element={<ServiceDetailPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/metrics" element={<MetricsPage />} />
            <Route path="/investigate" element={<InvestigatePage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </DatasetProvider>
  );
}
