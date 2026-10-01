# Notes for agents working on this site

Read `README.md` first. Everything the site shows comes from `data.json` and `photos/`. The UI is in Danish.

## Every time a dinner, course or photo is added: tag it

The "Retter" page is searched and filtered by tags, not only by the menu text. These live in each dinner in `data.json`:

- `dishTags`: `{ "<exact course text from menu>": [categories] }`. Every course should have an entry.
- `photoTags`: `{ "<photo file>": [categories and keywords] }`. Every photo should have an entry. A video (`.mp4`) is tagged from its thumbnail `t/<name>.jpg`.

Categories are a fixed list, spelled exactly like this (it is also `CATEGORIES` in `app.js`):

Fisk, Skaldyr, Okse, Svin, Lam, Fjerkræ, Vildt, Grønt, Svampe, Frugt, Nødder, Ost, Æg, Brød, Pasta & ris, Dessert, Petit four, Vin, Drinks

- Only the main ingredients count. A fish dish with a cress garnish is Fisk, not Grønt. Butter and cream never count.
- Caviar and roe count as Fisk. A cheese course is Ost. Petit four is for the small sweets served with coffee.
- Vin and Drinks are only for photos where the drink is the subject: a bottle, a label, a wine list, a cocktail. A glass in the background of a dish or people photo does not count. Photos with no course but tagged Vin or Drinks still appear on Retter.
- Photo keywords are 3–8 Danish lowercase words for what is clearly visible and might be searched for, e.g. "burrata", "østers", "rødbede", "menukort", "vinflaske", "selskab". Avoid generic words like "mad" or "tallerken", and don't guess at things you can't see.

Tags are keyed by the exact course text. If a course is renamed in the edit form, its old tags are dropped on save, so tag it again.

## Other conventions

- **Never overwrite an image under the same file name.** Phones and browsers cache images hard. A rotated or replaced photo gets a new name, e.g. `x.jpg` becomes `xr.jpg`.
- **Menus are copied verbatim** from the card or source, in whatever language they are in. Improve readability through layout only.
- **Borrowed photos** (from Instagram, TripAdvisor, blogs and so on) need a `photoCredits` entry and evidence that they show that dish: a caption naming it, a review or blog describing it, or clearly the same key ingredients. The `photoNotes` entry explains that evidence in Danish, e.g. "Restaurantens eget opslag fra november 2023: …". Start with "Fra <måned år>." when the photo is more than a few weeks from the visit. If you can't back it up, leave it out.
- **Photo order:** menu cards and room or exterior shots first, then the dishes in serving order.
- **Course links:** `photoCourses` maps a photo to 0-based course indexes. One photo may show several courses.
- **Estimated amounts** set `priceEstimate: true` and show with a "~".
