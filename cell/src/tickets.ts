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

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
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
    new TextEncoder().encode(`${investigationId}:${expires}`),
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
  const key = await hmacKey(secret);
  const expected = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${investigationId}:${expires}`),
  );
  // crypto.subtle.verify gives constant-time comparison.
  const given = ticket.slice(dot + 1);
  if (given.length !== expected.byteLength * 2) return false;
  const bytes = new Uint8Array(expected.byteLength);
  for (let i = 0; i < bytes.length; i++) {
    const parsed = Number.parseInt(given.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(parsed)) return false;
    bytes[i] = parsed;
  }
  return crypto.subtle.verify(
    'HMAC',
    key,
    bytes,
    new TextEncoder().encode(`${investigationId}:${expires}`),
  );
}
