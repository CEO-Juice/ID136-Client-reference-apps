// Minimal console logging. Redirect output to a file from your scheduler if you want to keep it.
// PRODUCTION NOTE: use a real logging library (pino, winston) with log files that rotate, and alert
// on errors. Never log the settings object or request headers: they hold secrets.

function write(level, message) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
                `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  console.log(`${stamp} ${level} ${message}`);
}

export const log = {
  info: (message) => write('INFO ', message),
  warn: (message) => write('WARN ', message),
  error: (message) => write('ERROR', message),
};
