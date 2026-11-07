import net from 'node:net';

const socket = net.connect(process.argv[2]);
socket.setTimeout(120000, () => process.exit(1));
socket.on('error', () => process.exit(1));
socket.on('connect', () => socket.write(JSON.stringify({ prompt: process.argv.slice(3).join(' ') }) + '\n'));
let buffer = '';
socket.on('data', chunk => {
  buffer += chunk.toString();
  if (buffer.length > 32768) process.exit(1);
  if (!buffer.includes('\n')) return;
  try {
    const { answer } = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
    if (typeof answer !== 'string') process.exit(1);
    process.stdout.write(answer + '\n', () => process.exit(0));
  } catch { process.exit(1); }
});
socket.on('end', () => { if (!buffer.includes('\n')) process.exit(1); });
