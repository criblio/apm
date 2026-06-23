import { BrowserRouter, Routes, Route, Navigate, useHref, useNavigate } from 'react-router-dom';
import { RouterProvider as AriaRouterProvider } from '@capra/core';
import type { ReactNode } from 'react';
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
import ErrorsPage from './routes/ErrorsPage';

/**
 * Bridges React Router's navigate/useHref into the Capra (react-aria-
 * components) router context so Capra primitives with `href` props —
 * VerticalNavigation.Item, Link, ButtonLink, etc. — do client-side
 * navigation through React Router instead of full-page transitions.
 * Must live INSIDE BrowserRouter so useNavigate is callable.
 */
function CapraRouterBridge({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <AriaRouterProvider navigate={navigate} useHref={useHref}>
      {children}
    </AriaRouterProvider>
  );
}

export default function App() {
  return (
    <DatasetProvider>
      <BrowserRouter basename={window.CRIBL_BASE_PATH ?? '/'}>
        <CapraRouterBridge>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<OverviewPage />} />
            <Route path="/services" element={<ServicesListPage />} />
            <Route path="/map" element={<SystemArchPage />} />
            <Route path="/traces" element={<SearchPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/metrics" element={<MetricsPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/errors" element={<ErrorsPage />} />
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
        </CapraRouterBridge>
      </BrowserRouter>
    </DatasetProvider>
  );
}
