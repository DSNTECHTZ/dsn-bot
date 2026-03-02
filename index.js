require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { nanoid } = require('nanoid');
const { createWhatsApp } = require('./lib/whatsapp');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme_strong_secret';
const DB_FILE = process.env.PERSISTENT_DB || './data/db.json';

// rate limiter for public endpoints
const limiter = rateLimit({ windowMs: 30 * 1000, max: 10 });
app.use('/request-pair', limiter);

// ensure data dir
if (!fs.existsSync(path.dirname(DB_FILE))) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ pairRequests: [], pairs: [] }, null, 2));

function readDB() { return JSON.parse(fs.readFileSync(DB_FILE)); }
function writeDB(d) { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }

// start WhatsApp wrapper
const wa = createWhatsApp({ onQR: (dataUrl) => { latestQR = dataUrl; }, onConnection: (u) => console.log('wa update', u) });
let latestQR = null;

// Serve static UI
app.use('/', express.static(path.join(__dirname, 'public')));

// Public endpoint: request a pairing (visitor enters phone number)
// Body: { phone: "2557..." }
app.post('/request-pair', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    // normalize digits only
    const num = String(phone).replace(/[^0-9+]/g, '');
    if (!/^[0-9]{6,20}$/.test(num)) return res.status(400).json({ error: 'invalid phone format, start with country code (e.g., 255...)' });

    const db = readDB();
    const exists = db.pairRequests.find(p => p.phone === num && p.status === 'pending');
    if (exists) return res.json({ ok: true, note: 'Already pending' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const id = nanoid();
    db.pairRequests.push({ id, phone: num, code, status: 'pending', createdAt: new Date().toISOString() });
    writeDB(db);

    // Optionally notify admin via console / connected client
    console.log('New pair request:', { id, phone });

    res.json({ ok: true, id, note: 'Pair request created. Admin must approve it from the admin UI.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Admin: list pending pair requests (protected by ADMIN_SECRET header or body)
app.get('/admin/pairs', (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
  const db = readDB();
  res.json({ pairRequests: db.pairRequests, pairs: db.pairs, qr: latestQR });
});

// Admin endpoint: approve pair request -> send message to user with pair code
app.post('/admin/approve', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.body.secret;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  const db = readDB();
  const reqItem = db.pairRequests.find(p => p.id === id && p.status === 'pending');
  if (!reqItem) return res.status(404).json({ error: 'not found or already processed' });

  // send message via WhatsApp if bot is ready
  try {
    const jid = `${reqItem.phone}@s.whatsapp.net`;
    const text = `DSN BOT

Pair code: ${reqItem.code}

Reply with this code in WhatsApp to confirm pairing.`;
    await wa.sendMessage(jid, { text });
    // mark as 'sent'
    reqItem.status = 'sent';
    reqItem.sentAt = new Date().toISOString();
    writeDB(db);
    res.json({ ok: true });
  } catch (err) {
    console.error('send error', err);
    res.status(500).json({ error: 'send failed', details: String(err) });
  }
});

// Admin: finalize pairing when user replies with code (this endpoint can be called by webhook from incoming messages handler instead)
app.post('/admin/finalize', (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.body.secret;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });
  const db = readDB();
  const pending = db.pairRequests.find(p => p.phone === phone && p.code === code && (p.status === 'sent' || p.status === 'pending'));
  if (!pending) return res.status(404).json({ error: 'no matching pending request' });
  // create live pair
  db.pairs.push({ phone, jid: `${phone}@s.whatsapp.net`, createdAt: new Date().toISOString() });
  pending.status = 'paired';
  writeDB(db);
  res.json({ ok: true });
});

// public endpoint to get menu JSON
app.get('/menu', (req, res) => {
  const menu = [
    "1. Programming Tutorials (JavaScript, Python, PHP)",
    "2. Web Development (HTML/CSS/JS, frameworks)",
    "3. Mobile Apps (Flutter, React Native)",
    "4. Design & Media (Logo design, Video editing)",
    "5. Hosting & DevOps (GitHub, Render, Docker)",
    "6. Services & Contact"
  ];
  res.json({ botName: 'DSN BOT', menu });
});

// notify endpoint (admin) to push message to a paired number
app.post('/notify', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.body.secret;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  try {
    await wa.sendMessage(`${phone}@s.whatsapp.net`, { text: message });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'send failed', details: String(err) });
  }
});

app.listen(PORT, () => console.log(`DSN BOT listening on ${PORT}`));

