import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import qrcode from 'qrcode-terminal';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

export function joinUrl(value) {
  if (!value) throw new Error('Provide a public URL: npm run qr -- https://your-tunnel.trycloudflare.com/join');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS URL');
  if (url.username || url.password) throw new Error('Do not include credentials in a QR URL');
  if (url.pathname === '/') url.pathname = '/join';
  return url.href;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const url = joinUrl(process.argv[2] || process.env.PUBLIC_URL);
    qrcode.generate(url, { small: true });
    console.log(`\nScan to join PowerTrace:\n${url}\n`);
  } catch (error) { console.error(`QR: ${error.message}`); process.exitCode = 1; }
}
