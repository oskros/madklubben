# Notes for agents working on this site

Read `README.md` first. Everything the site shows comes from `data.json` and `photos/`. The UI is in Danish.

## Every time a dinner, course or photo is added: tag it

The "Retter" page is searched and filtered by tags, not only by the menu text. These live in each dinner in `data.json`:

- `dishTags`: `{ "<exact course text from menu>": [categories] }`. Every course should have an entry.
- `photoTags`: `{ "<photo file>": [categories and keywords] }`. Every photo should have an entry. A video (`.mp4`) is tagged from its thumbnail `t/<name>.jpg`.

Categories are a fixed list, spelled exactly like this (it is also `CATEGORIES` in `app.js`):

Fisk, Skaldyr, Okse, Svin, Lam, Fjerkræ, Vildt, Kød, Grønt, Svampe, Frugt, Nødder, Ost, Æg, Brød, Pasta & ris, Snack, Forret, Hovedret, Dessert, Petit four, Vin, Drinks

- Every course also gets exactly one course type: Snack (one-bite starters), Forret, Hovedret, Dessert or Petit four. A cheese course after the main counts as Dessert. Sides served with the main are Hovedret.
- Only the main ingredients count. A fish dish with a cress garnish is Fisk, not Grønt. Butter and cream never count.
- Kød is added automatically to anything tagged Okse, Svin, Lam, Fjerkræ or Vildt, so don't add it yourself. Use Kød on its own only when the kind of meat is unknown.
- Caviar and roe count as Fisk. A cheese course is Ost. Petit four is for the small sweets served with coffee.
- Vin and Drinks are only for photos where the drink is the subject: a bottle, a label, a wine list, a cocktail. A glass in the background of a dish or people photo does not count. Photos with no course but tagged Vin or Drinks still appear on Retter.
- Photo keywords are 3–8 Danish lowercase words for what is clearly visible and might be searched for, e.g. "burrata", "østers", "rødbede", "menukort", "vinflaske", "selskab". Avoid generic words like "mad" or "tallerken", and don't guess at things you can't see.
- Dish photos (photos with a course) also get 1–3 colour words, lowercase, for the colours of the food itself, most dominant first. Ignore the plate, the table and the background. Allowed: rød, orange, gul, grøn, blå, lilla, lyserød, brun, sort, hvid (also `COLOURS` in `app.js`). Pale or cream food is hvid, darker browns (crust, caramel, roasted meat) are brun.

Tags are keyed by the exact course text. If a course is renamed in the edit form, its old tags are dropped on save, so tag it again.

## Other conventions

- Restaurant logos (`image`, in `restaurants/`) fill their card edge to edge. A logo on a plain background is trimmed to its content and padded with that same background colour to a 1.7:1 image, the logo taking up at most 80 % of the width and 78 % of the height, so cropping on narrow and wide cards never cuts into it. Photo-style logos are used as they are.

- **Never overwrite an image under the same file name.** Phones and browsers cache images hard. A rotated or replaced photo gets a new name, e.g. `x.jpg` becomes `xr.jpg`.
- **Menus are copied verbatim** from the card or source, in whatever language they are in. Improve readability through layout only.
- **Borrowed photos** (from Instagram, TripAdvisor, blogs and so on) need a `photoCredits` entry and evidence that they show that dish: a caption naming it, a review or blog describing it, or clearly the same key ingredients. The `photoNotes` entry explains that evidence in Danish, e.g. "Restaurantens eget opslag fra november 2023: …". Start with "Fra <måned år>." when the photo is more than a few weeks from the visit. If you can't back it up, leave it out.
- **Photo order:** menu cards and room or exterior shots first, then the dishes in serving order.
- **Course links:** `photoCourses` maps a photo to 0-based course indexes. One photo may show several courses.
- **Estimated amounts** set `priceEstimate: true` and show with a "~".
