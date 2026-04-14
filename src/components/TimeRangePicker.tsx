import { TIME_RANGES } from './timeRanges';
import s from './TimeRangePicker.module.css';

interface Props {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  disabled?: boolean;
}

export default function TimeRangePicker({ value, onChange, label = 'Range', disabled }: Props) {
  return (
    <div className={s.wrap}>
      <span className={s.label}>{label}</span>
      <select
        className={s.select}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        {TIME_RANGES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
    </div>
  );
}
