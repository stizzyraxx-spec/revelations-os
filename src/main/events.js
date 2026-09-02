// Gatherings — believer-based event discovery.
//
// Every provider is optional and configured by the user in the Gatherings app;
// the renderer passes its config down per request so no credentials are ever
// written to disk by the main process. All network calls live here because the
// renderer is behind a CSP + CORS and cannot reach these APIs directly.
//
// Provider notes:
//   ticketmaster — free API key, real geo-radius search
//   serpapi      — paid key, Google Events aggregation (covers Eventbrite/Meetup)
//   eventbrite   — Eventbrite has NO public event-search API since 2020; a token
//                  only reaches organizers you name, so the user supplies both
//   ics          — any church .ics feed, works with no credentials at all

const { ipcMain, shell } = require('electron')

const UA = 'RevelationsOS/1.0 (+https://theconditionofman.com)'
const REQ_TIMEOUT = 12000

// ─── tiny helpers ────────────────────────────────────────────────────────────

async function req(url, opts = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeout || REQ_TIMEOUT)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return opts.text ? await res.text() : await res.json()
  } finally {
    clearTimeout(t)
  }
}

const _cache = new Map()
function cachePeek(key, ttlMs) {
  const hit = _cache.get(key)
  return hit && Date.now() - hit.at < ttlMs ? hit.val : null
}
function cached(key, ttlMs, fn) {
  const hit = cachePeek(key, ttlMs)
  if (hit) return hit
  const val = Promise.resolve(fn()).catch(err => { _cache.delete(key); throw err })
  _cache.set(key, { at: Date.now(), val })
  return val
}

// One search fans out to several upstream APIs, so the limit is on searches.
let _lastSearch = 0
function searchRateOk() {
  const now = Date.now()
  if (now - _lastSearch < 1500) return false
  _lastSearch = now
  return true
}

const clean = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

function toMi(km) { return km * 0.621371 }

function haversineMi(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLon = (b.lon - a.lon) * Math.PI / 180
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2)
  return Math.round(toMi(2 * R * Math.asin(Math.sqrt(h))) * 10) / 10
}

// ─── faith relevance ─────────────────────────────────────────────────────────
//
// Inclusion is positive-signal only: an event has to earn its score from
// Christian vocabulary to appear. That keeps the feed believer-based without
// maintaining a list of other faiths to reject. The block list is reserved for
// content that is plainly incompatible with the app (adult venues, occult).

const STRONG = [
  'worship service', 'worship night', 'praise and worship', 'bible study', 'bible school',
  'church', 'christian', 'christ', 'jesus', 'gospel', 'sermon', 'ministry', 'ministries',
  'prayer meeting', 'prayer night', 'revival', 'discipleship', 'evangelis', 'evangel',
  'baptism', 'communion', 'congregation', 'pastor', 'chapel', 'parish', 'crusade',
  'holy spirit', 'scripture', 'the word of god', 'faith-based', 'god\'s word',
]
const MEDIUM = [
  'worship', 'prayer', 'faith', 'devotional', 'testimony', 'psalm', 'apostolic',
  'pentecostal', 'baptist', 'methodist', 'lutheran', 'presbyterian', 'nondenominational',
  'non-denominational', 'catholic', 'orthodox', 'messianic', 'anointed', 'saints',
  'disciple', 'fellowship', 'youth group', 'vbs', 'small group',
]
const WEAK = [
  'kingdom', 'blessed', 'blessing', 'hymn', 'choir', 'praise', 'spiritual',
  'outreach', 'mission', 'retreat', 'conference', 'volunteer', 'community service',
]
const BLOCK = [
  'nightclub', 'night club', 'bar crawl', 'pub crawl', 'happy hour', 'casino',
  'burlesque', 'strip club', 'psychic', 'tarot', 'astrology', 'seance', 'occult',
  'witchcraft', 'ouija', 'adults only', '18+', '21+ only',
]

