# Ballinascreen GAC (Naomh Colm) – fixtures, results and live scores

A mobile-first club website that:

- pulls every Ballinascreen fixture and result (football, ladies, hurling and camogie, every grade) from
  [Derry GAA](https://derry.clubandcounty.com/fixtures-results/), automatically, every 2 hours
  (every 30 minutes Friday to Sunday). The first run finds the club's own page on Derry GAA by itself.
- adds any game to a phone calendar (Apple, Outlook or Google), or subscribes people to a calendar
  for all teams or one team that updates by itself
- gives one-tap directions to the venue in Google Maps
- has live scoring: club scorers tap **Point** (white flag), **2 points** (orange flag) or **Goal**
  (green flag) and everyone watching the site sees the score change straight away, no login needed.
  Hurling and camogie games show just **Point** and **Goal**.
- lets admins add, promote and remove scorers from inside the site

It's free to run: GitHub Pages hosts the site, a GitHub Action refreshes the fixtures, and Firebase
(free Spark plan) stores live scores and logins.

## What's in the folder

| Path | What it is |
|---|---|
| `docs/` | The website. GitHub Pages serves this folder. |
| `docs/firebase-config.js` | Where you paste your Firebase settings (step 3). |
| `docs/data/fixtures.js` | Fixtures and results. Written by the scraper; don't edit by hand. Empty until the first refresh. |
| `docs/fixtures*.ics` | Calendar feeds people can subscribe to. Written by the scraper. |
| `scraper/scrape.py` | Reads Derry GAA (the club's team page and the county listing) and rebuilds the data and calendars. |
| `.github/workflows/refresh-fixtures.yml` | Runs the scraper on a schedule. |
| `firestore.rules` | Firebase security rules: who can score, who can manage scorers. |

## Setting it up (about 20 minutes, once)

### 1. Put it on GitHub

1. Use (or create) a **club** GitHub account so the web address doesn't show anyone's personal username.
2. Create a new **public** repository, e.g. `ballinascreen-gaa` (GitHub Pages needs public on a free account).
3. Upload everything in this folder, keeping the folder structure, including the hidden `.github` folder.
   (Easiest: on the repo page choose **Add file > Upload files** and drag the whole folder contents in.)

### 2. Turn on the website and the fixtures refresh

1. Repo **Settings > Pages**: Source = **Deploy from a branch**, Branch = `main`, folder = `/docs`. Save.
   A minute later the site is live at `https://<club-account>.github.io/ballinascreen-gaa/`.
2. Repo **Settings > Actions > General > Workflow permissions**: choose **Read and write permissions**. Save.
3. **Actions** tab: if asked, enable workflows. **Refresh fixtures** runs by itself straight after the upload
   (or press **Run workflow**). It should finish green in under a minute and the run summary says
   "Found Ballinascreen's Derry GAA page". If it goes red, see *If the fixtures stop updating* below.

The site already works at this point in **demo mode**: fixtures, results, calendars and directions are
live, and live scoring can be tried out but is only saved on the phone doing it.

### 3. Connect Firebase so live scores are shared

1. Go to [console.firebase.google.com](https://console.firebase.google.com), **Create a project**
   (e.g. `ballinascreen-gaa`). Google Analytics isn't needed.
2. **Build > Authentication > Get started > Sign-in method**: enable **Email/Password**.
3. **Build > Firestore Database > Create database**: location `europe-west2 (London)`, start in
   **production mode** (if asked for an edition, choose Standard).
4. In Firestore, open the **Rules** tab, replace everything with the contents of `firestore.rules`,
   and press **Publish**.
5. **Project settings** (cog icon) > **Your apps** > the `</>` web icon. Give it a name, skip hosting,
   and copy the `firebaseConfig` values into `docs/firebase-config.js` on GitHub (edit the file in the
   browser and commit).

### 4. Make yourself the owner (do this straight away)

1. Open the website and press **Scorer sign in** at the bottom.
2. Because nobody owns the site yet, it shows **Set up the site**. Enter your name, email and a password.
   You're now the owner: a permanent admin who can't be removed.

### 5. Add scorers

Signed in, press **Scorers** in the dark bar at the top. Enter a name and email and choose **Scorer**
or **Admin**. They get an email from Firebase with a link to choose their own password (tell them to
check spam). To take someone's access away, set them to **Removed**; you can restore them later.

## Scoring a game (for scorers)

1. Sign in, then press **Score live** on the game (it appears on the day of the game).
2. Tap **First half** at throw-in (or just start scoring; the first score starts the first half).
3. Each time an umpire raises a flag, tap the matching button under the right team:
   white = **Point**, orange = **2 points**, green = **Goal**.
4. Mis-tap? **Undo last score**, or **Remove** any score in the list underneath.
5. Tap **Half-time**, **Second half** and **Full-time** as the game goes on.

Scores are saved on the phone first, so poor signal at the pitch is fine: the page says
*Waiting for signal* and sends them by itself when the connection comes back. More than one scorer
can score the same game. Use **Share this game** to send the live link to a WhatsApp group.

**Add a game** (top bar) is for games that aren't on the Derry GAA site: challenge matches, blitzes,
cúl camps. They can be scored live the same way.

## Things worth knowing

- **Scores are shown the GAA way**, goals-points, where the points figure includes 2-pointers.
  1 goal, one 2-pointer and 3 single points is **1-5 (8)**.
- **Derry GAA only lists the next few fixtures per club.** Later games appear as they publish them.
  Older results are kept once seen, so the Results tab builds up over the season.
- **Directions** use the venue name as Derry GAA writes it. If one comes up wrong in Google Maps,
  add it to `VENUE_ALIASES` near the top of `docs/app.js` (home is already set to the grounds in Draperstown).
- After **2 hours past throw-in** a game moves from Fixtures to Results, showing the club scorer's score
  until the official result arrives.
- **Calendar subscriptions**: Apple and Outlook pick up changes within a few hours. Google Calendar
  can be slower.

## If the fixtures stop updating

Open the **Actions** tab and look at the latest **Refresh fixtures** run.

- **Red, "No Ballinascreen games could be read"**: Derry GAA changed their page layout, blocked the request,
  or (on the very first run) the club's page couldn't be found from the county listing. The site keeps
  showing the last good data. The parsing lives in `parse_cc()` in `scraper/scrape.py`;
  `python scraper/test_parser.py` checks it. To set the club's page by hand, put its address in
  `"source"` in `docs/data/fixtures.json`.
- **Workflows disabled**: GitHub pauses scheduled jobs after 60 days with no repository activity
  (it can happen over the winter). Press **Enable workflow** on the Actions tab.
- To run it by hand at any time: **Actions > Refresh fixtures > Run workflow**.

## Running it on a computer (optional)

```
pip install requests beautifulsoup4
python scraper/scrape.py            # fetch from Derry GAA and rebuild docs/data
cd docs && python -m http.server    # then open http://localhost:8000
```
