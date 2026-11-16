import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function equalDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sameSecret(a: string | null, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = createHmac("sha256", "header-comparison").update(a).digest();
  const right = createHmac("sha256", "header-comparison").update(b).digest();
  return equalDigest(left, right);
}

export function validWebhook(raw: string, signature: string | null, secret: string | undefined): boolean {
  if (!secret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return equalDigest(expected, Buffer.from(signature, "hex"));
}

export function validCheckoutSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string | undefined,
): boolean {
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  return sameSecret(expected, signature);
}

export function requestFingerprint(request: Request, scope: string): string {
  const ip = request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  return createHash("sha256").update(`${scope}:${ip}`).digest("hex");
}
