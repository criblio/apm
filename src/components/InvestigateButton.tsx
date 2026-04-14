/**
 * Reusable "Investigate" button used throughout the app. Clicking
 * navigates to /investigate with an InvestigationSeed passed via
 * router state; the InvestigatePage picks it up on mount, renders
 * it as a seed user message, and fires the agent loop immediately.
 *
 * Stop event propagation by default so embedding this inside
 * clickable parents (table rows, tooltip cards, edges) doesn't
 * trigger a parent click too.
 */
import { useNavigate } from 'react-router-dom';
import type { MouseEvent } from 'react';
import type { InvestigationSeed } from '../api/agentContext';
import s from './InvestigateButton.module.css';

export interface InvestigateButtonProps {
  seed: InvestigationSeed;
  /** Visual variant. "primary" is the gradient call-to-action,
   *  "subtle" is a quiet button for embedding in dense tables. */
  variant?: 'primary' | 'subtle';
  /** Optional label override. Defaults to "Investigate". */
  label?: string;
  /** Title attribute for tooltip-on-hover. */
  title?: string;
  /** Additional className for layout tweaks at the call site. */
  className?: string;
}

export default function InvestigateButton({
  seed,
  variant = 'subtle',
  label = 'Investigate',
  title,
  className,
}: InvestigateButtonProps) {
  const navigate = useNavigate();
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    navigate('/investigate', { state: { seed } });
  };
  const cls = [
    s.btn,
    variant === 'primary' ? s.primary : s.subtle,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={cls}
      onClick={handleClick}
      title={title ?? 'Start an AI-assisted investigation'}
    >
      <svg
        className={s.icon}
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.35-4.35" />
        <path d="M11 8v3l2 2" />
      </svg>
      <span>{label}</span>
    </button>
  );
}
