/**
 * Which backend a screen belongs to.
 *
 * Shown on every screen that has one open, and deliberately loud: a reader may
 * have several gateways saved, and once inside, everything on the page belongs
 * to exactly one of them — including session names, which repeat across
 * gateways. Without it, two windows on two backends look identical.
 */
export function BackendBadge({ name, url }: { name: string; url?: string }) {
  return (
    <span className="backend-badge" title={url ? `${name} · ${url}` : name}>
      {name}
    </span>
  );
}