const TAG_RULES = [
  { tag: 'Worship',    words: ['worship', 'praise', 'hymn', 'choir', 'service'] },
  { tag: 'Bible Study',words: ['bible study', 'bible school', 'scripture', 'small group', 'devotional', 'study'] },
  { tag: 'Prayer',     words: ['prayer', 'intercession', 'vigil', 'fasting'] },
  { tag: 'Conference', words: ['conference', 'summit', 'convention', 'crusade', 'revival', 'retreat'] },
  { tag: 'Youth',      words: ['youth', 'teen', 'young adult', 'college', 'campus', 'vbs', 'kids'] },
  { tag: 'Music',      words: ['concert', 'gospel', 'tour', 'band', 'live music', 'worship night'] },
  { tag: 'Outreach',   words: ['outreach', 'mission', 'volunteer', 'food drive', 'serve', 'community service', 'donation'] },
  { tag: 'Family',     words: ['family', 'marriage', 'men\'s', 'women\'s', 'mens ', 'womens ', 'singles'] },
]

function countHits(hay, words) {
  let n = 0
  for (const w of words) if (hay.includes(w)) n++
  return n
}

// Title matches count double — an event named "Worship Night" is a stronger
// signal than one that merely mentions worship in paragraph four.
function scoreFaith(title, description, extra = '') {
  const t = ` ${clean(title).toLowerCase()} `
  const body = ` ${clean(`${title} ${description} ${extra}`).toLowerCase()} `
  if (BLOCK.some(w => body.includes(w))) return { score: -1, blocked: true, tags: [] }

  const score =
    countHits(t, STRONG) * 6 + countHits(body, STRONG) * 3 +
    countHits(t, MEDIUM) * 3 + countHits(body, MEDIUM) * 2 +
    countHits(body, WEAK) * 1

  const tags = TAG_RULES.filter(r => r.words.some(w => body.includes(w))).map(r => r.tag)
  return { score, blocked: false, tags }
}

// ─── geocoding (no API key) ──────────────────────────────────────────────────

