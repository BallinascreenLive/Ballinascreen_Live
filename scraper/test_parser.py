"""Checks scraper/scrape.py against pages shaped like Derry GAA (Club & County).

Run:  python scraper/test_parser.py
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import scrape  # noqa: E402

TEAM_URL = "https://derry.clubandcounty.com/fixtures-results/team/ballinascreen/1b2c3d4e-0000-4000-8000-1234567890ab/"


def comp_link(text, sport, links=True):
    href = f"https://derry.clubandcounty.com/fixtures-results/{sport}/club/x/y/6ebd6106-f1d1-430b-b0d7-27a78d469151/"
    return f'<a href="{href}">{text}</a>' if links else f"<span>{text}</span>"


def team(text, url="https://derry.clubandcounty.com/fixtures-results/team/x/0b2c3d4e-0000-4000-8000-1234567890ab/", links=True):
    return f'<a href="{url}">{text}</a>' if links else f"<span>{text}</span>"


def game(comp, sport, home, hs, time, as_, away, venue="TBC", ref="TBC", links=True, split=False, live=None):
    def sc(s):
        if split and "-" in s:
            a, b = s.split("-")
            return f"<span>{a}</span><span>-</span><span>{b}</span>"
        return f"<span>{s}</span>"
    h = team(home, TEAM_URL if "Ballinascreen" in home else None or "https://derry.clubandcounty.com/fixtures-results/team/o/1b2c3d4e-0000-4000-8000-000000000001/", links)
    a = team(away, TEAM_URL if "Ballinascreen" in away else "https://derry.clubandcounty.com/fixtures-results/team/o/1b2c3d4e-0000-4000-8000-000000000002/", links)
    extra = f"<p><strong>Live via:</strong> {live} <strong>Tickets:</strong> <a href='#'>Buy Tickets</a></p>" if live else ""
    return (f"<div>{comp_link(comp, sport, links)}<div>{h}{sc(hs)}<span>{time}</span>{sc(as_)}{a}</div>"
            f"<p><strong>Venue:</strong> <a href='#'>{venue}</a> <strong>Referee:</strong> {ref}</p>{extra}</div>")


def team_page(links=True):
    return f"""<html><body><nav><a href="/fixtures-results/football/club/senior/">SENIOR</a></nav>
