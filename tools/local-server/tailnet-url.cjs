/**
 * Prints this PC's public funnel address, e.g. https://pc-name.tail9a4b2c.ts.net
 *
 * Reads `tailscale status --json` (Self.DNSName, trailing dot stripped).
 * Used by Setup-MediFlow.bat, which saves the result to public-url.txt for
 * the operator to send to the developer (one rebuild + deploy repoints the
 * website at it). Exits non-zero when Tailscale is not up, so the bat can
 * distinguish "not connected yet" from a real address.
 *
 * Pure parsing is unit-testable: require('./tailnet-url.cjs') exposes
 * parseFunnelUrl().
 */

const { execSync } = require('node:child_process');

function parseFunnelUrl(statusJson) {
  const dns = statusJson && statusJson.Self && statusJson.Self.DNSName;
  if (typeof dns !== 'string' || !dns) return null;
  const host = dns.replace(/\.$/, '').toLowerCase();
  if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(host)) return null;
  return `https://${host}`;
}

function main() {
  let raw;
  try {
    raw = execSync('tailscale status --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    console.error('Tailscale is not connected yet.');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('Could not read Tailscale status.');
    process.exit(1);
  }
  const url = parseFunnelUrl(parsed);
  if (!url) {
    console.error('No funnel address found - is this PC logged in?');
    process.exit(1);
  }
  console.log(url);
}

if (require.main === module) main();

module.exports = { parseFunnelUrl };
