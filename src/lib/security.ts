import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

export function verifyKapsoSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!secret || !HEX_SHA256.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return safeCompare(expected, signature.toLowerCase());
}
