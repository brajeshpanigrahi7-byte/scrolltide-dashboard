const CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generateSessionCode(): string {
  let result = "";
  for (let i = 0; i < 6; i++) {
    const idx = Math.floor(Math.random() * CODE_CHARS.length);
    result += CODE_CHARS[idx];
  }
  return result;
}

export function computeAmountPaise(durationMin: number, pricePerHour: number): number {
  return Math.ceil((durationMin / 60) * pricePerHour * 100);
}

export function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  // ESP32 requires flat, compact JSON: no spaces, no indentation
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
