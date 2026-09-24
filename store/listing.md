# Chrome Web Store listing — copy / paste sheet

Upload `dkbbdb-extension-<version>.zip` from this folder (rebuild it with `python scripts/package-extension.py`).

## Store listing tab

**Name** (comes from the zip): Best Ball Portfolio Sync for dkbbdb

**Summary** (comes from the zip): Sends your own best ball drafts from your DraftKings contests page to dkbbdb.com. Not affiliated with DraftKings.

**Description**

```
dkbbdb.com is a free, live-scored leaderboard for DraftKings best ball teams. This extension is how your teams get there.

HOW IT WORKS
1. Open your DraftKings contests page while signed in to DraftKings.
2. Click "Sync to dkbbdb" in the small panel the extension adds to that page.
3. Your season-long best ball teams appear on the dkbbdb.com leaderboard under your DraftKings username, scored live from public NFL stats. No sign-up.

Sync again whenever you draft new teams. Drafts that are already on dkbbdb are never read twice.

WHAT IT READS
Only your own paid, season-long best ball entries, each one's draft board (the 12 usernames in the league and who drafted whom), and the payout table of each tournament you are in — and only when you click Sync.

WHAT IT NEVER TOUCHES
Your DraftKings password, cookies, email, balance or payment details. It does nothing on any other page or site.

Everything you sync is public on dkbbdb.com. Privacy policy and how to have your teams removed: https://dkbbdb.com/privacy

Independent tool — not affiliated with, endorsed by, or sponsored by DraftKings. DraftKings is a trademark of its owner.
```

**Category:** Sports (or "Tools" if Sports is not offered)
**Language:** English
**Store icon:** `icon-128.png` in this folder
**Screenshots (1280×800):** `screenshot-1-leaderboard.png`, `screenshot-2-player.png`, `screenshot-3-team.png`
**Homepage URL:** https://dkbbdb.com
**Support URL:** https://dkbbdb.com/connect

## Privacy practices tab

**Single purpose**

```
Reads the user's own best ball drafts from their DraftKings "My Contests" page when they click Sync, and uploads them to dkbbdb.com so the teams appear on its public leaderboard.
```

**Permission justifications**

- `storage`: `Remembers the time and result of the last sync so the popup can show it. Nothing else is stored.`
- Host permission `https://www.draftkings.com/*` (content script on /mycontests): `The extension adds a Sync panel to the user's My Contests page and reads the list of the user's own best ball entries that the page already contains.`
- Host permission `https://api.draftkings.com/*`: `For each of the user's own best ball entries it requests that entry's draft board, the same request the DraftKings site makes, using the user's existing session. Credentials are never read.`
- Host permission `https://dkbbdb.com/*`: `Uploads the drafts to the dkbbdb.com API and asks it which drafts it already has, so nothing is fetched twice.`
- Remote code: `No, I am not using remote code.`

**Data usage — what to tick**

- Personally identifiable information: **yes** (the user's DraftKings username)
- Website content: **yes** (the draft boards read from DraftKings)
- Everything else (health, financial/payment, authentication, personal communications, location, web history, user activity): **no**

Tick all three certifications (not sold to third parties; not used for purposes unrelated to the single purpose; not used for creditworthiness / lending).

**Privacy policy URL:** https://dkbbdb.com/privacy

## Distribution tab

- Visibility: **Unlisted** for the friends beta (anyone with the link can install; it does not appear in search), switch to **Public** at launch.
- Regions: all (or United States + Canada, where DraftKings operates).
- Contact email (Account tab): dkbbdb.site@gmail.com — Google asks to verify it.
