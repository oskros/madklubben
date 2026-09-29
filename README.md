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
4. Share the key with the other two in private. Each of you pastes it once under "Log ind" on the site. It's kept only in that browser.

## Using it

- **New dinner:** Middage → "+ Ny middag". Enter the bill and "eget indskud" (paid on top of the account); the site works out the rest.
- **Photos:** in the Google Photos album choose "Download alle", unzip, and select the photos in the dinner's edit form. They're shrunk to 1600 px before upload. HEIC only works in Safari; in other browsers export as JPEG first. Paste the album link as well so the originals are one click away.
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