<h1>Team: Ballinascreen</h1><section id="fixtures">
<h3>Saturday 14th Nov 2026</h3>
{game("O'Neills Senior Football League 2026 - Division 1 - Round 15", "football", "Ballinascreen", "0-0", "14:00", "0-0", "Lavey", "St Colm's Ballinascreen", "Barry Cassidy", links, live="Derry GAA TV")}
{game("Derry U16 Hurling League - Group A - Round 2", "hurling", "Kevin Lynch's", "0-0", "11:00", "0-0", "Ballinascreen", "Dungiven", links=links)}
<h3>Sunday 15th Nov 2026</h3>
{game("U14 Championship - Cup Division 1 - Semi Final", "ladies_football", "Ballinascreen", "0-0", "TBC", "0-0", "Glen", links=links)}
<button>Load more Fixtures</button></section><section id="results">
<h3>Saturday 7th Nov 2026</h3>
{game("Seconds/Junior Camogie League - Final", "camogie", "Ballinascreen", "2-6", "12:00", "1-8", "Swatragh", "Owenbeg", links=links, split=True)}
{game("Recreational Reserve League - Round 18", "football", "Ballinascreen Res", "1-12", "15:30", "0-9", "Desertmartin Res", "St Colm's Ballinascreen", links=links)}
<h3>Sunday 1st Nov 2026</h3>
{game("O'Neills Senior Football League - Division 1 - Round 14", "football", "Glen", "1-15", "14:00", "0-11", "Ballinascreen", "Glen", links=links)}
{game("MINOR Championship - Final", "ladies_football", "Ballinascreen", "0-0", "Conceded", "CONC", "Slaughtneil (C)", "TBC", links=links)}
{game("HSF Group U14A1B Football Championship - Quarter Final", "football", "Ballinascreen B", "3-7", "18:30", "2-10", "Lissan", "Lissan", links=links)}
<a class="more">Load more Results</a></section>
<table><tr><td><a href="#">Ballinascreen</a></td><td>3</td></tr></table></body></html>"""


def all_page():
    # all-county listing: has the Senior League result sooner, plus other clubs' games
    return f"""<html><body><h3>Sunday 1st Nov 2026</h3>
{game("O'Neills Senior Football League - Division 1 - Round 14", "football", "Glen", "1-15", "14:00", "0-11", "Ballinascreen", "Glen")}
{game("Intermediate Football League - Round 3", "football", "Ballymaguigan", "1-10", "14:00", "1-9", "Craigbane")}
<h3>Saturday 14th Nov 2026</h3>
{game("O'Neills Senior Football League 2026 - Division 1 - Round 15", "football", "Ballinascreen", "0-0", "14:00", "0-0", "Lavey", "St Colm's Ballinascreen")}
<a>Load more Results</a></body></html>"""


def run(pages, outdir, today="2026-11-08"):
    args = []
    for k, html in pages.items():
        f = Path(outdir) / f"{k}.html"
        f.write_text(html, encoding="utf-8")
        args += ["--html", f"{k}={f}"]
    p = subprocess.run([sys.executable, str(HERE / "scrape.py"), "--out", str(outdir), "--today", today] + args,
                       capture_output=True, text=True)
    data = json.loads((Path(outdir) / "data" / "fixtures.json").read_text()) if (Path(outdir) / "data" / "fixtures.json").exists() else None
    return p, data


def main():
    # 1. finding the club's team page from a page that links to it
    assert scrape.find_team_link(team_page()) == TEAM_URL
    assert scrape.find_team_link(all_page()) == TEAM_URL
    print("finds the club's Derry GAA page: OK")

    # 2. full parse, with and without links
    for links in (True, False):
        rows = [r for r in scrape.parse_cc(team_page(links)) if scrape.is_us(r["home"]) != scrape.is_us(r["away"])]
        assert len(rows) == 8, (links, len(rows))
    print("reads all 8 games, links or plain text: OK")

    out = Path(tempfile.mkdtemp())
    p, data = run({"team": team_page(), "all": all_page()}, out)
    assert p.returncode == 0, p.stdout + p.stderr
    ms = {(m["date"], m["grade"]): m for m in data["matches"]}
    assert len(data["matches"]) == 8, len(data["matches"])
    g = ms[("2026-11-14", "Seniors")]
    assert (g["status"], g["time"], g["venue"], g["referee"], g["stream"], g["round"], g["competition"]) == (
        "fixture", "14:00", "St Colm's Ballinascreen", "Barry Cassidy", "Derry GAA TV", "Division 1, Round 15",
        "O'Neills Senior Football League"), g
    h = ms[("2026-11-14", "Hurling U16")]
    assert h["us"] == "away" and h["home"] == "Kevin Lynch's", h
    lad = ms[("2026-11-15", "Ladies U14")]
    assert lad["time"] is None and lad["round"] == "Cup Division 1, Semi-final", lad
    cam = ms[("2026-11-07", "Camogie")]
    assert (cam["homeScore"], cam["awayScore"], cam["status"]) == ("2-6", "1-8", "result"), cam
    res = ms[("2026-11-07", "Reserves")]
    assert res["homeScore"] == "1-12", res
    sf = ms[("2026-11-01", "Seniors")]
    assert (sf["us"], sf["homeScore"], sf["awayScore"]) == ("away", "1-15", "0-11"), sf
    mn = ms[("2026-11-01", "Ladies U18")]
    assert (mn["status"], mn["concededBy"], mn["away"], mn["competition"]) == ("conceded", "away", "Slaughtneil", "Minor Championship"), mn
    b = ms[("2026-11-01", "U14 B")]
    assert b["round"] == "Quarter-final" and b["homeScore"] == "3-7", b
    assert data["source"] is None or data["source"].startswith("https://derry.clubandcounty.com"), data["source"]
    files = sorted(x.name for x in out.glob("fixtures*.ics"))
    assert "fixtures.ics" in files and "fixtures-hurling-u16.ics" in files and "fixtures-camogie.ics" in files, files
    js = (out / "data" / "fixtures.js").read_text()
    assert js.startswith("window.CLUB_FIXTURES = {"), js[:40]
    print("grades, scores, concessions, venue, referee, stream, calendars: OK -", ", ".join(c["grade"] for c in data["calendars"]))

    # 3. a lagging page never undoes a result, and history is kept
    lag = team_page().replace('<span>2-6</span><span>12:00</span><span>1-8</span>', '<span>0-0</span><span>12:00</span><span>0-0</span>')
    p, data2 = run({"team": lag.replace("Recreational Reserve League - Round 18", "XX")}, out)
    ms2 = {(m["date"], m["grade"]): m for m in data2["matches"]}
    assert ms2[("2026-11-07", "Camogie")]["homeScore"] == "2-6"
    assert ("2026-11-07", "Reserves") in ms2
    print("lagging page keeps results and history: OK")

    # 4. no change -> nothing rewritten
    before = (out / "data" / "fixtures.json").read_text()
    p, _ = run({"team": lag.replace("Recreational Reserve League - Round 18", "XX")}, out)
    assert "No changes" in p.stdout and (out / "data" / "fixtures.json").read_text() == before, p.stdout
    print("no needless rewrites: OK")

    # 5. nothing readable -> error, data untouched
    p, data3 = run({"team": "<html><body>down</body></html>", "all": "<html></html>"}, out)
    assert p.returncode == 1 and (out / "data" / "fixtures.json").read_text() == before
    print("unreadable pages leave data alone: OK")
    print("ALL OK")


if __name__ == "__main__":
    main()
