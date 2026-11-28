// Nightly export of everything the dialer holds (leads, calls, settings, AI scripts) to a
// gzipped JSON file, keeping the last 14. Runs at ~2am Jason's time. Also downloadable from
// the Settings tab. With Postgres storage this is a second copy; with file storage on a
// Railway Volume it is the only extra copy, so keep DIALER_BACKUP_DIR on the volume.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const store = require('./store');

const gzip = promisify(zlib.gzip);
const KEEP = 14;
const dir = () => process.env.DIALER_BACKUP_DIR || path.join(path.dirname(store.DATA_FILE), 'backups');
const tz = () => process.env.DIALER_USER_TZ || 'America/Chicago';
const day = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const hour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: 'numeric', hour12: false }).format(d)) % 24;

async function writeBackup() {
  fs.mkdirSync(dir(), { recursive: true });
  const buf = await gzip(Buffer.from(JSON.stringify(store.snapshot())));
  const file = path.join(dir(), 'dialer-backup-' + day() + '.json.gz');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  const old = fs.readdirSync(dir()).filter(f => /^dialer-backup-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort().reverse().slice(KEEP);
  for (const f of old) { try { fs.unlinkSync(path.join(dir(), f)); } catch {} }
  return { file, bytes: buf.length };
}

function latest() {
  try {
    const f = fs.readdirSync(dir()).filter(x => /^dialer-backup-.*\.json\.gz$/.test(x)).sort().pop();
    return f ? { file: f, at: fs.statSync(path.join(dir(), f)).mtime.toISOString() } : null;
  } catch { return null; }
}

function startNightly() {
  const tick = async () => {
    if (hour() < 2) return;                                  // 2am or later, once per local day
    const l = latest();
    if (l && l.file.includes(day())) return;
    try { const r = await writeBackup(); console.log('[dialer] nightly backup written: ' + r.file + ' (' + Math.round(r.bytes / 1024) + ' KB)'); }
    catch (e) { console.error('[dialer] nightly backup failed:', e.message); }
  };
  const t = setInterval(tick, 15 * 60 * 1000);
  if (t.unref) t.unref();
  setTimeout(tick, 60 * 1000).unref();                        // catch up soon after a restart
  return t;
}

module.exports = { writeBackup, latest, startNightly, dir };