async function geocode(query) {
  const q = String(query || '').trim()
  if (!q) throw new Error('Enter a city or ZIP code')
  return cached(`geo:${q.toLowerCase()}`, 24 * 3600 * 1000, async () => {
    if (/^\d{5}$/.test(q)) {
      const j = await req(`https://api.zippopotam.us/us/${q}`)
      const p = j.places && j.places[0]
      if (p) return {
        lat: parseFloat(p.latitude), lon: parseFloat(p.longitude),
        label: `${p['place name']}, ${p['state abbreviation']} ${q}`,
        city: p['place name'], region: p['state abbreviation'], country: 'US',
      }
    }
    const arr = await req(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`)
    const hit = Array.isArray(arr) && arr[0]
    if (!hit) throw new Error(`Could not find "${q}"`)
    return {
      lat: parseFloat(hit.lat), lon: parseFloat(hit.lon),
      label: hit.display_name.split(',').slice(0, 3).join(',').trim(),
      city: '', region: '', country: '',
    }
  })
}

// ─── date helpers ────────────────────────────────────────────────────────────

function iso(d) { return d instanceof Date && !isNaN(d) ? d.toISOString() : null }

function windowRange(range) {
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  const to = new Date(from)
  if (range === 'week') to.setDate(to.getDate() + 7)
  else if (range === 'month') to.setDate(to.getDate() + 31)
  else to.setDate(to.getDate() + 92)
  return { from, to }
}

// ─── provider: Ticketmaster Discovery ────────────────────────────────────────
// Several narrow keyword passes beat one broad query: Discovery ranks by
// popularity, so "christian" alone buries the small local worship nights.

const TM_QUERIES = [
  { keyword: 'worship' },
  { keyword: 'gospel' },
  { keyword: 'christian' },
  { keyword: 'church' },
  { classificationName: 'Religious' },
]

async function providerTicketmaster({ apiKey, center, radius, from, to }) {
  const out = []
  for (const q of TM_QUERIES) {
    const p = new URLSearchParams({
      apikey: apiKey,
      latlong: `${center.lat},${center.lon}`,
      radius: String(radius),
      unit: 'miles',
      size: '50',
      sort: 'date,asc',
      startDateTime: from.toISOString().slice(0, 19) + 'Z',
      endDateTime: to.toISOString().slice(0, 19) + 'Z',
      ...q,
    })
    let j
    try {
      j = await req(`https://app.ticketmaster.com/discovery/v2/events.json?${p}`)
    } catch { continue }
    for (const e of j?._embedded?.events || []) {
      const v = e._embedded?.venues?.[0]
      const price = e.priceRanges?.[0]
      out.push({
        id: `tm:${e.id}`,
        source: 'ticketmaster',
        title: e.name,
        description: clean(e.info || e.pleaseNote || e.description || ''),
        start: e.dates?.start?.dateTime || (e.dates?.start?.localDate
          ? `${e.dates.start.localDate}T${e.dates.start.localTime || '00:00:00'}` : null),
        end: null,
        url: e.url,
        image: (e.images || []).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null,
        organizer: e.promoter?.name || e._embedded?.attractions?.[0]?.name || '',
        priceText: price ? `$${Math.round(price.min)}${price.max > price.min ? `–$${Math.round(price.max)}` : ''}` : '',
        venue: v ? {
          name: v.name,
          address: [v.address?.line1, v.city?.name, v.state?.stateCode, v.postalCode].filter(Boolean).join(', '),
          lat: v.location ? parseFloat(v.location.latitude) : null,
          lon: v.location ? parseFloat(v.location.longitude) : null,
        } : null,
        classification: [e.classifications?.[0]?.segment?.name, e.classifications?.[0]?.genre?.name]
          .filter(Boolean).join(' / '),
      })
    }
  }
  return out
}

// ─── provider: SerpApi Google Events ─────────────────────────────────────────
// Google Events surfaces Eventbrite, Meetup and church websites, which is the
// only practical route to Eventbrite listings the user does not own.

const SERP_QUERIES = ['christian events', 'church events', 'worship night', 'bible study']

// Google returns human strings ("Sep 5", "Fri, Sep 5, 7 – 9 PM"), never ISO.
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
function parseGoogleWhen(startDate, when) {
  const src = `${startDate || ''} ${when || ''}`.toLowerCase()
  const m = src.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/)
  if (!m) return null
  const now = new Date()
  const month = MONTHS.indexOf(m[1])
  const day = parseInt(m[2], 10)
  const yearMatch = src.match(/\b(20\d{2})\b/)
  let year = yearMatch ? parseInt(yearMatch[1], 10) : now.getFullYear()
  // No year given and the date already passed → Google means next year.
  if (!yearMatch && new Date(year, month, day) < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year++
  // "7 – 9 PM" states the meridiem only once, at the end; take the start hour
  // but borrow the end's am/pm, or a lone "7 PM" when there is no range.
  const span = src.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*(am|pm)/)
  const lone = src.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/)
  const time = span
    ? { h: span[1], m: span[2], mer: span[3] || span[4] }
    : lone ? { h: lone[1], m: lone[2], mer: lone[3] } : null
  let hh = 0, mm = 0
  if (time) {
    hh = parseInt(time.h, 10) % 12
    mm = time.m ? parseInt(time.m, 10) : 0
    if (time.mer === 'pm') hh += 12
  }
  return iso(new Date(year, month, day, hh, mm))
}

async function providerSerpApi({ apiKey, locationLabel, from, to }) {
  const out = []
  for (const q of SERP_QUERIES) {
    const p = new URLSearchParams({
      engine: 'google_events',
      q: `${q} in ${locationLabel}`,
      api_key: apiKey,
      hl: 'en',
      gl: 'us',
    })
    let j
    try {
      j = await req(`https://serpapi.com/search.json?${p}`)
    } catch { continue }
    if (j?.error) throw new Error(j.error)
    for (const e of j.events_results || []) {
      const start = parseGoogleWhen(e.date?.start_date, e.date?.when)
      out.push({
        id: `serp:${e.link || e.title}:${e.date?.start_date || ''}`,
        source: 'google',
        title: e.title,
        description: clean(e.description || ''),
        start,
        whenText: e.date?.when || e.date?.start_date || '',
        end: null,
        url: e.link || e.ticket_info?.[0]?.link || '',
        image: e.thumbnail || e.image || null,
        organizer: (e.address || [])[0] || '',
        priceText: '',
        venue: e.venue || e.address ? {
          name: e.venue?.name || (e.address || [])[0] || '',
          address: (e.address || []).join(', '),
          lat: null, lon: null,
        } : null,
        // Every ticket vendor Google knows about — this is where Eventbrite shows up.
        vendors: (e.ticket_info || []).map(t => t.source).filter(Boolean),
      })
    }
  }
  // Google has no date filter here; trim to the requested window ourselves.
  return out.filter(e => !e.start || (new Date(e.start) >= from && new Date(e.start) <= to))
}

