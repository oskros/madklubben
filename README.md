# Madklubben

Our dinner club's site: every dinner with its menu and photos, a searchable page of every dish we've had, the club account's books, and ideas for next time.

Plain static files served by GitHub Pages. Everything the site knows lives in `data.json`, `photos/` and `restaurants/` (logos). Edits made on the site are committed straight to this repo through the GitHub API, and Pages republishes about a minute later. Nobody needs to touch git.

Agents editing data by hand: read `AGENTS.md` first (tagging, photo and logo conventions).

## Setup (once)

1. Create a public repo, push these files to `main`, and set `REPO.owner` / `REPO.name` at the top of `app.js`.
2. Settings → Pages → Deploy from branch → `main`, `/ (root)`.
3. Create the club's key: GitHub → Settings → Developer settings → Fine-grained tokens → Generate.
   - Repository access: only this repo
   - Permissions: Contents → Read and write
   - Expiration: the longest available, with a calendar reminder to renew it
4. On the site, open `#/opsaetning` (not linked anywhere). Paste the token and choose the club password. The browser encrypts the token with the password and commits only the encrypted version as `key.json`. After that, everyone logs in with just the password.

To change the password or replace a token GitHub has removed (after a year without use), open `#/opsaetning` again.

## Using it

- **Middage:** the front page. Logged in, "Ny middag" adds one. Enter the bill and "eget indskud" (paid on top of the account); the site works out the rest.
- **Photos:** in the dinner's edit form, choose the photos or drag them onto the Billeder section, drag them into order, and link each to the courses it shows. They're shrunk to 1600 px before upload. HEIC only works in Safari; in other browsers export as JPEG first.
- **Retter:** every course with a photo, searchable by name, ingredient category (fisk, ost, dessert…), course type and colour.
- **Regnskab:** income from the monthly rates, expenses per dinner, and a reconciliation against the bank. Add the bank balance now and then (or upload the bank's CSV) to keep it honest.
- **Forslag:** restaurants to try next.
- `#/config` (not linked) turns on Oskar's own visits in this browser only. They never touch the club account.

## Checking the account math

The account math (rates, deposits, balance, books, forecast, bank CSV) is in `ledger.js`, with no browser code, so it can be tested on its own:

```
node check.mjs
```
