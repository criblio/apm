import { Button } from '@capra/core';
import StatusBanner from './StatusBanner';

interface Props {
  failures: Readonly<Record<string, string>>;
  onRetry: () => void;
}

export default function PartialFailureBanner({ failures, onRetry }: Props) {
  const entries = Object.entries(failures);
  if (entries.length === 0) return null;
  return (
    <StatusBanner kind="error">
      <div>
        <strong>Some data is unavailable. Empty values below are not evidence of health.</strong>
        <ul>
          {entries.map(([panel, message]) => (
            <li key={panel}><strong>{panel}:</strong> {message}</li>
          ))}
        </ul>
        <Button variant="secondary" size="sm" onClick={onRetry}>Retry unavailable data</Button>
      </div>
    </StatusBanner>
  );
}
