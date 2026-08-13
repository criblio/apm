/**
 * Pure-logic tests for the wire protocol helpers. The DO behavior
 * (create → idle → resume, list search/pagination) is exercised by
 * scripts/smoke.mjs against a live cell — it needs the celld SQLite
 * runtime, which these node-side unit tests don't have.
 */
import { describe, expect, it } from 'vitest';
import { titleFromPrompt } from '../protocol';

describe('titleFromPrompt', () => {
  it('collapses whitespace to a single-line title', () => {
    expect(titleFromPrompt('why is   checkout\n slow?')).toBe('why is checkout slow?');
  });

  it('truncates long prompts with an ellipsis at 80 chars', () => {
    const long = 'a'.repeat(200);
    const title = titleFromPrompt(long);
    expect(title.length).toBe(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps short prompts intact', () => {
    expect(titleFromPrompt('payment errors')).toBe('payment errors');
  });

  it('falls back to a default for an empty prompt', () => {
    expect(titleFromPrompt('   ')).toBe('Investigation');
  });
});
