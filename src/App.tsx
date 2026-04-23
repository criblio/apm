import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
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
import ServicesListPage from './routes/ServicesListPage';
import AlertsPage from './routes/AlertsPage';

export default function App() {
  return (
    <DatasetProvider>
      <BrowserRouter basename={window.CRIBL_BASE_PATH ?? '/'}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="/signals/traces" element={<SearchPage />} />
            <Route path="/signals/logs" element={<LogsPage />} />
            <Route path="/signals/metrics" element={<MetricsPage />} />
            <Route path="/trace/:traceId" element={<TraceView />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/compare/:idA/:idB" element={<ComparePage />} />
            <Route path="/services" element={<ServicesListPage />} />
            <Route path="/services/architecture" element={<SystemArchPage />} />
            <Route path="/architecture" element={<Navigate to="/services/architecture" replace />} />
            <Route path="/service/:serviceName" element={<ServiceDetailPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/investigate" element={<InvestigatePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* Backwards compat redirects */}
            <Route path="/search" element={<Navigate to="/signals/traces" replace />} />
            <Route path="/logs" element={<Navigate to="/signals/logs" replace />} />
            <Route path="/metrics" element={<Navigate to="/signals/metrics" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </DatasetProvider>
  );
}
