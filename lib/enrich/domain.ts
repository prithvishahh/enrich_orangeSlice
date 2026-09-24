/**
 * Normalize user input into a bare registrable host:
 *   "https://www.Stripe.com/about?x=1" -> "stripe.com"
 * Returns null when the input can't be a domain.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.replace(/^[^@/]*@/, ""); // userinfo / email local part
  s = s.split(/[/?#]/)[0]; // path, query, fragment
  s = s.replace(/:\d+$/, ""); // port
  s = s.replace(/^www\d*\./, "");
  s = s.replace(/\.+$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  if (!/[a-z]/.test(s.split(".").pop()!)) return null; // reject bare IPs
  return s;
}

/** Split pasted text (newlines, commas, tabs) into unique normalized domains. */
export function parseDomainList(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n\r,\t;]+/)) {
    const d = normalizeDomain(part);
    if (d) seen.add(d);
  }
  return [...seen];
}
