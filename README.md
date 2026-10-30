# anime-alerts

Email and Discord alerts for the anime on your AniList. New episodes, new seasons, sequels, spin-offs, and release dates getting confirmed or pushed back.

It runs on Google Apps Script, so there's no server to host and nothing running on your computer. You send friends a link, they type in their email and AniList username, and it takes care of the rest.

## Why I made it

AniList has its own notifications, but as far as I can tell it doesn't email you, and I wanted this in my inbox and in Discord. The part I cared about most was new seasons. They usually show up as a brand new entry with their own ID, sometimes under a different name, so anything that watches one specific show never notices. This follows AniList's relation links instead (sequel, prequel, spin-off, side story, parent), so a new season gets caught whatever it's called.

## What you get

A message when:

- a show on your Watching list gets a new episode
- a show on your Planning list starts airing, or its release date gets confirmed or moves
- something related to anything on your lists is announced or starts airing: a sequel, prequel, spin-off, side story or parent work. If its date changes before it starts, you hear about that too.

They look like this:

```
📺 TOUGEN ANKI: Nikko Kegon Falls Arc — episode 4 is out
🆕 Dandadan 3rd Season — sequel of DAN DA DAN Season 2, announced (2027)
📅 SAKAMOTO DAYS Season 2 — release date updated (2027 → 2027-01)
```

Everyone picks email, Discord or both, and every message has an unsubscribe link that deletes their row from the sheet.

The first check for a new person just records where their list stands, so you don't get hit with every episode that's already out. Related entries that are announced but not released yet do get reported once, so that first email can be a bit of a catch-up.

## How it works

```
signup page (Apps Script web app)
      |  email, AniList username, optional Discord webhook
      v
Google Sheet  <- this is the whole database
      ^
      |  every 2 hours
checkAll() -> AniList GraphQL API -> anything new?
      |
      +--> email (MailApp) and/or Discord webhook
```

For every confirmed subscriber it pulls their public list (Watching, Planning, Completed, Repeating), then follows the relation links out from each show, up to 15 steps. It keeps going through entries you dropped or paused, so a chain doesn't die in the middle just because you skipped a season. What it has already told you is stored in a `seen` column in the sheet, which is how it avoids repeats. Relations are cached for 12 hours so it isn't hammering AniList.

| File | What it does |
| --- | --- |
| `src/Code.gs` | signup, confirmation, unsubscribe, the AniList checks, notifications |
| `src/Index.html` | the signup page |
| `src/appsscript.json` | manifest, only matters if you deploy with clasp |
| `tests/test.js` | runs the logic against fake AniList data |

## Setup

About ten minutes.

Use a regular @gmail.com account if you can. I first ran this from a Google account on a custom domain, and mail sent through Apps Script failed that domain's email authentication, so my mail provider flagged every alert as possible phishing. On a plain Gmail account the warnings were gone.

1. Make a blank Google Sheet, then go to Extensions → Apps Script.
2. Paste `src/Code.gs` over the default file. Add an HTML file named exactly `Index` and paste `src/Index.html` into it.
3. Pick `setup` in the function dropdown and run it. Approve the permissions (Advanced → Go to project (unsafe) → Allow; it's your own script). This creates the `Subscribers` and `RelCache` tabs and two triggers.
4. Deploy → New deployment → Web app. Set Execute as to Me and Who has access to Anyone. Copy the URL that ends in `/exec`.
5. Project Settings → Script Properties → add `BASE_URL` with that `/exec` URL. The confirm and unsubscribe links in emails are built from it.
6. Open the `/exec` URL, sign up with your own email and AniList username (your list has to be public), click the confirmation link, then run `checkAll` once from the editor.

Then share the `/exec` link with whoever you want to use it.

### Discord

The webhook field is optional. In a Discord channel it's Edit Channel → Integrations → Webhooks → New Webhook → Copy URL. Webhooks can post but can't send DMs, so use a channel only you can see. The unsubscribe link in each message works for anyone who can click it, so in a shared channel anyone there can unsubscribe you.

## Changing things

After you edit the code, redeploy with Deploy → Manage deployments → pencil icon → New version → Deploy. Don't use "New deployment", that gives you a new URL. Edits to the checking and alert code get picked up by the 2 hourly trigger as soon as you save. Page and signup changes (`Index.html`, `subscribe`) only go live after a new version.

Everything you'd want to tweak is in the `CFG` block at the top of `Code.gs`:

| Setting | Default | What it does |
| --- | --- | --- |
| `MAX_SUBSCRIBERS` | 30 | signups stop at this many rows |
| `MAX_PER_EMAIL` | 3 | AniList accounts allowed per email address |
| `MAX_CONFIRM_EMAILS_PER_DAY` | 25 | caps confirmation emails so signup spam can't burn through your mail quota |
| `REL_TTL_HOURS` | 12 | how long relations are cached |
| `REL_TYPES` | sequel, prequel, spin-off, side story, parent | relation types that count |
| `REL_FORMATS` | TV, TV short, movie, ONA, OVA, special | which formats can trigger an alert |
| `DEPTH` | 15 | how many relation steps to follow |
| `SENDER_NAME` | Anime Alerts | name on the emails |
| `RUN_BUDGET_MS` | 4.5 min | stop starting new subscribers after this long |

## Limits and things that bit me

- A regular Gmail account can send about 100 emails a day through Apps Script.
- Checks run every 2 hours and relations are cached for 12, so a new announcement can take most of a day to show up.
- AniList's relation data is filled in by volunteers, so a brand new season sometimes appears a day or two after it's announced.
- Apps Script kills any run at 6 minutes. The script stops starting new people at 4.5, but it can't cut one person's check short in the middle, and I haven't tried it on a list with many hundreds of shows.
- If you're signed into several Google accounts, the signup page can fail with a Drive "unable to open the file" error. It worked fine in a private window for me, so that's the fix to give anyone who hits it.

## Privacy

Whoever owns the sheet can see every subscriber's email, AniList username and webhook URL, so only run this for people who know that. Webhook URLs are secrets (anyone holding one can post to that channel), so don't paste them anywhere public. Nothing in this repo has any of that in it. Your `/exec` URL and sheet ID live in your own Apps Script project, not in the code.

## Tests

```
node tests/test.js
```

Needs only Node. It loads `Code.gs` with fake Google and AniList services and checks episode detection, Planning alerts, sequel, prequel and spin-off grouping, release date changes, not repeating alerts, and what the email and Discord messages look like.
