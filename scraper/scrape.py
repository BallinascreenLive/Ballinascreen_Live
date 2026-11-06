#!/usr/bin/env python3
"""
Refresh Ballinascreen (Naomh Colm) fixtures & results from Derry GAA (Club & County).

Writes, only when something changed:
  docs/data/fixtures.json      machine-readable copy (also remembers the club's Derry GAA page)
  docs/data/fixtures.js        the same data, loaded by the website
  docs/fixtures.ics            calendar feed, every team
  docs/fixtures-<grade>.ics    calendar feed per team (seniors, u16, hurling-u14 ...)

Usage:
  python scraper/scrape.py                      fetch from Derry GAA (the GitHub Action does this)
  python scraper/scrape.py --html team=page.html --html all=listing.html     use saved pages
  python scraper/scrape.py --dry-run            report only

The first run finds the club's team page on Derry GAA by itself (from links on the all-county
listing and a few other clubs' pages) and saves its address in fixtures.json. If nothing can be
read, the script exits with an error and leaves the existing data untouched.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

CLUB_NAME = "Ballinascreen GAC"
CLUB_RE = re.compile(r"\b(ballinascreen|baile na scrine|naomh colm)\b")
BASE = "https://derry.clubandcounty.com"
ALL_URL = BASE + "/fixtures-results/"
# Pages that link to Ballinascreen's team page, used once to find it.
FINDER_PAGES = [
    ALL_URL,
    BASE + "/fixtures-results/team/an-gleann/aff0a6a4-5212-3297-0b2c-1cf539ad1546/",
    BASE + "/fixtures-results/team/desertmartin/f076073b-2082-f874-1a9c-d07b789c2877/",
]
TEAM_LINK_RE = re.compile(r"/fixtures-results/team/[^/]+/[0-9a-f-]{36}/?$", re.I)

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
LONDON = ZoneInfo("Europe/London")

# --------------------------------------------------------------------------
# Text helpers
# --------------------------------------------------------------------------

def clean(s: str) -> str:
    return " ".join((s or "").replace("\u00a0", " ").split())


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[’'`´]", "", s)
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s).split())


def is_us(name: str) -> bool:
    return bool(CLUB_RE.search(fold(name)))


MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
DATE_RE = re.compile(
    r"^(?:mon|tues|wednes|thurs|fri|satur|sun)day\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?\s+(\d{4})$", re.I)
SCORE_RE = re.compile(r"^\d{1,2}-\d{1,3}$")
TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")
SLOT_RE = re.compile(r"^(\d{1,2}:\d{2}|tbc|tba|conceded|postponed|refixed|abandoned|w/?o)$", re.I)
LABEL_RE = re.compile(r"^(venue|referee|live via|live on|tickets|stream)\s*:\s*(.*)$", re.I)


def to_iso(text: str) -> str | None:
    m = DATE_RE.match(clean(text))
    if not m:
        return None
    mon = MONTHS.get(m.group(2).lower()[:3])
    try:
        return date(int(m.group(3)), mon, int(m.group(1))).isoformat() if mon else None
    except ValueError:
        return None


def tokens(html: str) -> list[tuple]:
    """The page in reading order: ('date', iso) / ('text', s) / ('link', s, href)."""
    from bs4 import BeautifulSoup, Comment, NavigableString, Tag

    soup = BeautifulSoup(html, "html.parser")
    skip = {"script", "style", "noscript", "svg", "template", "head", "select", "option"}
    out: list[tuple] = []

    def walk(node):
        for child in node.children:
            if isinstance(child, Comment):
                continue
            if isinstance(child, NavigableString):
                t = clean(str(child))
                if t:
                    iso = to_iso(t)
                    out.append(("date", iso) if iso else ("text", t))
            elif isinstance(child, Tag):
                if child.name in skip:
                    continue
                if child.name == "a":
                    t = clean(child.get_text(" "))
                    if t:
                        iso = to_iso(t)
                        out.append(("date", iso) if iso else ("link", t, child.get("href") or ""))
                    continue
                if child.name in ("h1", "h2", "h3", "h4", "h5", "h6", "time"):
                    iso = to_iso(child.get_text(" "))
                    if iso:
                        out.append(("date", iso))
                        continue
                walk(child)

    walk(soup.body or soup)
    merged, i = [], 0
    while i < len(out):          # "0" "-" "25" in separate spans -> "0-25"
        t = out[i]
        if (t[0] == "text" and t[1].isdigit() and i + 2 < len(out) and out[i + 1][0] == "text"
                and out[i + 1][1] in ("-", "–") and out[i + 2][0] == "text" and out[i + 2][1].isdigit()):
            merged.append(("text", f"{t[1]}-{out[i + 2][1]}"))
            i += 3
            continue
        merged.append(t)
        i += 1
    return merged


def _is_score(s: str) -> bool:
    return bool(SCORE_RE.match(s)) or s.upper() == "CONC"


def parse_cc(html: str) -> list[dict]:
    """Every game on a Club & County fixtures/results page.

    Pattern: <competition> <home> <score> <time> <score> <away>, then "Venue:" / "Referee:" /
    "Live via:" lines. Works whether or not the names are links.
    """
    toks = tokens(html)
    games, pending, last, cur_date = [], [], None, None
    i, n = 0, len(toks)
    while i < n:
        t = toks[i]
        if t[0] == "date":
            cur_date, pending, last = t[1], [], None
            i += 1
            continue
        text, low = t[1], t[1].lower()
        if low.startswith("load more results"):
            break                                 # league tables follow
        if low.startswith("load more fixtures"):
            pending, last = [], None
            i += 1
            continue
        lab = LABEL_RE.match(text)
        if lab:
            key, val = lab.group(1).lower(), lab.group(2).strip()
            if not val and i + 1 < n and toks[i + 1][0] != "date" and not LABEL_RE.match(toks[i + 1][1]):
                val = toks[i + 1][1]
                i += 1
            if last is not None:
                if key == "venue":
                    last["venue"] = val
                elif key == "referee":
                    last["ref"] = val
                elif key in ("live via", "live on", "stream"):
                    last["live"] = val
            pending = []
            i += 1
            continue
        if (cur_date and i + 3 < n and _is_score(text) and toks[i + 1][0] != "date" and SLOT_RE.match(toks[i + 1][1])
                and toks[i + 2][0] != "date" and _is_score(toks[i + 2][1]) and toks[i + 3][0] != "date"
                and len(pending) >= 2):
            comp_toks = [pending[-2]]
            k = len(pending) - 3
            while k >= 0 and re.match(r"^[-–]\s*\S", comp_toks[0][1]) and len(comp_toks) < 4:
                comp_toks.insert(0, pending[k])
                k -= 1
            g = {"date": cur_date, "comp": clean(" ".join(c[1] for c in comp_toks)),
                 "href": next((c[2] for c in comp_toks if c[0] == "link"), ""),
                 "home": pending[-1][1], "hs": text, "slot": toks[i + 1][1], "as": toks[i + 2][1],
                 "away": toks[i + 3][1]}
            games.append(g)
            last, pending = g, []
            i += 4
            continue
        pending = (pending + [t])[-12:]
        i += 1
    return games


def find_team_link(html: str) -> str | None:
    """The club's own team page, from links whose text names the club."""
    found = []
    for t in tokens(html):
        if t[0] == "link" and is_us(t[1]) and TEAM_LINK_RE.search(t[2].split("?")[0]):
            found.append((t[1], urljoin(BASE, t[2])))
    if not found:
        return None
    # prefer the plain club name over "Ballinascreen Res" or "Ballinascreen 2"
    found.sort(key=lambda x: (fold(x[0]) != "ballinascreen", "/ballinascreen/" not in x[1].lower(), len(x[0])))
    return found[0][1]


