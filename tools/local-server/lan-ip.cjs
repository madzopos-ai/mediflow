/**
 * Prints this PC's LAN address (first private IPv4, else first non-loopback,
 * else 127.0.0.1). Used by Setup-MediFlow.bat, which cannot reliably parse
 * PowerShell quoting - plain Node has no quoting traps at all.
 */
const os = require('node:os');

function pick() {
  const all = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  return (
    all.find((a) => a.startsWith('192.168.') || a.startsWith('10.')) ||
    all.find((a) => !a.startsWith('127.') && !a.startsWith('169.254.')) ||
    '127.0.0.1'
  );
}

console.log(pick());
