// ─── Logger estruturado com nível e timestamp ───
// Substitui console.log/error espalhados pelo projeto

const LEVELS = { info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' };

function log(level, message, data) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${LEVELS[level] || level.toUpperCase()}]`;
  if (data !== undefined) {
    const extra = typeof data === 'object' ? JSON.stringify(data) : data;
    console.log(`${prefix} ${message} ${extra}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

module.exports = {
  info:  (msg, data) => log('info',  msg, data),
  warn:  (msg, data) => log('warn',  msg, data),
  error: (msg, data) => log('error', msg, data),
  debug: (msg, data) => log('debug', msg, data),
};
