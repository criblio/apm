import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/AppShell';
import DatasetProvider from './components/DatasetProvider';
import OverviewPage from './routes/OverviewPage';
import SearchPage from './routes/SearchPage';
import TraceView from './routes/TraceView';
import ComparePage from './routes/ComparePage';
import SystemArchPage from './routes/SystemArchPage';
import ServiceDetailPage from './routes/ServiceDetailPage';
import LogsPage from './routes/LogsPage';
import MetricsPage from './routes/MetricsPage';
import InvestigatePage from './routes/InvestigatePage';
import SettingsPage from './routes/SettingsPage';
import ServicesListPage from './routes/ServicesListPage';
import AlertsPage from './routes/AlertsPage';

export default function App() {
  return (
    <DatasetProvider>
      <BrowserRouter basename={window.CRIBL_BASE_PATH ?? '/'}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<OverviewPage />} />
            <Route path="/services" element={<ServicesListPage />} />
            <Route path="/map" element={<SystemArchPage />} />
            <Route path="/traces" element={<SearchPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/metrics" element={<MetricsPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/errors" element={<AlertsPage />} />
            <Route path="/investigate" element={<InvestigatePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/trace/:traceId" element={<TraceView />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/compare/:idA/:idB" element={<ComparePage />} />
            <Route path="/service/:serviceName" element={<ServiceDetailPage />} />
            {/* Backwards compat redirects */}
            <Route path="/search" element={<Navigate to="/traces" replace />} />
            <Route path="/signals/traces" element={<Navigate to="/traces" replace />} />
            <Route path="/signals/logs" element={<Navigate to="/logs" replace />} />
            <Route path="/signals/metrics" element={<Navigate to="/metrics" replace />} />
            <Route path="/architecture" element={<Navigate to="/map" replace />} />
            <Route path="/services/architecture" element={<Navigate to="/map" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </DatasetProvider>
  );
}
