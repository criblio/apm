/**
 * Short-lived HMAC tickets for WebSocket auth.
 *
 * The sandboxed iframe can inject an Authorization header only on
 * fetch()es routed through the platform proxy — not on a WebSocket
 * upgrade. So the UI first calls GET /ws-ticket (bearer-authed via
 * the proxy), gets a ticket scoped to one investigation with a 60s
 * TTL, and passes it as a query param on the wss:// URL.
 *
 * Ticket format: `<expiresMs>.<hex hmac-sha256(secret, id + ":" + expiresMs)>`
 */

const TICKET_TTL_MS = 60_000;

/** HMAC-SHA256 is always 32 bytes, so the hex signature is always 64. */
const SIG_BYTES = 32;
const SIG_HEX_LENGTH = SIG_BYTES * 2;

const ENCODER = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function mintTicket(
  secret: string,
  investigationId: string,
  nowMs: number,
): Promise<string> {
  const expires = nowMs + TICKET_TTL_MS;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    ENCODER.encode(`${investigationId}:${expires}`),
  );
  return `${expires}.${toHex(sig)}`;
}

export async function verifyTicket(
  secret: string,
  investigationId: string,
  ticket: string,
  nowMs: number,
): Promise<boolean> {
  const dot = ticket.indexOf('.');
  if (dot <= 0) return false;
  const expires = Number(ticket.slice(0, dot));
  if (!Number.isFinite(expires) || expires < nowMs) return false;
  const given = ticket.slice(dot + 1);
  if (given.length !== SIG_HEX_LENGTH) return false;
  const bytes = new Uint8Array(SIG_BYTES);
  for (let i = 0; i < bytes.length; i++) {
    const parsed = Number.parseInt(given.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(parsed)) return false;
    bytes[i] = parsed;
  }
  // crypto.subtle.verify does the comparison in constant time, so it
  // is the only HMAC this needs — signing a second copy to compare
  // by hand would leak timing and cost an extra crypto call.
  const key = await hmacKey(secret);
  return crypto.subtle.verify(
    'HMAC',
    key,
    bytes,
    ENCODER.encode(`${investigationId}:${expires}`),
  );
}
