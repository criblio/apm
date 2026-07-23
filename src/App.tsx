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
import NotFoundPage from './routes/NotFoundPage';
import { CONFIGURATION_PATH } from './routes/paths';
import ResilienceBoundary from './components/ResilienceBoundary';

function contained(name: string, page: ReactNode): ReactNode {
  return <ResilienceBoundary title={`${name} is temporarily unavailable`}>{page}</ResilienceBoundary>;
}

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
            <Route index element={contained('Overview', <OverviewPage />)} />
            <Route path="/services" element={contained('Services', <ServicesListPage />)} />
            <Route path="/map" element={contained('Service Map', <SystemArchPage />)} />
            <Route path="/traces" element={contained('Trace Search', <SearchPage />)} />
            <Route path="/logs" element={contained('Logs', <LogsPage />)} />
            <Route path="/metrics" element={contained('Metrics', <MetricsPage />)} />
            <Route path="/alerts" element={contained('Alerts', <AlertsPage />)} />
            <Route path="/errors" element={contained('Errors', <ErrorsPage />)} />
            <Route path="/investigate" element={contained('Investigator', <InvestigatePage />)} />
            <Route path={CONFIGURATION_PATH} element={contained('Configuration', <SettingsPage />)} />
            <Route path="/trace/:traceId" element={contained('Trace', <TraceView />)} />
            <Route path="/compare" element={contained('Trace Compare', <ComparePage />)} />
            <Route path="/compare/:idA/:idB" element={contained('Trace Compare', <ComparePage />)} />
            <Route path="/service/:serviceName" element={contained('Service Detail', <ServiceDetailPage />)} />
            {/* Backwards compat redirects */}
            <Route path="/search" element={<Navigate to="/traces" replace />} />
            <Route path="/signals/traces" element={<Navigate to="/traces" replace />} />
            <Route path="/signals/logs" element={<Navigate to="/logs" replace />} />
            <Route path="/signals/metrics" element={<Navigate to="/metrics" replace />} />
            <Route path="/architecture" element={<Navigate to="/map" replace />} />
            <Route path="/services/architecture" element={<Navigate to="/map" replace />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
        </CapraRouterBridge>
      </BrowserRouter>
    </DatasetProvider>
  );
}
