// Browser-safe URI policies. Admin-originated URLs mirror migration 010's
// existing syntax exactly; general evidence/embed URLs retain WHATWG behavior.
function hasControls(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
function forbidden(value: string): boolean {
  return value.length > 2048 || /[\s<>"'\\]/.test(value) || hasControls(value);
}
export function isHttpsUrl(value: string): boolean {
  if (forbidden(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password;
  } catch {
    return false;
  }
}
const ADMIN_URL =
  /^[Hh][Tt][Tt][Pp][Ss]:\/\/([A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?\.)*[A-Za-z]([A-Za-z0-9_-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#].*)?$/;
/** SQL-compatible ASCII hostname syntax, not a DNS/IDNA resolution guarantee. */
export function isAdminHttpsUrl(value: string): boolean {
  if (forbidden(value) || !ADMIN_URL.test(value)) return false;
  const port = /^[Hh][Tt][Tt][Pp][Ss]:\/\/[^/?#]*:([0-9]+)/.exec(value)?.[1];
  return port === undefined || Number(port) <= 65535;
}