# --------------------------------------------------------------------------
# Normalising
# --------------------------------------------------------------------------

def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", fold(s)).strip("-")


AGE_RE = re.compile(r"\bu-?(\d{1,2})")


def sport_of(comp: str, href: str) -> str:
    h = (href or "").lower()
    for key, sport in (("/ladies_football/", "ladies"), ("/camogie/", "camogie"), ("/hurling/", "hurling"),
                       ("/football/", "football")):
        if key in h:
            return sport
    f = fold(comp)
    if "camogie" in f:
        return "camogie"
    if "hurling" in f:
        return "hurling"
    if "ladies" in f or "lgfa" in f:
        return "ladies"
    if any(w in f for w in ("football", "recreational", "reserve", "development")):
        return "football"
    return "ladies"          # Derry's ladies competitions are named plainly ("U16 Championship")


def grade_of(comp: str, href: str, label: str) -> str:
    f, lab = fold(comp), fold(label)
    sport = sport_of(comp, href)
    m = AGE_RE.search(f)
    age = int(m.group(1)) if m else (18 if "minor" in f else None)
    reserve = "recreational" in f or "reserve" in f or lab.endswith(" res") or lab.endswith(" reserves")
    if sport == "football":
        g = f"U{age}" if age else ("Reserves" if reserve else "Seniors")
    else:
        prefix = {"ladies": "Ladies", "hurling": "Hurling", "camogie": "Camogie"}[sport]
        g = f"{prefix} U{age}" if age else (f"{prefix} Reserves" if reserve and sport == "hurling" else prefix)
    suffix = re.search(r"\s(b|c|2|ii|iii)$", lab)
    if suffix and not reserve:
        g += " " + suffix.group(1).upper().replace("III", "3").replace("II", "2")
    return g


