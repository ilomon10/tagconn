/**
 * Extracts the hostname from a `Host` header, stripping the port. IPv6 literals keep their
 * brackets (e.g. "[::1]:4317" -> "[::1]") so they match settings.server.allowedHosts entries
 * verbatim (the default list includes "[::1]").
 */
export function hostnameFromHostHeader(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  const idx = host.lastIndexOf(':');
  return idx >= 0 ? host.slice(0, idx) : host;
}
