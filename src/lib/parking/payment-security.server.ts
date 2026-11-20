import { createHmac, timingSafeEqual } from "node:crypto";

export function sameSecret(a: string | null, b: string | undefined) {
  if (!a || !b) return false;
  const left = createHmac("sha256", "header-comparison").update(a).digest();
  const right = createHmac("sha256", "header-comparison").update(b).digest();
  return timingSafeEqual(left, right);
}
export function validWebhook(raw: string, signature: string | null, secret: string | undefined) {
  if (!secret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  return timingSafeEqual(
    createHmac("sha256", secret).update(raw).digest(),
    Buffer.from(signature, "hex"),
  );
}