def strip_conceded(name: str) -> tuple[str, bool]:
    n = clean(name)
    if re.search(r"\(c\)\s*$", n, re.I):
        return re.sub(r"\s*\(c\)\s*$", "", n, flags=re.I), True
    return n, False


def tidy_comp(text: str) -> tuple[str, str]:
    parts = [p for p in re.split(r"\s+[-–]\s*|\s*[-–]\s+", clean(text)) if p.strip()]
    if not parts:
        return clean(text), ""
    # "B A Mullan Farms - U16A1/A2 Football Championship - ...": a sponsor split from its competition
    comp_word = re.compile(r"\b(championship|league|cup|shield|blitz|tournament|feile|final)\b", re.I)
    while len(parts) > 1 and not comp_word.search(parts[0]) and comp_word.search(parts[1]):
        parts[0:2] = [parts[0] + " " + parts[1]]
    parts[0] = re.sub(r"\s+(knockouts?|ko)$", "", parts[0], flags=re.I)
    comp = clean(re.sub(r"\b20\d\d\b", "", parts[0]))
    comp = " ".join(w.title() if (w.isupper() and len(w) > 3 and w.isalpha()) else w for w in comp.split())
    rnd = []
    for p in parts[1:]:
        q = fold(p)
        if q in ("knockout", "knockouts", "ko", "group stage", "league stage"):
            continue
        if re.fullmatch(r"semi ?finals?|sf\d*", q):
            p = "Semi-final"
        elif re.fullmatch(r"quarter ?finals?|qf\d*", q):
            p = "Quarter-final"
        elif re.fullmatch(r"finals?", q):
            p = "Final"
        rnd.append(clean(p))
    return comp, ", ".join(rnd)


def normalise(r: dict, today: date) -> dict:
    home, home_c = strip_conceded(r["home"])
    away, away_c = strip_conceded(r["away"])
    us = "home" if is_us(home) else "away"
    competition, rnd = tidy_comp(r["comp"])
    grade = grade_of(r["comp"], r.get("href", ""), home if us == "home" else away)
    hs, as_ = (r.get("hs") or "0-0").strip(), (r.get("as") or "0-0").strip()
    time = r["slot"] if TIME_RE.match(r.get("slot") or "") else None
    if time and len(time) == 4:
        time = "0" + time
    conceded_by = "home" if (home_c or hs.upper() == "CONC") else "away" if (away_c or as_.upper() == "CONC") else None
    if conceded_by or (r.get("slot") or "").lower() == "conceded":
        status = "conceded"
    elif hs == "0-0" and as_ == "0-0":
        status = "fixture" if date.fromisoformat(r["date"]) >= today else "awaiting"
    else:
        status = "result"
    return {
        "id": slug(f"{r['date']} {grade} {home} v {away}"),
        "date": r["date"], "time": time, "competition": competition, "round": rnd, "grade": grade,
        "home": home, "away": away,
        "homeScore": hs if status == "result" else None, "awayScore": as_ if status == "result" else None,
        "status": status, "concededBy": conceded_by, "us": us,
        "venue": clean(r.get("venue") or "") or "TBC",
        "referee": clean(r.get("ref") or "") or "TBC",
        "stream": clean(r.get("live") or "") or None,
    }


RANK = {"result": 3, "conceded": 3, "awaiting": 1, "fixture": 1}


