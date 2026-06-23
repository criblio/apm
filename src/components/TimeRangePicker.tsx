/**
 * Compact range picker shown on most pages. Visually a dropdown
 * button with the current range label; clicking opens a Capra
 * Menu of choices. Built on @capra/core's Button + Menu so the
 * styling matches the rest of the app's reskinned controls.
 *
 * Kept its existing props (value / onChange / label / disabled)
 * so all of its callers continue working unchanged.
 */
import { Button, Menu } from '@capra/core';
import { ChevronDown } from '@capra/icons';
import { TIME_RANGES } from './timeRanges';
import s from './TimeRangePicker.module.css';

interface Props {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  disabled?: boolean;
}

export default function TimeRangePicker({
  value,
  onChange,
  label = 'Range',
  disabled,
}: Props) {
  const current = TIME_RANGES.find((r) => r.value === value);
  return (
    <div className={s.wrap}>
      <span className={s.label}>{label}</span>
      <Menu
        trigger={
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            trailingIcon={ChevronDown}
          >
            {current?.label ?? value}
          </Button>
        }
      >
        {TIME_RANGES.map((r) => (
          <Menu.Item
            key={r.value}
            label={r.label}
            onClick={() => onChange(r.value)}
          />
        ))}
      </Menu>
    </div>
  );
}