// ─── provider: Eventbrite (organizer-scoped) ─────────────────────────────────

async function providerEventbrite({ token, organizerIds, from, to }) {
  const out = []
  for (const rawId of organizerIds) {
    const id = String(rawId).trim()
    if (!id) continue
    let j
    try {
      j = await req(
        `https://www.eventbriteapi.com/v3/organizers/${encodeURIComponent(id)}/events/?status=live&order_by=start_asc&expand=venue`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
    } catch (err) {
      throw new Error(`Organizer ${id}: ${err.message}`)
    }
    for (const e of j.events || []) {
      const start = e.start?.utc || null
      if (start && (new Date(start) < from || new Date(start) > to)) continue
      const v = e.venue
      out.push({
        id: `eb:${e.id}`,
        source: 'eventbrite',
        title: e.name?.text || '',
        description: clean(e.summary || e.description?.text || ''),
        start,
        end: e.end?.utc || null,
        url: e.url,
        image: e.logo?.url || null,
        organizer: '',
        priceText: e.is_free ? 'Free' : '',
        venue: v ? {
          name: v.name || '',
          address: v.address?.localized_address_display || '',
          lat: v.latitude ? parseFloat(v.latitude) : null,
          lon: v.longitude ? parseFloat(v.longitude) : null,
        } : null,
      })
    }
  }
  return out
}

// ─── provider: ICS feeds ─────────────────────────────────────────────────────

function unescapeIcs(s) {
  return String(s || '')
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim()
}

function parseIcsDate(value, params) {
  const v = String(value || '').trim()
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (dateOnly) {
    return { iso: iso(new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3])), allDay: true }
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v)
  if (!dt) return { iso: null, allDay: false }
  const [, y, mo, d, h, mi, s, z] = dt
  // A TZID we cannot resolve is treated as local wall time — the same thing the
  // user sees printed on the church's own calendar.
  const date = z
    ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))
    : new Date(+y, +mo - 1, +d, +h, +mi, +s)
  return { iso: iso(date), allDay: false, tz: params?.TZID || null }
}

function parseIcs(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  // RFC 5545 line folding: a leading space/tab continues the previous line.
  const unfolded = []
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) unfolded[unfolded.length - 1] += line.slice(1)
    else unfolded.push(line)
  }
  const events = []
  let cur = null
  for (const line of unfolded) {
    if (line.startsWith('BEGIN:VEVENT')) { cur = {}; continue }
    if (line.startsWith('END:VEVENT')) { if (cur) events.push(cur); cur = null; continue }
    if (!cur) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const rawKey = line.slice(0, idx)
    const value = line.slice(idx + 1)
    const [key, ...paramParts] = rawKey.split(';')
    const params = {}
    for (const p of paramParts) {
      const eq = p.indexOf('=')
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1)
    }
    switch (key.toUpperCase()) {
      case 'UID': cur.uid = value; break
      case 'SUMMARY': cur.summary = unescapeIcs(value); break
      case 'DESCRIPTION': cur.description = unescapeIcs(value); break
      case 'LOCATION': cur.location = unescapeIcs(value); break
      case 'URL': cur.url = value; break
      case 'DTSTART': { const r = parseIcsDate(value, params); cur.start = r.iso; cur.allDay = r.allDay; break }
      case 'DTEND': cur.end = parseIcsDate(value, params).iso; break
      case 'RRULE': cur.rrule = value; break
    }
  }
  return events
}

