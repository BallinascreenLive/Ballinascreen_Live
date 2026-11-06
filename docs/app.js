/* Ballinascreen GAC (Naomh Colm): fixtures, results and live scores.
 *
 * Fixtures & results: data/fixtures.js, refreshed from Derry GAA (Club & County) by the
 *   "Refresh fixtures" GitHub Action.
 * Live scores, club-added games and scorer logins: Firebase (firebase-config.js).
 *   With no Firebase config the site runs in demo mode, where live scores are
 *   saved only on the device being used.
 */
(function () {
  'use strict';

  // ---------- Things you might want to change ----------
  const CLUB_RE = /\b(ballinascreen|baile na scr[ií]ne|naomh colm)\b/i;   // team names that are us
  const CLUB_SHORT = 'Ballinascreen';
  const HOME_VENUE = "St Colm's Ballinascreen";
  const COUNTY = 'Co. Derry';
  const DEFAULT_SOURCE = 'https://derry.clubandcounty.com/fixtures-results/';
  // Venue names that map apps don't recognise, and what to search for instead.
  const VENUE_ALIASES = {
    "St Colm's Ballinascreen": 'Ballinascreen GAC, Draperstown',
    'Ballinascreen': 'Ballinascreen GAC, Draperstown',
    'Owenbeg': 'Owenbeg Derry GAA Centre of Excellence, Dungiven',
    'Glen': 'Watty Graham Park, Maghera',
    'Celtic Park': 'Celtic Park, Derry',
  };
  const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';

  // Team chips: football, then ladies, hurling, camogie; adults before under-age, oldest age first.
  const CODE_ORDER = ['', 'Ladies', 'Hurling', 'Camogie'];
  function gradeRank(g) {
    const m = /^(Ladies|Hurling|Camogie)?\s*(.*)$/.exec(g || '');
    const code = CODE_ORDER.indexOf(m[1] || '');
    const rest = m[2];
    const age = /U(\d+)/.exec(rest);
    const tier = age ? 100 - +age[1] : /Reserve/.test(rest) ? 1 : 0;
    return [code < 0 ? 9 : code, tier, rest];
  }
  // Hurling and camogie have no 2-point score.
  const scoreTypes = (m) => (/^(Hurling|Camogie)/.test((m && m.grade) || '') ? ['one', 'goal'] : ['one', 'two', 'goal']);
  const STATUS = { pre: 'Not started', h1: 'First half', ht: 'Half-time', h2: 'Second half', et: 'Extra time', ft: 'Full-time' };
  const IN_PLAY = ['h1', 'ht', 'h2', 'et'];
  const TYPES = {
    one: { pts: 1, label: 'Point', name: 'Point' },
    two: { pts: 2, label: '2 points', name: '2-pointer' },
    goal: { pts: 3, label: 'Goal', name: 'Goal' },
  };

  const S = {
    feed: { matches: [], calendars: [], updated: null },
    feedState: 'loading',          // loading | ok | failed
    games: [], live: {}, pending: {}, pendingSince: {},
    me: null, users: [], ownerExists: true, ownerUid: null,
    tab: 'fixtures', grade: 'All', resultsLimit: 25,
    dlg: null, store: null, unsubUsers: null,
  };

  // ---------- Small helpers ----------
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const isUs = (name) => CLUB_RE.test(String(name || ''));
  const nice = (name) => (isUs(name) ? CLUB_SHORT : name);
  const teamHTML = (name) => (isUs(name) ? `<span class="us">${CLUB_SHORT}</span>` : esc(name));
  const tsMs = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : typeof t === 'number' ? t : 0);

  const ICON = {
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5" fill="currentColor"/></svg>',
    cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  const flag = (type) => `<svg class="flag-ico f-${type}" viewBox="0 0 24 24" aria-hidden="true"><line x1="5" y1="2.5" x2="5" y2="21.5"/><rect x="6" y="3" width="14" height="10" rx="1"/></svg>`;

  // Dates are handled as Irish/UK local dates (YYYY-MM-DD).
  const LDN = 'Europe/London';
  function todayISO() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: LDN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function addDays(iso, n) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function fmtDay(iso, long) {
    const t = todayISO();
    if (iso === t) return 'Today';
    if (iso === addDays(t, 1)) return 'Tomorrow';
    if (iso === addDays(t, -1)) return 'Yesterday';
    const o = long ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'short', day: 'numeric', month: 'short' };
    if (iso.slice(0, 4) !== t.slice(0, 4)) o.year = 'numeric';
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', Object.assign(o, { timeZone: 'UTC' })).replace(',', '');
  }
  function fmtTime(t) {
    if (!t) return 'TBC';
    const [h, m] = t.split(':').map(Number);
    return (h % 12 || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + (h >= 12 ? 'pm' : 'am');
  }
  function fmtClock(ms) {
    const s = new Date(ms).toLocaleTimeString('en-GB', { timeZone: LDN, hour: 'numeric', minute: '2-digit', hour12: true });
    return s.replace(/\s/g, '').toLowerCase();
  }
  function fmtStamp(ms) {
    const iso = new Intl.DateTimeFormat('en-CA', { timeZone: LDN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    return fmtDay(iso) + ' at ' + fmtClock(ms);
  }
  function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 45) return 'updated just now';
    if (s < 3600) return 'updated ' + Math.round(s / 60) + ' min ago';
    if (s < 86400) return 'updated ' + Math.round(s / 3600) + ' hr ago';
    return 'updated ' + fmtStamp(ms);
  }

  // GAA scores: goals-points, where points include 2-pointers.
  function parseScore(s) {
    const m = /^(\d+)-(\d+)$/.exec(s || '');
    if (!m) return null;
    const g = +m[1], p = +m[2];
    return { g, p, total: g * 3 + p };
  }
  function tallyOf(doc) {
    const t = { home: { goal: 0, two: 0, one: 0 }, away: { goal: 0, two: 0, one: 0 } };
    ((doc && doc.events) || []).forEach((e) => { if (t[e.team] && e.type in t[e.team]) t[e.team][e.type]++; });
    ['home', 'away'].forEach((k) => { const x = t[k]; x.g = x.goal; x.p = x.one + 2 * x.two; x.total = 3 * x.g + x.p; });
    return t;
  }
  const gp = (x) => x.g + '-' + x.p;
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2400);
  }
  function errText(e) {
    const c = (e && e.code) || '';
    if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return "That email and password don't match a scorer login.";
    if (/invalid-email/.test(c)) return 'That email address looks wrong.';
    if (/too-many-requests/.test(c)) return 'Too many tries. Wait a few minutes or reset your password.';
    if (/network-request-failed|unavailable/.test(c)) return 'No connection. Check your signal and try again.';
    if (/weak-password/.test(c)) return 'Choose a password of at least 8 characters.';
    if (/permission-denied/.test(c)) return "Your login doesn't have permission to do that. Ask a club admin.";
    if (/email-already-in-use/.test(c)) return 'That email already has a login.';
    return (e && e.message) || 'Something went wrong. Try again.';
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove(); return ok;
    }
  }
  function siteBase() {
    return /^https?:$/.test(location.protocol) ? location.origin + location.pathname.replace(/[^/]*$/, '') : null;
  }

  // ---------- Matches ----------
  const byWhen = (a, b) => (a.date + (a.time || '99:99') + a.id).localeCompare(b.date + (b.time || '99:99') + b.id);

  // A game is treated as over two hours after throw-in, even before the official result is posted.
  function nowMinutes() {
    const [h, mi] = new Intl.DateTimeFormat('en-GB', { timeZone: LDN, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date()).split(':').map(Number);
    return h * 60 + mi;
  }
  function over(m, t) {
    if (m.date < t) return true;
    if (m.date > t || !m.time) return false;
    const [h, mi] = m.time.split(':').map(Number);
    return nowMinutes() > h * 60 + mi + 120;
  }
  function allMatches() {
    const t = todayISO();
    const feed = S.feed.matches.map((m) => Object.assign({}, m, {
      source: 'feed',
      status: m.status === 'fixture' && over(m, t) ? 'awaiting' : m.status,
    }));
    const club = S.games.map((g) => ({
      id: 'club-' + g.id, gameId: g.id, source: 'club',
      date: g.date, time: g.time || null,
      competition: g.competition || 'Club game', round: '', grade: g.grade || 'Seniors',
      home: g.home, away: g.away, venue: g.venue || 'TBC', referee: '', stream: null,
      status: over({ date: g.date, time: g.time }, t) ? 'awaiting' : 'fixture', homeScore: null, awayScore: null, concededBy: null,
      us: isUs(g.home) ? 'home' : 'away',
    }));
    return feed.concat(club).sort(byWhen);
  }
  function findMatch(id) {
    const m = allMatches().find((x) => x.id === id);
    if (m) return m;
    const l = S.live[id];
    if (!l) return null;
    return {
      id, source: 'live', date: l.date, time: l.time || null, competition: l.competition || '', round: l.round || '',
      grade: l.grade || '', home: l.home, away: l.away, venue: l.venue || 'TBC', referee: '', stream: null,
      status: 'awaiting', us: isUs(l.home) ? 'home' : 'away',
    };
  }
  const inGrade = (m) => S.grade === 'All' || m.grade === S.grade;
  const compText = (m) => [m.competition, m.round].filter(Boolean).join(', ').replace(/\s+-\s+/g, ', ');
  const venueText = (m) => (!m.venue || m.venue === 'TBC' ? 'Venue to be confirmed' : m.venue);
  function dirUrl(venue) {
    const q = VENUE_ALIASES[venue] || (/county|co\./i.test(venue) ? venue : venue + ', ' + COUNTY);
    return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(q);
  }
  function liveInfo(m) {
    return { date: m.date, time: m.time || null, competition: m.competition || '', round: m.round || '', grade: m.grade || '', home: m.home, away: m.away, venue: m.venue || 'TBC' };
  }
  const canScore = () => !!(S.store && S.me && (S.me.role === 'scorer' || S.me.role === 'admin'));
  const isAdmin = () => !!(S.store && S.me && S.me.role === 'admin');
  // Scorers can open scoring for games today or yesterday (the demo allows the coming week, to practise).
  const scoreable = (m) => m.date >= addDays(todayISO(), -1) &&
    m.date <= addDays(todayISO(), S.store && S.store.mode === 'demo' ? 7 : 0);
  function gradesPresent() {
    const set = new Set(allMatches().map((m) => m.grade).filter(Boolean));
    return [...set].sort((a, b) => {
      const ra = gradeRank(a), rb = gradeRank(b);
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2]);
    });
  }

  // ---------- Calendar ----------
  const VTZ = ['BEGIN:VTIMEZONE', 'TZID:Europe/London', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'TZNAME:BST',
    'DTSTART:19700329T010000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0000', 'TZNAME:GMT', 'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];
  const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  function wallTimes(m) {
    const pad = (n) => String(n).padStart(2, '0');
    const f = (x) => `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}00`;
    if (!m.time) return { allDay: true, start: m.date.replace(/-/g, ''), end: addDays(m.date, 1).replace(/-/g, '') };
    const [h, mi] = m.time.split(':').map(Number);
    const s = new Date(Date.UTC(+m.date.slice(0, 4), +m.date.slice(5, 7) - 1, +m.date.slice(8, 10), h, mi));
    const e = new Date(s.getTime() + (/Seniors|Reserves/.test(m.grade) ? 105 : 90) * 60000);
    return { allDay: false, start: f(s), end: f(e) };
  }
  const eventTitle = (m) => `${m.grade ? m.grade + ': ' : ''}${nice(m.home)} v ${nice(m.away)}`;
  function eventDetails(m) {
    const bits = [compText(m)];
    if (m.stream) bits.push('Live on ' + m.stream);
    const base = siteBase();
    if (base) bits.push(base);
    return bits.filter(Boolean).join('\n');
  }
  function icsFor(m) {
    const w = wallTimes(m);
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', "PRODID:-//Ballinascreen GAC//Fixtures//EN", 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']
      .concat(w.allDay ? [] : VTZ)
      .concat(['BEGIN:VEVENT', `UID:${m.id}@ballinascreen-gac`, 'DTSTAMP:' + now,
        w.allDay ? `DTSTART;VALUE=DATE:${w.start}` : `DTSTART;TZID=Europe/London:${w.start}`,
        w.allDay ? `DTEND;VALUE=DATE:${w.end}` : `DTEND;TZID=Europe/London:${w.end}`,
        'SUMMARY:' + icsText(eventTitle(m)),
        'LOCATION:' + icsText(m.venue === 'TBC' ? '' : m.venue),
        'DESCRIPTION:' + icsText(eventDetails(m)),
        'END:VEVENT', 'END:VCALENDAR']);
    // Calendar files want lines of at most 75 bytes; longer ones continue after a space.
    const enc = new TextEncoder();
    const fold = (ln) => {
      const out = []; let cur = '';
      for (const ch of ln) {
        if (enc.encode(cur + ch).length > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
      }
      out.push(cur);
      return out.join('\r\n');
    };
    return lines.map(fold).join('\r\n') + '\r\n';
  }
  function downloadIcs(m) {
    const a = document.createElement('a');
    a.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(icsFor(m));
    a.download = `ballinascreen-${m.date}-${slug(nice(m.us === 'home' ? m.away : m.home))}.ics`;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function gcalUrl(m) {
    const w = wallTimes(m);
    const p = new URLSearchParams({ action: 'TEMPLATE', text: eventTitle(m), dates: w.start + '/' + w.end, details: eventDetails(m), ctz: LDN });
    if (m.venue && m.venue !== 'TBC') p.set('location', m.venue);
    return 'https://calendar.google.com/calendar/render?' + p.toString();
  }

  // ---------- Pieces of page ----------
  function tallyHTML(x, m) {
    const two = scoreTypes(m).includes('two');
    const said = [plural(x.goal, 'goal', 'goals')].concat(two ? [plural(x.two, 'two-pointer', 'two-pointers')] : [])
      .concat([plural(x.one, 'point', 'points')]).join(', ');
    return `<p class="tally"><span class="sr">${said}</span><span aria-hidden="true">${flag('goal')}${x.goal}</span>` +
      (two ? `<span aria-hidden="true">${flag('two')}${x.two}</span>` : '') +
      `<span aria-hidden="true">${flag('one')}${x.one}</span></p>`;
  }
  function boardHTML(m, o) {
    o = o || {};
    const l = S.live[m.id];
    const t = tallyOf(l);
    const st = (l && l.status) || 'pre';
    const pulsing = IN_PLAY.includes(st) && st !== 'ht';
    const status = l ? STATUS[st] : m.date === todayISO() ? 'Throw-in ' + fmtTime(m.time) : fmtDay(m.date) + ', ' + fmtTime(m.time);
    const upd = l ? tsMs(l.updatedAt) : 0;
    const side = (k) => `<div><p class="side-name">${esc(nice(m[k]))}</p><p class="side-score">${gp(t[k])}</p>` +
      `<p class="side-total">${plural(t[k].total, 'point', 'points')} in total</p>${o.mini ? '' : tallyHTML(t[k], m)}</div>`;
    const inner = `<p class="board-status"><span class="dot${pulsing ? ' on' : ''}"></span>${esc(status)}` +
      `${upd ? `<span class="ago" data-ago="${upd}">${esc(ago(upd))}</span>` : ''}</p>` +
      `<div class="board-sides">${side('home')}${side('away')}</div>${o.hint ? `<p class="board-hint">${esc(o.hint)}</p>` : ''}`;
    const cls = 'board' + (o.mini ? ' mini' : '');
    return o.link
      ? `<a class="${cls}" href="#m=${encodeURIComponent(m.id)}" aria-label="Live score, ${esc(nice(m.home))} v ${esc(nice(m.away))}">${inner}</a>`
      : `<div class="${cls}">${inner}</div>`;
  }
  function actionButtons(m, hero) {
    const small = hero ? '' : ' btn-small';
    const b = [];
    const l = S.live[m.id];
    if (l || (scoreable(m) && m.date === todayISO()) || (canScore() && scoreable(m))) {
      b.push(`<a class="btn btn-solid${small}" href="#m=${encodeURIComponent(m.id)}">${canScore() ? 'Score live' : 'Follow live'}</a>`);
    }
    if (m.venue && m.venue !== 'TBC') {
      b.push(`<a class="btn${small}${hero && !b.length ? ' btn-solid' : ''}" href="${dirUrl(m.venue)}" target="_blank" rel="noopener">${ICON.pin}Directions</a>`);
    }
    b.push(`<button class="btn${small}" type="button" data-act="cal" data-id="${esc(m.id)}">${ICON.cal}Add to calendar</button>`);
    if (m.source === 'club' && canScore()) {
      b.push(`<button class="btn btn-small btn-plain" type="button" data-act="del-game" data-id="${esc(m.gameId)}">Remove</button>`);
    }
    return b.join('');
  }

  function renderHero() {
    const el = $('#hero');
    if (S.feedState === 'loading') { el.innerHTML = ''; return; }
    const playing = Object.keys(S.live).filter((id) => IN_PLAY.includes(S.live[id].status)).map(findMatch).filter(Boolean);
    if (playing.length) {
      el.innerHTML = `<h2>Live now</h2>` + playing.map((m) => `<div class="hero-live">${boardHTML(m, { link: true, hint: 'Tap for every score' })}</div>`).join('');
      return;
    }
    const t = todayISO();
    const next = allMatches().find((m) => inGrade(m) && m.status === 'fixture' && m.date >= t && !(S.live[m.id] && S.live[m.id].status === 'ft'));
    const heading = S.grade === 'All' ? 'Next game' : `Next ${S.grade} game`;
    if (!next) {
      el.innerHTML = `<h2>${esc(heading)}</h2><p class="hero-meta">Nothing listed yet. New fixtures show up here as soon as Derry GAA publishes them.</p>`;
      return;
    }
    const when = fmtDay(next.date, true) + (next.time ? ', ' + fmtTime(next.time) : ', time TBC');
    el.innerHTML = `<h2>${esc(heading)}</h2>
      <p class="hero-when">${esc(when)}</p>
      <p class="hero-teams">${esc(next.grade)}: ${teamHTML(next.home)} v ${teamHTML(next.away)}</p>
      <p class="hero-meta">${esc(compText(next))}</p>
      <p class="hero-meta">${esc(venueText(next))}</p>
      ${next.stream ? `<p class="hero-stream">Live on ${esc(next.stream)}</p>` : ''}
      <div class="actions">${actionButtons(next, true)}</div>`;
  }

  function renderTabs() {
    document.querySelectorAll('[role="tab"]').forEach((b) => {
      const on = b.dataset.tab === S.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $('#panel').setAttribute('aria-labelledby', 'tab-' + S.tab);
    $('#liveDot').hidden = !Object.values(S.live).some((l) => IN_PLAY.includes(l.status));
  }
  function renderGrades() {
    const gs = gradesPresent();
    if (S.grade !== 'All' && !gs.includes(S.grade) && S.feedState === 'ok') S.grade = 'All';
    $('#grades').innerHTML = ['All'].concat(gs).map((g) =>
      `<button type="button" data-grade="${esc(g)}" aria-pressed="${g === S.grade}">${g === 'All' ? 'All teams' : esc(g)}</button>`).join('');
  }

  function fixtureRow(m) {
    const l = S.live[m.id];
    return `<article class="game">
      <div><div class="game-time">${esc(fmtTime(m.time))}</div><span class="grade-tag">${esc(m.grade)}</span></div>
      <div>
        <p class="game-teams">${teamHTML(m.home)} v ${teamHTML(m.away)}</p>
        <p class="game-comp">${esc(compText(m))}${m.source === 'club' ? ' <span class="club-tag">(added by the club)</span>' : ''}</p>
        <p class="game-venue">${esc(venueText(m))}</p>
        ${m.stream ? `<p class="game-note">Live on ${esc(m.stream)}</p>` : ''}
        ${l ? boardHTML(m, { mini: true, link: true }) : ''}
        <div class="actions">${actionButtons(m)}</div>
      </div>
    </article>`;
  }
  function groupByDate(list) {
    const out = [];
    list.forEach((m) => {
      const last = out[out.length - 1];
      if (last && last[0] === m.date) last[1].push(m); else out.push([m.date, [m]]);
    });
    return out;
  }
  function renderFixtures() {
    const t = todayISO();
    const list = allMatches().filter((m) => inGrade(m) && m.status === 'fixture' && m.date >= t);
    if (!list.length) {
      return `<div class="empty"><p><b>No ${S.grade === 'All' ? '' : esc(S.grade) + ' '}fixtures listed right now.</b></p>
        <p>Derry GAA usually publishes games a week or two ahead. This page checks for new ones every couple of hours.</p>
        <div class="actions"><button class="btn btn-small" type="button" data-act="subscribe">${ICON.cal}Get fixtures in your calendar</button></div></div>`;
    }
    return groupByDate(list).map(([d, ms]) => `<div class="day"><h3>${esc(fmtDay(d, true))}</h3>${ms.map(fixtureRow).join('')}</div>`).join('') +
      `<p class="note more">Derry GAA lists the next few games for each club. Later fixtures appear here as they're published.</p>`;
  }

  function resultRow(m) {
    let hs = parseScore(m.homeScore), as = parseScore(m.awayScore), byClub = false;
    const l = S.live[m.id];
    if ((!hs || !as) && l && (l.events || []).length) { const t = tallyOf(l); hs = t.home; as = t.away; byClub = true; }
    const opp = m.us === 'home' ? m.away : m.home;
    let foot;
    if (m.status === 'conceded') {
      foot = m.concededBy === m.us ? `<span class="lost">Conceded by ${CLUB_SHORT}</span>` : `<span class="won">Walkover</span>, ${esc(opp)} conceded`;
    } else if (hs && as) {
      const ours = m.us === 'home' ? hs : as, theirs = m.us === 'home' ? as : hs;
      const d = ours.total - theirs.total;
      foot = d > 0 ? `<span class="won">Won by ${d}</span>` : d < 0 ? `<span class="lost">Lost by ${-d}</span>` : '<span class="drew">Draw</span>';
      if (byClub) foot += l.status === 'ft' ? ", club scorer's final score" : `, ${esc(STATUS[l.status] || 'in progress').toLowerCase()} (live)`;
    } else {
      foot = 'Result not posted yet';
    }
    const line = (k, x) => `<div class="res-line"><p class="res-team">${teamHTML(m[k])}</p>` +
      (x ? `<p class="res-score">${gp(x)} <small>(${x.total})</small></p>` : '') + '</div>';
    const body = `<article class="res">
      <p class="res-head"><span>${esc(fmtDay(m.date))}</span><span class="grade-tag">${esc(m.grade)}</span></p>
      ${line('home', hs)}${line('away', as)}
      <p class="res-foot">${foot}. ${esc(compText(m))}</p>
    </article>`;
    return l ? `<a href="#m=${encodeURIComponent(m.id)}" style="text-decoration:none;display:block">${body}</a>` : body;
  }
  function renderResults() {
    const t = todayISO();
    const list = allMatches().filter((m) => inGrade(m) && (
      m.status === 'result' || m.status === 'conceded' ||
      (m.status === 'awaiting' && (S.live[m.id] || m.date >= addDays(t, -7))))).reverse();
    if (!list.length) return `<div class="empty"><p><b>No ${S.grade === 'All' ? '' : esc(S.grade) + ' '}results yet.</b></p><p>Results appear once Derry GAA posts them, usually the same evening.</p></div>`;
    const shown = list.slice(0, S.resultsLimit);
    return shown.map(resultRow).join('') +
      (list.length > shown.length ? `<div class="actions more"><button class="btn btn-small" type="button" data-act="more">Show older results</button></div>` : '');
  }

  function renderLive() {
    const t = todayISO();
    const seen = new Set();
    const list = [];
    allMatches().filter((m) => m.date === t && inGrade(m)).forEach((m) => { seen.add(m.id); list.push(m); });
    Object.keys(S.live).filter((id) => !seen.has(id) && (IN_PLAY.includes(S.live[id].status) || S.live[id].date >= addDays(t, -1)))
      .map(findMatch).filter((m) => m && inGrade(m)).forEach((m) => list.push(m));
    if (!list.length) {
      const next = allMatches().find((m) => inGrade(m) && m.status === 'fixture' && m.date > t);
      return `<div class="empty"><p><b>No games on today.</b></p>
        <p>On match days a club scorer posts every point, 2-pointer and goal here as it happens, and the score updates by itself.</p>
        ${next ? `<p>Next up: ${esc(fmtDay(next.date, true))}, ${esc(next.grade)} ${esc(nice(next.home))} v ${esc(nice(next.away))}.</p>` : ''}</div>`;
    }
    list.sort(byWhen);
    return list.map((m) => `<div class="day"><h3>${esc(m.grade)}: ${esc(nice(m.home))} v ${esc(nice(m.away))}</h3>
      <p class="game-comp">${esc(compText(m))}. ${esc(venueText(m))}</p>
      <div style="margin-top:10px">${boardHTML(m, { link: true, hint: S.live[m.id] ? 'Tap for every score' : 'No scores posted yet. Tap to follow this game.' })}</div></div>`).join('') +
      `<p class="note more">Live scores are posted by club scorers at the pitch. The official result follows on Derry GAA.</p>`;
  }

  function renderPanel() {
    const el = $('#panel');
    if (S.feedState === 'loading') { el.innerHTML = '<p class="note" style="margin-top:20px">Loading fixtures…</p>'; return; }
    if (S.feedState === 'failed' && !S.feed.matches.length) {
      el.innerHTML = `<div class="empty"><p><b>Fixtures couldn't load.</b></p><p>Check your connection, then reload the page.</p></div>`;
      return;
    }
    el.innerHTML = S.tab === 'results' ? renderResults() : S.tab === 'live' ? renderLive() : renderFixtures();
  }

  function renderStaff() {
    const el = $('#staff');
    if (!S.me) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const r = S.me.role;
    el.innerHTML = `<div class="staff-inner"><p>${r
      ? `Signed in as <b>${esc(S.me.name || S.me.email)}</b>, ${r === 'admin' ? 'admin' : 'scorer'}`
      : `Signed in as ${esc(S.me.email)}. This login doesn't have scoring access yet, so ask a club admin.`}</p>
      ${r ? '<button class="btn btn-small" type="button" data-act="add-game">Add a game</button>' : ''}
      ${r === 'admin' ? '<button class="btn btn-small" type="button" data-act="admin">Scorers</button>' : ''}
      <button class="btn btn-small" type="button" data-act="sign-out">Sign out</button></div>`;
  }
  function renderFoot() {
    const upd = S.feed.updated ? Date.parse(S.feed.updated) : 0;
    $('#foot').innerHTML = `
      ${S.store && S.store.mode === 'demo' ? `<p class="demo">Demo mode: live scores are saved only on this device. Everyone will see them once the club's Firebase project is connected.</p>` : ''}
      ${!S.store && S.feedState !== 'loading' ? `<p class="demo">Live scores are unavailable right now. Fixtures and results still work.</p>` : ''}
      <p>Fixtures and results come from <a href="${esc(S.feed.source || DEFAULT_SOURCE)}" target="_blank" rel="noopener">Derry GAA</a> and are checked every couple of hours${upd ? `. Last change ${esc(fmtStamp(upd))}` : ''}.</p>
      <div class="actions">
        <button class="btn btn-small" type="button" data-act="subscribe">${ICON.cal}Get fixtures in your calendar</button>
        ${S.me || !S.store ? '' : '<button class="btn btn-small btn-plain" type="button" data-act="sign-in">Scorer sign in</button>'}
      </div>`;
  }
  function render() {
    renderStaff(); renderHero(); renderTabs(); renderGrades(); renderPanel(); renderFoot();
  }

  // ---------- Dialogs ----------
  const dlgEl = () => $('#dlg');
  const head = (title, sub) => `<div class="dlg-head"><div><h2 id="dlgTitle">${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>` +
    `<button class="btn btn-small dlg-close" type="button" data-act="close">Close</button></div>`;

  function statusButtons(id) {
    const cur = (S.live[id] && S.live[id].status) || 'pre';
    return Object.keys(STATUS).map((k) => `<button type="button" data-act="status" data-status="${k}" aria-pressed="${k === cur}">${STATUS[k]}</button>`).join('');
  }
  function timelineHTML(m) {
    const l = S.live[m.id];
    const ev = ((l && l.events) || []).slice().sort((a, b) => a.at - b.at);
    if (!ev.length) {
      return `<h3>Scores</h3><p class="note">${l ? 'No scores yet.' : 'No scores posted yet. This page updates by itself as soon as a club scorer starts.'}</p>`;
    }
    const run = { home: { g: 0, p: 0 }, away: { g: 0, p: 0 } };
    const rows = ev.map((e) => {
      if (e.type === 'goal') run[e.team].g++; else run[e.team].p += TYPES[e.type].pts;
      return { e, score: `${gp(run.home)} v ${gp(run.away)}` };
    }).reverse();
    const scorer = canScore();
    return `<h3>Scores</h3><ol class="timeline" reversed>${rows.map(({ e, score }) => `<li>${flag(e.type)}
      <p class="tl-what"><b>${esc(TYPES[e.type].name)}</b>, ${esc(nice(m[e.team]))}<span class="tl-sub">${esc(score)} at ${esc(fmtClock(e.at))}</span></p>
      ${scorer ? `<button class="tl-x" type="button" data-act="remove-ev" data-eid="${esc(e.id)}" aria-label="Remove this ${esc(TYPES[e.type].name.toLowerCase())} for ${esc(nice(m[e.team]))}">Remove</button>` : '<span></span>'}
      </li>`).join('')}</ol>`;
  }
  function syncText(id) {
    if (!S.pending[id]) return S.live[id] ? 'All scores sent' : '';
    return Date.now() - (S.pendingSince[id] || Date.now()) > 4000 ? 'Waiting for signal. Scores will send by themselves.' : 'Sending…';
  }
  function matchDlg(id) {
    const m = findMatch(id);
    if (!m) return head('Game not found') + '<p>This game is no longer listed.</p>';
    const scorer = canScore();
    const types = scoreTypes(m);
    const pads = ['home', 'away'].map((k) => `<div class="pad"><p class="pad-name">${esc(nice(m[k]))}</p><div class="pad-btns n${types.length}">` +
      types.map((ty) => `<button type="button" class="score-btn ${ty}" data-act="score" data-team="${k}" data-type="${ty}" aria-label="${esc(TYPES[ty].label)} for ${esc(nice(m[k]))}">${flag(ty)}<span>${TYPES[ty].label}</span></button>`).join('') +
      '</div></div>').join('');
    return head(`${esc(nice(m.home))} v ${esc(nice(m.away))}`, esc(`${m.grade ? m.grade + ': ' : ''}${compText(m)}`)) +
      `<div id="mBoard">${boardHTML(m)}</div>
      <p class="note">${esc(fmtDay(m.date, true))}, ${esc(fmtTime(m.time))}. ${esc(venueText(m))}</p>
      <div class="actions">
        <button class="btn btn-small" type="button" data-act="share" data-id="${esc(id)}">Share this game</button>
        ${m.venue && m.venue !== 'TBC' ? `<a class="btn btn-small" href="${dirUrl(m.venue)}" target="_blank" rel="noopener">${ICON.pin}Directions</a>` : ''}
      </div>
      ${scorer ? `<section class="scorer" aria-label="Scoring">
        <h3>Match status</h3><div class="status-set" id="mStatus" role="group" aria-label="Match status">${statusButtons(id)}</div>
        ${pads}
        <div class="pad-foot"><button class="btn btn-small" type="button" data-act="undo">Undo last score</button><span id="mSync" class="sync" aria-live="polite">${esc(syncText(id))}</span></div>
      </section>` : ''}
      <div id="mTimeline">${timelineHTML(m)}</div>`;
  }
  function calDlg(id) {
    const m = findMatch(id);
    if (!m) return head('Game not found');
    return head('Add to calendar', esc(`${eventTitle(m)}, ${fmtDay(m.date)} ${fmtTime(m.time)}`)) +
      `<div class="choice">
        <button class="btn" type="button" data-act="ics" data-id="${esc(id)}">${ICON.cal}Apple Calendar or Outlook</button>
        <a class="btn" href="${gcalUrl(m)}" target="_blank" rel="noopener">${ICON.cal}Google Calendar</a>
      </div>
      <p class="note">Want every game without adding them one at a time?</p>
      <div class="actions"><button class="btn btn-small" type="button" data-act="subscribe">Subscribe to the fixtures calendar</button></div>`;
  }
  function subDlg() {
    const base = siteBase();
    const title = 'Get fixtures in your calendar';
    if (!base) return head(title) + '<p>Calendar subscriptions work once the site is online.</p>';
    const rows = [{ grade: 'All teams', file: 'fixtures.ics' }].concat(S.feed.calendars || []);
    return head(title, 'Subscribe once and new fixtures, time changes and results appear in your calendar by themselves.') +
      rows.map((r) => {
        const https = base + r.file, webcal = https.replace(/^https?:/, 'webcal:');
        return `<div class="cal-row"><h4>${esc(r.grade)}</h4><div class="actions">
          <a class="btn btn-small" href="${esc(webcal)}">Apple or Outlook</a>
          <a class="btn btn-small" href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}" target="_blank" rel="noopener">Google Calendar</a>
          <button class="btn btn-small btn-plain" type="button" data-act="copy" data-text="${esc(https)}">Copy link</button></div></div>`;
      }).join('') + '<p class="note">Google Calendar can take several hours to pick up changes. Apple and Outlook check more often.</p>';
  }
  function signinDlg() {
    if (S.store && S.store.mode === 'demo') {
      return head('Scorer sign in', 'Demo mode') +
        `<p>The club's Firebase project isn't connected yet, so this is a practice run. Sign in as a demo admin to try live scoring, adding games and the scorer list. Everything stays on this device.</p>
        <div class="actions"><button class="btn btn-solid" type="button" data-act="demo-sign-in">Try it as a demo admin</button></div>`;
    }
    if (!S.ownerExists) {
      return head('Set up the site', "Do this once. You'll be the site owner and can add scorers and other admins.") +
        `<form id="setupForm" novalidate>
          <label class="field"><span>Your name</span><input name="name" autocomplete="name" required></label>
          <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
          <label class="field"><span>Choose a password</span><input name="password" type="password" autocomplete="new-password" minlength="8" required><small>At least 8 characters.</small></label>
          <div class="actions"><button class="btn btn-solid" type="submit">Create owner account</button></div>
          <p class="msg" id="formMsg" role="alert"></p>
        </form>`;
    }
    return head('Scorer sign in', 'For club scorers and admins. Everyone else can follow live scores without signing in.') +
      `<form id="signinForm" novalidate>
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <div class="actions"><button class="btn btn-solid" type="submit">Sign in</button><button class="btn btn-plain" type="button" data-act="reset-pw">Forgot password?</button></div>
        <p class="msg" id="formMsg" role="alert"></p>
      </form>`;
  }
  function usersHTML() {
    const order = { admin: 0, scorer: 1, removed: 2 };
    const list = S.users.slice().sort((a, b) => (order[a.role] - order[b.role]) || String(a.name).localeCompare(String(b.name)));
    if (!list.length) return '<li><p class="note">No one yet.</p></li>';
    return list.map((u) => {
      const owner = u.uid === S.ownerUid, self = S.me && u.uid === S.me.uid;
      const ctl = owner ? '<p class="note">Owner</p>' : self ? '<p class="note">You</p>' :
        `<select data-act="role" data-uid="${esc(u.uid)}" aria-label="Access for ${esc(u.name)}">` +
        ['scorer', 'admin', 'removed'].map((r) => `<option value="${r}"${u.role === r ? ' selected' : ''}>${r === 'removed' ? 'Removed' : r === 'admin' ? 'Admin' : 'Scorer'}</option>`).join('') + '</select>';
      return `<li class="${u.role === 'removed' ? 'removed' : ''}"><div><p class="who">${esc(u.name || u.email)}</p><p class="email">${esc(u.email)}</p></div>${ctl}</li>`;
    }).join('');
  }
  function adminDlg() {
    return head('Scorers and admins', 'Scorers post live scores and add games. Admins can also manage this list.') +
      `<form id="addUserForm" novalidate>
        <h3>Add someone</h3>
        <label class="field"><span>Name</span><input name="name" required autocomplete="off"></label>
        <label class="field"><span>Email</span><input name="email" type="email" required autocomplete="off"></label>
        <fieldset><legend>Access</legend><div class="radios">
          <label><input type="radio" name="role" value="scorer" checked> Scorer</label>
          <label><input type="radio" name="role" value="admin"> Admin</label>
        </div></fieldset>
        <div class="actions"><button class="btn btn-solid" type="submit">Add and send login email</button></div>
        <p class="note">They'll get an email with a link to choose their own password. Ask them to check spam if it doesn't arrive.</p>
        <p class="msg" id="formMsg" role="alert"></p>
      </form>
      <h3>Everyone with access</h3><ul class="users" id="userList">${usersHTML()}</ul>`;
  }
  function addGameDlg() {
    const grades = [...new Set(gradesPresent().concat(['Seniors', 'Reserves', 'U18', 'U16', 'U14', 'U12', 'Ladies', 'Hurling', 'Camogie']))];
    return head('Add a game', "For games that aren't on the Derry GAA site, like challenge matches or blitzes.") +
      `<form id="gameForm" novalidate>
        <label class="field"><span>Team</span><select name="grade">${grades.map((g) => `<option${g === (S.grade === 'All' ? 'Seniors' : S.grade) ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
        <label class="field"><span>Opponent</span><input name="opponent" required autocomplete="off"></label>
        <fieldset><legend>Where</legend><div class="radios">
          <label><input type="radio" name="ha" value="home" checked> Home</label>
          <label><input type="radio" name="ha" value="away"> Away</label>
        </div></fieldset>
        <div class="row2">
          <label class="field"><span>Date</span><input name="date" type="date" required value="${todayISO()}"></label>
          <label class="field"><span>Throw-in</span><input name="time" type="time"></label>
        </div>
        <label class="field"><span>Venue</span><input name="venue" value="${esc(HOME_VENUE)}" autocomplete="off"></label>
        <label class="field"><span>Competition</span><input name="competition" placeholder="Challenge match" autocomplete="off"></label>
        <div class="actions"><button class="btn btn-solid" type="submit">Add game</button></div>
        <p class="msg" id="formMsg" role="alert"></p>
      </form>`;
  }

  function dlgHTML() {
    const { mode, arg } = S.dlg;
    switch (mode) {
      case 'match': return matchDlg(arg);
      case 'cal': return calDlg(arg);
      case 'subscribe': return subDlg();
      case 'sign-in': return signinDlg();
      case 'admin': return adminDlg();
      case 'add-game': return addGameDlg();
      default: return '';
    }
  }
  function openDlg(mode, arg) {
    const d = dlgEl();
    S.dlg = { mode, arg };
    d.innerHTML = `<div class="dlg-body">${dlgHTML()}</div>`;
    if (!d.open) d.showModal();
    d.scrollTop = 0;
    const first = d.querySelector('form input, form select');
    if (first) first.focus();
    if (mode === 'admin' && S.store && !S.unsubUsers) {
      S.unsubUsers = S.store.onUsers((u) => { S.users = u; const ul = $('#userList'); if (ul) ul.innerHTML = usersHTML(); });
    }
  }
  function closeDlg() { const d = dlgEl(); if (d.open) d.close(); }
  function refreshDlg(full) {
    if (!S.dlg) return;
    if (full) { openDlg(S.dlg.mode, S.dlg.arg); return; }
    if (S.dlg.mode !== 'match') return;
    const id = S.dlg.arg, m = findMatch(id);
    if (!m) return;
    const b = $('#mBoard'); if (b) b.innerHTML = boardHTML(m);
    const tl = $('#mTimeline'); if (tl) tl.innerHTML = timelineHTML(m);
    const st = $('#mStatus');
    if (st) { const cur = (S.live[id] && S.live[id].status) || 'pre'; st.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.status === cur))); }
    updateSync();
  }
  function updateSync() {
    const el = $('#mSync');
    if (!el || !S.dlg) return;
    const txt = syncText(S.dlg.arg);
    el.textContent = txt;
    el.classList.toggle('waiting', /Waiting/.test(txt));
  }

  // ---------- Actions ----------
  function setTab(tab) {
    S.tab = tab; savePrefs(); renderTabs(); renderPanel();
  }
  function setGrade(g) {
    S.grade = g; S.resultsLimit = 25; savePrefs(); renderHero(); renderGrades(); renderPanel();
  }
  function score(team, type, btn) {
    const m = findMatch(S.dlg && S.dlg.arg);
    if (!m || !canScore()) return;
    const l = S.live[m.id];
    const ev = { id: rid(), team, type, at: Date.now(), by: S.me.uid };
    const status = !l || l.status === 'pre' ? 'h1' : null;
    btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 220);
    if (navigator.vibrate) navigator.vibrate(25);
    toast(`${TYPES[type].label} for ${nice(m[team])}`);
    S.store.addEvent(m.id, liveInfo(m), ev, status).catch((e) => toast(errText(e)));
  }
  function lastEvent(id) {
    const ev = ((S.live[id] && S.live[id].events) || []).slice().sort((a, b) => a.at - b.at);
    return ev[ev.length - 1];
  }
  function removeEvent(id, ev, m) {
    S.store.removeEvent(id, ev).catch((e) => toast(errText(e)));
    toast(`Removed ${TYPES[ev.type].name.toLowerCase()} for ${nice(m[ev.team])}`);
  }
  async function share(id) {
    const m = findMatch(id);
    if (!m) return;
    const url = (siteBase() || location.href.split('#')[0]) + '#m=' + encodeURIComponent(id);
    const title = `${nice(m.home)} v ${nice(m.away)}, live score`;
    if (navigator.share) { try { await navigator.share({ title, url }); } catch (e) {} return; }
    toast((await copy(url)) ? 'Link copied' : url);
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act],[data-tab],[data-grade]');
    if (!t) return;
    if (t.dataset.tab) { setTab(t.dataset.tab); return; }
    if (t.dataset.grade) { setGrade(t.dataset.grade); return; }
    const act = t.dataset.act, id = t.dataset.id;
    const m = S.dlg && S.dlg.mode === 'match' ? findMatch(S.dlg.arg) : null;
    switch (act) {
      case 'close': closeDlg(); break;
      case 'cal': openDlg('cal', id); break;
      case 'ics': { const x = findMatch(id); if (x) downloadIcs(x); break; }
      case 'subscribe': openDlg('subscribe'); break;
      case 'copy': copy(t.dataset.text).then((ok) => toast(ok ? 'Link copied' : 'Copy failed')); break;
      case 'share': share(id); break;
      case 'more': S.resultsLimit += 25; renderPanel(); break;
      case 'sign-in': openDlg('sign-in'); break;
      case 'demo-sign-in': S.store.demoSignIn().then(() => { closeDlg(); toast('Signed in as demo admin'); }); break;
      case 'sign-out': S.store.signOut().then(() => toast('Signed out')); break;
      case 'admin': openDlg('admin'); break;
      case 'add-game': openDlg('add-game'); break;
      case 'del-game':
        if (confirm('Remove this game from the list?')) S.store.deleteGame(id).then(() => toast('Game removed'), (err) => toast(errText(err)));
        break;
      case 'score': score(t.dataset.team, t.dataset.type, t); break;
      case 'status':
        if (m && canScore()) {
          S.store.setStatus(m.id, liveInfo(m), t.dataset.status, !S.live[m.id]).catch((err) => toast(errText(err)));
          toast(STATUS[t.dataset.status]);
        }
        break;
      case 'undo': {
        if (!m) break;
        const ev = lastEvent(m.id);
        if (!ev) { toast('Nothing to undo'); break; }
        removeEvent(m.id, ev, m);
        break;
      }
      case 'remove-ev': {
        if (!m) break;
        const ev = ((S.live[m.id] && S.live[m.id].events) || []).find((x) => x.id === t.dataset.eid);
        if (ev && confirm(`Remove this ${TYPES[ev.type].name.toLowerCase()} for ${nice(m[ev.team])}?`)) removeEvent(m.id, ev, m);
        break;
      }
      case 'reset-pw': {
        const f = $('#signinForm');
        const email = f && f.email.value.trim();
        const msg = $('#formMsg');
        if (!email) { msg.className = 'msg err'; msg.textContent = 'Type your email above first, then choose Forgot password.'; break; }
        S.store.resetPassword(email).then(() => { msg.className = 'msg ok'; msg.textContent = 'If that email has a login, a reset link is on its way.'; },
          (err) => { msg.className = 'msg err'; msg.textContent = errText(err); });
        break;
      }
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('select[data-act="role"]')) {
      S.store.setRole(t.dataset.uid, t.value).then(() => toast('Access updated'), (err) => toast(errText(err)));
    }
    if (t.name === 'ha' && t.form && t.form.id === 'gameForm') {
      const v = t.form.venue;
      if (t.value === 'away' && v.value === HOME_VENUE) v.value = '';
      if (t.value === 'home' && !v.value) v.value = HOME_VENUE;
    }
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    e.preventDefault();
    const msg = $('#formMsg');
    const say = (text, ok) => { if (msg) { msg.className = 'msg ' + (ok ? 'ok' : 'err'); msg.textContent = text; } };
    const btn = f.querySelector('[type="submit"]');
    const busy = (on) => { if (btn) btn.disabled = on; };
    const val = (n) => (f.elements[n] ? String(f.elements[n].value).trim() : '');
    try {
      if (f.id === 'signinForm') {
        if (!val('email') || !val('password')) return say('Enter your email and password.');
        busy(true); say('');
        await S.store.signIn(val('email'), f.elements.password.value);
        closeDlg(); toast('Signed in');
      } else if (f.id === 'setupForm') {
        if (!val('name') || !val('email')) return say('Enter your name and email.');
        if (f.elements.password.value.length < 8) return say('Choose a password of at least 8 characters.');
        busy(true); say('Setting up…', true);
        await S.store.claimOwner(val('name'), val('email'), f.elements.password.value);
        closeDlg(); toast("You're the site owner now");
      } else if (f.id === 'addUserForm') {
        const email = val('email').toLowerCase();
        if (!val('name') || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return say('Enter a name and a valid email.');
        const name = val('name');
        busy(true); say('Adding…', true);
        await S.store.addUser({ name, email, role: f.elements.role.value });
        f.reset(); say(`Added. ${name} will get an email to choose a password.`, true);
      } else if (f.id === 'gameForm') {
        const opp = val('opponent');
        if (!opp || !val('date')) return say('Enter the opponent and the date.');
        const home = f.elements.ha.value === 'home';
        busy(true);
        await S.store.addGame({
          date: val('date'), time: val('time') || null, grade: val('grade'),
          home: home ? CLUB_SHORT : opp, away: home ? opp : CLUB_SHORT,
          venue: val('venue') || 'TBC', competition: val('competition') || 'Challenge match',
        });
        closeDlg(); toast('Game added');
        if (S.tab !== 'fixtures') setTab('fixtures');
      }
    } catch (err) {
      say(errText(err));
    } finally {
      busy(false);
    }
  });

  // Arrow keys move between tabs.
  $('.tabs').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    let i = tabs.findIndex((x) => x.dataset.tab === S.tab);
    i = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setTab(tabs[i].dataset.tab); tabs[i].focus(); e.preventDefault();
  });

  dlgEl().addEventListener('click', (e) => { if (e.target === dlgEl()) closeDlg(); });
  dlgEl().addEventListener('close', () => {
    const was = S.dlg;
    S.dlg = null;
    if (S.unsubUsers) { S.unsubUsers(); S.unsubUsers = null; }
    if (was && was.mode === 'match' && /^#m=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  });
  function openFromHash() {
    const h = /^#m=(.+)$/.exec(location.hash);
    if (h && S.feedState !== 'loading') openDlg('match', decodeURIComponent(h[1]));
  }
  window.addEventListener('hashchange', openFromHash);

  function savePrefs() { try { localStorage.setItem('screen-prefs', JSON.stringify({ grade: S.grade, tab: S.tab })); } catch (e) {} }
  function restorePrefs() {
    try { const p = JSON.parse(localStorage.getItem('screen-prefs') || '{}'); if (p.grade) S.grade = p.grade; if (p.tab) S.tab = p.tab; } catch (e) {}
  }

  // ---------- Data: fixtures feed ----------
  function loadFeed() {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'data/fixtures.js?t=' + Math.floor(Date.now() / 60000);
      s.onload = () => {
        s.remove();
        const d = window.CLUB_FIXTURES;
        if (d && Array.isArray(d.matches)) { S.feed = d; S.feedState = 'ok'; } else if (S.feedState === 'loading') S.feedState = 'failed';
        resolve();
      };
      s.onerror = () => {
        s.remove();
        const d = window.CLUB_FIXTURES;          // keep whatever we already have
        if (S.feedState === 'loading') {
          if (d && Array.isArray(d.matches)) { S.feed = d; S.feedState = 'ok'; } else S.feedState = 'failed';
        }
        resolve();
      };
      document.head.appendChild(s);
    });
  }

  // ---------- Data: demo store (no Firebase) ----------
  function createDemoStore() {
    const KEY = 'screen-demo-v1';
    const blank = () => ({ live: {}, games: [], users: [], session: null });
    const read = () => { try { return Object.assign(blank(), JSON.parse(localStorage.getItem(KEY) || 'null') || {}); } catch (e) { return blank(); } };
    let D = read();
    const subs = { live: [], games: [], auth: [], users: [] };
    const emit = () => {
      subs.auth.forEach((cb) => cb(D.session ? clone(D.session) : null));
      subs.games.forEach((cb) => cb(clone(D.games)));
      subs.live.forEach((cb) => cb(clone(D.live), {}));
      subs.users.forEach((cb) => cb(clone(D.users)));
    };
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(D)); } catch (e) {} emit(); };
    window.addEventListener('storage', (e) => { if (e.key === KEY) { D = read(); emit(); } });
    const touch = (id, info) => {
      const l = D.live[id] || Object.assign({ status: 'pre', events: [] }, info);
      Object.assign(l, info, { updatedAt: Date.now() });
      D.live[id] = l;
      return l;
    };
    const taken = (email) => D.users.some((u) => u.email.toLowerCase() === email.toLowerCase());
    return {
      mode: 'demo',
      onAuth(cb) { subs.auth.push(cb); cb(D.session ? clone(D.session) : null); },
      onOwner(cb) { cb(true); },
      onLive(cb) { subs.live.push(cb); cb(clone(D.live), {}); },
      onGames(cb) { subs.games.push(cb); cb(clone(D.games)); },
      onUsers(cb) { subs.users.push(cb); cb(clone(D.users)); return () => { subs.users = subs.users.filter((x) => x !== cb); }; },
      async addEvent(id, info, ev, status) { const l = touch(id, info); l.events.push(ev); if (status) l.status = status; save(); },
      async removeEvent(id, ev) { const l = D.live[id]; if (!l) return; l.events = l.events.filter((x) => x.id !== ev.id); l.updatedAt = Date.now(); save(); },
      async setStatus(id, info, status) { touch(id, info).status = status; save(); },
      async addGame(g) { D.games.push(Object.assign({ id: rid() }, g)); save(); },
      async deleteGame(id) { D.games = D.games.filter((g) => g.id !== id); save(); },
      async demoSignIn() {
        D.session = { uid: 'demo-owner', email: 'demo@example.com', name: 'Demo admin', role: 'admin', owner: true };
        if (!D.users.some((u) => u.uid === 'demo-owner')) D.users.push({ uid: 'demo-owner', name: 'Demo admin', email: 'demo@example.com', role: 'admin' });
        save();
      },
      async signOut() { D.session = null; save(); },
      async resetPassword() {},
      async claimOwner() {},
      async addUser({ name, email, role }) {
        if (taken(email)) throw new Error('That email already has a login. If they were removed, set them back to Scorer in the list below.');
        D.users.push({ uid: rid(), name, email, role }); save();
      },
      async setRole(uid, role) { const u = D.users.find((x) => x.uid === uid); if (u) u.role = role; save(); },
      ownerUid: 'demo-owner',
    };
  }

  // ---------- Data: Firebase store ----------
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  async function createFirebaseStore(cfg) {
    for (const f of ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js']) await loadScript(FIREBASE_SDK + f);
    /* global firebase */
    firebase.initializeApp(cfg);
    const auth = firebase.auth();
    const db = firebase.firestore();
    try { await db.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* private mode or another tab: fine */ }
    const FV = firebase.firestore.FieldValue;
    const authCbs = [];
    let me = null, seq = 0, ownerUid = null, known = false;

    async function loadMe(u) {
      if (!u) return null;
      let role = null, name = '';
      try {
        const [o, d] = await Promise.all([db.doc('config/owner').get(), db.doc('users/' + u.uid).get()]);
        if (o.exists && o.data().uid === u.uid) role = 'admin';
        if (d.exists) { name = d.data().name || ''; if (!role) role = d.data().role; }
      } catch (e) { console.warn(e); }
      if (role === 'removed') role = null;
      return { uid: u.uid, email: u.email, name: name || u.email, role };
    }
    async function refresh(u) {
      const mine = ++seq;
      const who = await loadMe(u);
      if (mine !== seq) return;            // a newer refresh won
      me = who; known = true;
      authCbs.forEach((cb) => cb(me));
    }
    auth.onAuthStateChanged((u) => refresh(u));
    const uid = () => (auth.currentUser ? auth.currentUser.uid : null);

    const store = {
      mode: 'firebase',
      get ownerUid() { return ownerUid; },
      onAuth(cb) { authCbs.push(cb); if (known) cb(me); },
      onOwner(cb) {
        db.doc('config/owner').onSnapshot((s) => { ownerUid = s.exists ? s.data().uid : null; cb(s.exists); }, () => cb(true));
      },
      onLive(cb) {
        db.collection('live').where('date', '>=', addDays(todayISO(), -3)).onSnapshot({ includeMetadataChanges: true }, (snap) => {
          const out = {}, pending = {};
          snap.forEach((d) => { out[d.id] = d.data({ serverTimestamps: 'estimate' }); pending[d.id] = d.metadata.hasPendingWrites; });
          cb(out, pending);
        }, (err) => { console.warn(err); toast('Live scores are unavailable right now.'); });
      },
      onGames(cb) {
        db.collection('games').where('date', '>=', addDays(todayISO(), -30)).onSnapshot(
          (s) => cb(s.docs.map((d) => Object.assign({ id: d.id }, d.data()))), (err) => console.warn(err));
      },
      onUsers(cb) {
        return db.collection('users').onSnapshot((s) => cb(s.docs.map((d) => Object.assign({ uid: d.id }, d.data()))), (err) => console.warn(err));
      },
      // Writes don't wait for the server, so scoring keeps working on poor signal;
      // Firestore sends them as soon as there's a connection.
      addEvent(id, info, ev, status) {
        const data = Object.assign({}, info, { events: FV.arrayUnion(ev), updatedAt: FV.serverTimestamp(), updatedBy: uid() });
        if (status) data.status = status;
        return db.collection('live').doc(id).set(data, { merge: true });
      },
      removeEvent(id, ev) {
        return db.collection('live').doc(id).update({ events: FV.arrayRemove(ev), updatedAt: FV.serverTimestamp(), updatedBy: uid() });
      },
      setStatus(id, info, status, isNew) {
        const data = Object.assign({}, info, { status, updatedAt: FV.serverTimestamp(), updatedBy: uid() });
        if (isNew) data.events = [];
        return db.collection('live').doc(id).set(data, { merge: true });
      },
      addGame(g) { return db.collection('games').add(Object.assign({}, g, { createdBy: uid(), createdAt: FV.serverTimestamp() })); },
      deleteGame(id) { return db.collection('games').doc(id).delete(); },
      signIn(email, pw) { return auth.signInWithEmailAndPassword(email, pw); },
      signOut() { return auth.signOut(); },
      resetPassword(email) { return auth.sendPasswordResetEmail(email); },
      async claimOwner(name, email, pw) {
        const cred = await auth.createUserWithEmailAndPassword(email, pw);
        await db.doc('config/owner').set({ uid: cred.user.uid, email, claimedAt: FV.serverTimestamp() });
        await db.doc('users/' + cred.user.uid).set({ name, email, role: 'admin', addedBy: cred.user.uid, addedAt: FV.serverTimestamp() });
        await refresh(cred.user);
      },
      async addUser({ name, email, role }) {
        // A second Firebase app creates the account so the admin stays signed in.
        const helper = firebase.apps.find((a) => a.name === 'add-user') || firebase.initializeApp(cfg, 'add-user');
        const hAuth = helper.auth();
        await hAuth.setPersistence(firebase.auth.Auth.Persistence.NONE);
        let newUid;
        try {
          const pw = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(36).padStart(2, '0')).join('');
          newUid = (await hAuth.createUserWithEmailAndPassword(email, pw)).user.uid;
        } catch (e) {
          if (e.code === 'auth/email-already-in-use') throw new Error('That email already has a login. If they were removed, set them back to Scorer in the list below.');
          throw e;
        } finally {
          try { await hAuth.signOut(); } catch (e) {}
        }
        await db.doc('users/' + newUid).set({ name, email, role, addedBy: uid(), addedAt: FV.serverTimestamp() });
        await auth.sendPasswordResetEmail(email);
      },
      setRole(targetUid, role) { return db.doc('users/' + targetUid).update({ role, updatedAt: FV.serverTimestamp() }); },
    };
    return store;
  }

  function attachStore(store) {
    S.store = store;
    store.onOwner((exists) => {
      S.ownerExists = exists;
      S.ownerUid = store.ownerUid;
      if (S.dlg && S.dlg.mode === 'sign-in') refreshDlg(true);
    });
    store.onAuth((me) => {
      const before = S.me && S.me.role;
      S.me = me;
      render();
      if (S.dlg && S.dlg.mode === 'match' && before !== (me && me.role)) refreshDlg(true);
      if (S.dlg && S.dlg.mode === 'admin' && !isAdmin()) closeDlg();
    });
    store.onLive((live, pending) => {
      S.live = live;
      Object.keys(pending || {}).forEach((id) => {
        if (pending[id] && !S.pending[id]) S.pendingSince[id] = Date.now();
      });
      S.pending = pending || {};
      render();
      refreshDlg();
    });
    store.onGames((games) => { S.games = games; render(); refreshDlg(); });
    if (store.mode === 'demo') S.ownerUid = store.ownerUid;
  }

  // ---------- Start ----------
  async function init() {
    restorePrefs();
    render();
    await loadFeed();
    render();
    openFromHash();
    setInterval(() => loadFeed().then(() => { render(); refreshDlg(); }), 10 * 60 * 1000);
    setInterval(() => {
      document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = ago(+el.dataset.ago); });
      updateSync();
    }, 15 * 1000);

    const cfg = window.FIREBASE_CONFIG || {};
    let store = null;
    if (cfg.apiKey && cfg.projectId) {
      try { store = await createFirebaseStore(cfg); } catch (e) { console.error(e); }
    } else {
      store = createDemoStore();
    }
    if (store) attachStore(store); else render();
    if (S.dlg) refreshDlg(true);
  }
  init();
})();
