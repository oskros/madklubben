# Madklubben

Our dinner club's site: every dinner with photos, menus and themes, the shared account's budget, and ideas for next time.

Plain static files served by GitHub Pages. Everything the site knows lives in `data.json` and `photos/`. Edits made on the site are committed straight to this repo through the GitHub API, and Pages republishes about a minute later. Nobody needs to touch git.

## Setup (once)

1. Create a public repo, push these files to `main`, and set `REPO.owner` / `REPO.name` at the top of `app.js`.
2. Settings → Pages → Deploy from branch → `main`, `/ (root)`.
3. Create the club's key: GitHub → Settings → Developer settings → Fine-grained tokens → Generate.
   - Repository access: only this repo
   - Permissions: Contents → Read and write
   - Expiration: the longest available, with a calendar reminder to renew it
4. On the site: "Log ind" → "Opsætning". Paste the token and choose the club password. The browser encrypts the token with the password and commits only the encrypted version as `key.json`. After that, everyone logs in with just the password.

To change the password or replace an expired token, run "Opsætning" again.

## Using it

- **New dinner:** Middage → "+ Ny middag". Enter the bill and "eget indskud" (paid on top of the account); the site works out the rest.
- **Photos:** in the dinner's edit form, choose the photos or drag them onto the Billeder section, then drag them into order. They're shrunk to 1600 px before upload. HEIC only works in Safari; in other browsers export as JPEG first.
- **Budget:** the balance is calculated as the latest bank balance plus monthly deposits (the rate × 3, on the 1st of each month) minus what dinners since then took from the account. Add the actual bank balance under Budget now and then to keep it honest.

## Checking the budget math

```
node check.mjs
```

## Later

- A map of the restaurants
- Who came, when not all three of us did
- Ratings and favourite dishes per dinner
- Photo captions and dates from EXIF