// Weekly/daily recurrence is the whole point of a church calendar, so expand
// the two simple cases into the search window. Anything more exotic is left as
// its single original occurrence rather than guessed at.
function expandRecurring(ev, from, to) {
  if (!ev.start || !ev.rrule) return [ev]
  const freq = /FREQ=(\w+)/.exec(ev.rrule)?.[1]
  if (freq !== 'WEEKLY' && freq !== 'DAILY') return [ev]
  const interval = parseInt(/INTERVAL=(\d+)/.exec(ev.rrule)?.[1] || '1', 10)
  const untilRaw = /UNTIL=(\d{8})/.exec(ev.rrule)?.[1]
  const until = untilRaw
    ? new Date(+untilRaw.slice(0, 4), +untilRaw.slice(4, 6) - 1, +untilRaw.slice(6, 8))
    : to
  const stepDays = (freq === 'WEEKLY' ? 7 : 1) * interval
  const out = []
  const cursor = new Date(ev.start)
  const limit = until < to ? until : to
  let guard = 0
  while (cursor <= limit && guard++ < 400) {
    if (cursor >= from) out.push({ ...ev, start: iso(new Date(cursor)), end: null, recurring: true })
    cursor.setDate(cursor.getDate() + stepDays)
  }
  return out.length ? out : [ev]
}

async function providerIcs({ feeds, from, to }) {
  const out = []
  for (const feed of feeds) {
    const url = typeof feed === 'string' ? feed : feed.url
    const label = (typeof feed === 'object' && feed.label) || 'Church calendar'
    if (!url) continue
    let text
    try {
      text = await req(url.replace(/^webcal:/i, 'https:'), { text: true })
    } catch (err) {
      throw new Error(`${label}: ${err.message}`)
    }
    for (const raw of parseIcs(text)) {
      for (const ev of expandRecurring(raw, from, to)) {
        if (!ev.start) continue
        const d = new Date(ev.start)
        if (d < from || d > to) continue
        out.push({
          id: `ics:${label}:${ev.uid || ev.summary}:${ev.start}`,
          source: 'ics',
          title: ev.summary || 'Untitled',
          description: ev.description || '',
          start: ev.start,
          end: ev.end,
          url: ev.url || '',
          image: null,
          organizer: label,
          priceText: '',
          allDay: !!ev.allDay,
          recurring: !!ev.recurring,
          venue: ev.location ? { name: ev.location, address: ev.location, lat: null, lon: null } : null,
          // A feed the user subscribed to is trusted — it is their church.
          trusted: true,
        })
      }
    }
  }
  return out
}

// ─── merge / filter ──────────────────────────────────────────────────────────

const dedupeKey = (e) =>
  `${clean(e.title).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)}|${(e.start || e.whenText || '').slice(0, 10)}`

const SOURCE_RANK = { ics: 0, eventbrite: 1, ticketmaster: 2, google: 3 }

function mergeEvents(lists) {
  const byKey = new Map()
  for (const e of lists.flat()) {
    const k = dedupeKey(e)
    const prev = byKey.get(k)
    if (!prev) { byKey.set(k, e); continue }
    // Same event from two providers: keep the richer record, remember both.
    const keep = SOURCE_RANK[e.source] < SOURCE_RANK[prev.source] ? e : prev
    const drop = keep === e ? prev : e
    keep.alsoOn = [...new Set([...(keep.alsoOn || []), ...(drop.alsoOn || []), drop.source])]
    if (!keep.image && drop.image) keep.image = drop.image
    if (!keep.url && drop.url) keep.url = drop.url
    if (!keep.description && drop.description) keep.description = drop.description
    byKey.set(k, keep)
  }
  return [...byKey.values()]
}

const THRESHOLDS = { strict: 9, balanced: 5, broad: 3 }