def merge(old: list[dict], new: list[dict], today: date) -> list[dict]:
    by_id: dict[str, dict] = {}
    for m in new:                                      # team page and county listing may both list a game
        prev = by_id.get(m["id"])
        if prev is None or RANK[m["status"]] > RANK[prev["status"]]:
            by_id[m["id"]] = m
    for m in old:
        cur = by_id.get(m["id"])
        if cur is None:
            if m["status"] in ("result", "conceded"):
                by_id[m["id"]] = m                      # keep history the pages no longer show
            elif m["status"] in ("fixture", "awaiting") and m["date"] >= (today - timedelta(days=21)).isoformat():
                m = dict(m, status="fixture" if m["date"] >= today.isoformat() else "awaiting")
                by_id[m["id"]] = m
        elif m["status"] in ("result", "conceded") and cur["status"] in ("fixture", "awaiting"):
            by_id[m["id"]] = m                          # a lagging page never undoes a result
    return sorted(by_id.values(), key=lambda m: (m["date"], m["time"] or "99:99", m["id"]))


# --------------------------------------------------------------------------
# Calendar feeds
# --------------------------------------------------------------------------

VTIMEZONE = ["BEGIN:VTIMEZONE", "TZID:Europe/London", "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0000", "TZOFFSETTO:+0100",
             "TZNAME:BST", "DTSTART:19700329T010000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
             "BEGIN:STANDARD", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0000", "TZNAME:GMT", "DTSTART:19701025T020000",
             "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE"]


def _ics_text(s: str) -> str:
    return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _fold_line(line: str) -> list[str]:
    out, cur = [], ""
    for ch in line:
        if len((cur + ch).encode("utf-8")) > 74:
            out.append(cur)
            cur = " " + ch
        else:
            cur += ch
    return out + [cur]


def short(name: str) -> str:
    return "Ballinascreen" if is_us(name) else name


def build_ics(matches: list[dict], cal_name: str, stamp: str) -> str:
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ballinascreen GAC//Fixtures//EN", "CALSCALE:GREGORIAN",
             "METHOD:PUBLISH", "X-WR-CALNAME:" + _ics_text(cal_name), "X-WR-TIMEZONE:Europe/London",
             "REFRESH-INTERVAL;VALUE=DURATION:PT2H", "X-PUBLISHED-TTL:PT2H", *VTIMEZONE]
    for m in matches:
        d = date.fromisoformat(m["date"])
        if m["status"] == "result":
            title = f"{m['grade']}: {short(m['home'])} {m['homeScore']} {short(m['away'])} {m['awayScore']}"
        else:
            title = f"{m['grade']}: {short(m['home'])} v {short(m['away'])}" + (" (conceded)" if m["status"] == "conceded" else "")
        desc = [m["competition"] + (f", {m['round']}" if m["round"] else "")]
        if m["referee"] and m["referee"] != "TBC":
            desc.append("Referee: " + m["referee"])
        if m["stream"]:
            desc.append("Live on " + m["stream"])
        ev = ["BEGIN:VEVENT", f"UID:{m['id']}@ballinascreen-gac", "DTSTAMP:" + stamp]
        if m["time"]:
            hh, mm = map(int, m["time"].split(":"))
            start = datetime(d.year, d.month, d.day, hh, mm)
            end = start + timedelta(minutes=105 if m["grade"] in ("Seniors", "Reserves", "Hurling") else 90)
            ev += [f"DTSTART;TZID=Europe/London:{start:%Y%m%dT%H%M%S}", f"DTEND;TZID=Europe/London:{end:%Y%m%dT%H%M%S}"]
        else:
            ev += [f"DTSTART;VALUE=DATE:{d:%Y%m%d}", f"DTEND;VALUE=DATE:{d + timedelta(days=1):%Y%m%d}"]
        ev += ["SUMMARY:" + _ics_text(title), "LOCATION:" + _ics_text("" if m["venue"] == "TBC" else m["venue"]),
               "DESCRIPTION:" + _ics_text("\n".join(desc)), "END:VEVENT"]
        lines += ev
    lines.append("END:VCALENDAR")
    return "\r\n".join(x for ln in lines for x in _fold_line(ln)) + "\r\n"


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def fetch(url: str) -> str:
    import requests
    r = requests.get(url, timeout=40, headers={
        "User-Agent": "Mozilla/5.0 (compatible; ClubFixturesBot/1.0; club fixtures page)",
        "Accept-Language": "en-GB,en;q=0.9"})
    r.raise_for_status()
    return r.text


