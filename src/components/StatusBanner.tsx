import s from './StatusBanner.module.css';

interface Props {
  kind: 'error' | 'info';
  children: React.ReactNode;
}

export default function StatusBanner({ kind, children }: Props) {
  return <div className={`${s.banner} ${s[kind]}`}>{children}</div>;
}
