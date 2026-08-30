#!/usr/bin/env node
'use strict'

// Revelations Registry + Messaging server.
//
// A self-contained, zero-dependency Node service (uses only built-in modules)
// so it deploys to any host with Node — including a Hetzner box — with just
// `node registry-server.js`. State persists to a JSON file next to this script.
//
// Endpoints (all JSON):
//   POST /api/register  {username,name,email,phone,password}  -> {token,user}
//   POST /api/login     {username,password}                    -> {token,user}
//   GET  /api/users                                            -> [{username,name,online}]
//   GET  /api/network?username=                                -> [username,...]
//   POST /api/network   {token,username,add}                   -> [username,...]
//   GET  /api/messages?user=&peer=                             -> [{id,from,to,text,ts}]
//   POST /api/messages  {token,from,to,text}                   -> {ok,message}
//   POST /api/presence  {token,username}                       -> {ok}
//   GET  /api/health                                           -> {ok}

const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 8787
const DATA_FILE = process.env.REGISTRY_DATA || path.join(__dirname, 'registry-data.json')
const ONLINE_WINDOW_MS = 60 * 1000 // presence considered online within 60s

// ── Persistence ───────────────────────────────────────────────────────────────
let db = { users: {}, networks: {}, messages: [], presence: {}, nextMsgId: 1 }
try {
  if (fs.existsSync(DATA_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }
} catch (e) { console.error('Failed to load data file:', e.message) }

let saveTimer = null
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)) } catch (e) { console.error('save failed', e.message) }
  }, 200)
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const tokens = new Map() // token -> username
function hashPassword(salt, password) {
  return crypto.createHash('sha256').update(salt + password).digest('hex')
}
function issueToken(username) {
  const token = crypto.randomBytes(24).toString('hex')
  tokens.set(token, username)
  return token
}
function userOf(token) { return tokens.get(token) }
function publicUser(u) {
  return { username: u.username, name: u.name, email: u.email, online: isOnline(u.username) }
}
function isOnline(username) {
  const t = db.presence[username]
  return !!t && (Date.now() - t) < ONLINE_WINDOW_MS
}
function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  })
  res.end(body)
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
  })
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {})
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname
  try {
    if (p === '/api/health') return send(res, 200, { ok: true, users: Object.keys(db.users).length })

    if (p === '/api/register' && req.method === 'POST') {
      const b = await readBody(req)
      const username = String(b.username || '').trim().toLowerCase()
      if (username.length < 3) return send(res, 400, { error: 'Username too short' })
      if (!b.password || String(b.password).length < 6) return send(res, 400, { error: 'Password too short' })
      const existing = db.users[username]
      if (existing) {
        // Treat as login if the password matches; else reject.
        if (hashPassword(existing.salt, b.password) !== existing.hash) return send(res, 409, { error: 'Username taken' })
        const token = issueToken(username)
        return send(res, 200, { token, user: publicUser(existing) })
      }
      const salt = crypto.randomBytes(8).toString('hex')
      const user = {
        username, name: String(b.name || username).trim(), email: String(b.email || '').trim(),
        phone: String(b.phone || '').trim(), salt, hash: hashPassword(salt, b.password), createdAt: Date.now(),
      }
      db.users[username] = user
      db.networks[username] = db.networks[username] || []
      save()
      const token = issueToken(username)
      return send(res, 200, { token, user: publicUser(user) })
    }

    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req)
      const username = String(b.username || '').trim().toLowerCase()
      const user = db.users[username]
      if (!user || hashPassword(user.salt, b.password) !== user.hash) return send(res, 401, { error: 'Invalid credentials' })
      const token = issueToken(username)
      return send(res, 200, { token, user: publicUser(user) })
    }

    if (p === '/api/users' && req.method === 'GET') {
      return send(res, 200, Object.values(db.users).map(publicUser))
    }

    if (p === '/api/network' && req.method === 'GET') {
      const username = String(url.searchParams.get('username') || '').toLowerCase()
      return send(res, 200, db.networks[username] || [])
    }

    if (p === '/api/network' && req.method === 'POST') {
      const b = await readBody(req)
      const me = userOf(b.token)
      if (!me) return send(res, 401, { error: 'Not authenticated' })
      const add = String(b.add || '').trim().toLowerCase()
      if (!db.users[add]) return send(res, 404, { error: 'No such user' })
      db.networks[me] = db.networks[me] || []
      if (add !== me && !db.networks[me].includes(add)) db.networks[me].push(add)
      save()
      return send(res, 200, db.networks[me])
    }

    if (p === '/api/messages' && req.method === 'GET') {
      const user = String(url.searchParams.get('user') || '').toLowerCase()
      const peer = String(url.searchParams.get('peer') || '').toLowerCase()
      const msgs = db.messages.filter(
        (m) => (m.from === user && m.to === peer) || (m.from === peer && m.to === user)
      )
      return send(res, 200, msgs)
    }

    if (p === '/api/messages' && req.method === 'POST') {
      const b = await readBody(req)
      const me = userOf(b.token)
      if (!me) return send(res, 401, { error: 'Not authenticated' })
      const to = String(b.to || '').trim().toLowerCase()
      const text = String(b.text || '').slice(0, 4000)
      if (!db.users[to]) return send(res, 404, { error: 'No such recipient' })
      if (!text.trim()) return send(res, 400, { error: 'Empty message' })
      const message = { id: db.nextMsgId++, from: me, to, text, ts: Date.now() }
      db.messages.push(message)
      if (db.messages.length > 100000) db.messages = db.messages.slice(-100000)
      save()
      return send(res, 200, { ok: true, message })
    }

    if (p === '/api/presence' && req.method === 'POST') {
      const b = await readBody(req)
      const me = userOf(b.token)
      if (me) { db.presence[me] = Date.now(); save() }
      return send(res, 200, { ok: !!me })
    }

    return send(res, 404, { error: 'Not found' })
  } catch (e) {
    return send(res, 500, { error: e.message })
  }
})

server.listen(PORT, () => console.log(`Revelations Registry server on :${PORT} (data: ${DATA_FILE})`))