function finalize(events, { center, radius, strictness }) {
  const min = THRESHOLDS[strictness] ?? THRESHOLDS.balanced
  const out = []
  for (const e of events) {
    const { score, blocked, tags } = scoreFaith(
      e.title, e.description, `${e.organizer || ''} ${e.classification || ''} ${e.venue?.name || ''}`
    )
    if (blocked) continue
    // Feeds the user added themselves are already believer-based; a church's
    // "Pancake Breakfast" should not be filtered out for lacking keywords.
    if (!e.trusted && score < min) continue

    const distance = e.venue ? haversineMi(center, e.venue) : null
    if (distance != null && distance > radius * 1.25) continue

    out.push({ ...e, faithScore: e.trusted ? Math.max(score, min) : score, tags, distance })
  }
  out.sort((a, b) => {
    if (a.start && b.start) return new Date(a.start) - new Date(b.start)
    if (a.start) return -1
    if (b.start) return 1
    return b.faithScore - a.faithScore
  })
  return out
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

async function runSearch(params = {}) {
  const {
    location = '',
    radius = 25,
    range = 'month',
    strictness = 'balanced',
    config = {},
  } = params

  const center = await geocode(location)
  const { from, to } = windowRange(range)
  const rad = Math.min(500, Math.max(1, Number(radius) || 25))

  const jobs = []
  const sources = []

  if (config.ticketmasterKey) {
    sources.push('ticketmaster')
    jobs.push(providerTicketmaster({ apiKey: config.ticketmasterKey, center, radius: rad, from, to }))
  }
  if (config.serpApiKey) {
    sources.push('google')
    jobs.push(providerSerpApi({ apiKey: config.serpApiKey, locationLabel: center.label, from, to }))
  }
  if (config.eventbriteToken && (config.eventbriteOrganizers || []).length) {
    sources.push('eventbrite')
    jobs.push(providerEventbrite({
      token: config.eventbriteToken,
      organizerIds: config.eventbriteOrganizers,
      from, to,
    }))
  }
  if ((config.icsFeeds || []).length) {
    sources.push('ics')
    jobs.push(providerIcs({ feeds: config.icsFeeds, from, to }))
  }

  if (!jobs.length) {
    return { ok: false, reason: 'no-sources', center, events: [], providers: [] }
  }

  const settled = await Promise.allSettled(jobs)
  const providers = settled.map((r, i) => ({
    source: sources[i],
    ok: r.status === 'fulfilled',
    count: r.status === 'fulfilled' ? r.value.length : 0,
    error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : null,
  }))
  const raw = settled.filter(r => r.status === 'fulfilled').map(r => r.value)

  return {
    ok: true,
    center,
    range: { from: iso(from), to: iso(to) },
    providers,
    events: finalize(mergeEvents(raw), { center, radius: rad, strictness }),
  }
}

function registerEventsIpc() {
  ipcMain.handle('events:geocode', async (_e, location) => {
    try { return { ok: true, ...(await geocode(location)) } }
    catch (err) { return { ok: false, error: String(err.message || err) } }
  })

  ipcMain.handle('events:search', async (_e, params) => {
    const key = `search:${JSON.stringify({
      l: params?.location, r: params?.radius, g: params?.range, s: params?.strictness,
      c: Object.keys(params?.config || {}).length,
      f: (params?.config?.icsFeeds || []).length,
      o: (params?.config?.eventbriteOrganizers || []).length,
    })}`
    const TTL = 10 * 60 * 1000
    // Only throttle searches that would actually hit the network — repeating a
    // search already in cache (or in flight) costs nothing and should just work.
    const hit = cachePeek(key, TTL)
    if (!hit && !searchRateOk()) {
      return { ok: false, reason: 'rate-limited', error: 'One moment — searching again too quickly', events: [], providers: [] }
    }
    try {
      return await cached(key, TTL, () => runSearch(params))
    } catch (err) {
      return { ok: false, error: String(err.message || err), events: [], providers: [] }
    }
  })

  ipcMain.handle('events:openExternal', async (_e, url) => {
    const u = String(url || '')
    if (!/^https:\/\//i.test(u)) return { ok: false, error: 'Only https links can be opened' }
    await shell.openExternal(u)
    return { ok: true }
  })
}

module.exports = { registerEventsIpc, scoreFaith, parseIcs, parseGoogleWhen, haversineMi }