def annotate(title: str, lines: list[str]) -> None:
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    body = ("\n".join(lines) or "(nothing)").replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    print(f"::notice title={title.replace(',', ' -').replace(':', ' ')}::{body[:60000]}")
    summ = os.environ.get("GITHUB_STEP_SUMMARY")
    if summ:
        with open(summ, "a", encoding="utf-8") as fh:
            fh.write(f"### {title}\n\n" + "\n".join(f"- {l}" for l in lines) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", action="append", default=[], help="team=path / all=path / finder=path")
    ap.add_argument("--out", default=str(DOCS))
    ap.add_argument("--today")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    report: list[str] = []
    log = lambda s: (print(s), report.append(s))
    out = Path(args.out)
    data_dir = out / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    today = date.fromisoformat(args.today) if args.today else datetime.now(LONDON).date()
    saved = dict(x.split("=", 1) for x in args.html)
    load = lambda key, url: Path(saved[key]).read_text(encoding="utf-8") if key in saved else fetch(url)

    json_path = data_dir / "fixtures.json"
    old = {}
    if json_path.exists():
        try:
            old = json.loads(json_path.read_text(encoding="utf-8"))
        except ValueError:
            old = {}

    pages: dict[str, str] = {}
    try:
        pages["all"] = load("all", ALL_URL) if (not saved or "all" in saved) else ""
    except Exception as e:          # noqa: BLE001
        log(f"Derry GAA county listing could not be loaded ({e.__class__.__name__}: {e})")

    team_url = old.get("source") if str(old.get("source", "")).startswith(BASE) else None
    if not team_url and "team" not in saved:
        for i, url in enumerate(FINDER_PAGES):
            try:
                html = pages.get("all") if url == ALL_URL else load(f"finder{i}", url)
            except Exception as e:  # noqa: BLE001
                log(f"could not load {url} ({e.__class__.__name__})")
                continue
            team_url = find_team_link(html or "")
            if team_url:
                log(f"Found Ballinascreen's Derry GAA page: {team_url}")
                break
        if not team_url:
            log("Could not find Ballinascreen's team page on Derry GAA yet; using the county listing only.")
    if "team" in saved or team_url:
        try:
            pages["team"] = load("team", team_url)
        except Exception as e:      # noqa: BLE001
            log(f"Team page could not be loaded ({e.__class__.__name__}: {e})")

    raw = []
    for key in ("team", "all"):
        if pages.get(key):
            rows = parse_cc(pages[key])
            ours = [r for r in rows if is_us(r["home"]) != is_us(r["away"])]
            log(f"{key} page: {len(rows)} games, {len(ours)} involving Ballinascreen")
            raw += ours
    if not raw:
        log("No Ballinascreen games could be read - existing data left alone.")
        annotate("Fixtures refresh found nothing", report)
        return 1

    new = [normalise(r, today) for r in raw]
    matches = merge(old.get("matches", []), new, today)
    source = team_url or old.get("source")
    if old.get("matches") == matches and old.get("source") == source:
        log(f"No changes ({len(matches)} games).")
        annotate("Fixtures checked - no changes", report)
        return 0
    if args.dry_run:
        log(f"Would write {len(matches)} games.")
        annotate("Fixtures refresh (dry run)", report)
        return 0

    updated = datetime.now(timezone.utc).replace(microsecond=0)
    grades = sorted({m["grade"] for m in matches})
    doc = {"club": CLUB_NAME, "source": source, "updated": updated.isoformat().replace("+00:00", "Z"),
           "calendars": [{"grade": g, "file": f"fixtures-{slug(g)}.ics"} for g in grades], "matches": matches}
    body = json.dumps(doc, ensure_ascii=False, indent=1)
    json_path.write_text(body + "\n", encoding="utf-8")
    (data_dir / "fixtures.js").write_text("window.CLUB_FIXTURES = " + body + ";\n", encoding="utf-8")
    stamp = updated.strftime("%Y%m%dT%H%M%SZ")
    (out / "fixtures.ics").write_text(build_ics(matches, "Ballinascreen GAC – all teams", stamp), encoding="utf-8")
    for g in grades:
        (out / f"fixtures-{slug(g)}.ics").write_text(
            build_ics([m for m in matches if m["grade"] == g], f"Ballinascreen GAC – {g}", stamp), encoding="utf-8")
    n_fix = sum(m["status"] == "fixture" for m in matches)
    log(f"Wrote {len(matches)} games ({n_fix} upcoming) across {len(grades)} teams: {', '.join(grades)}.")
    annotate("Fixtures refreshed", report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
