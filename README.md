# Our Places

A small web app (PWA) for your shared list of bars and restaurants. Free to run: GitHub Pages + Firebase free plan + OpenStreetMap.

## 1. Create the Firebase project (about 5 minutes)

1. Go to https://console.firebase.google.com → **Add project** (disable Google Analytics, you don't need it).
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable.**
3. **Build → Firestore Database → Create database** (production mode, pick a European region, e.g. `eur3`).
4. In Firestore, open the **Rules** tab. Paste the content of `firestore.rules`, replace the two example emails with yours and your partner's (lowercase), then **Publish**.
5. **Project settings (gear icon) → Your apps → Web (`</>`)** → register an app. Copy the `firebaseConfig` values into `firebase-config.js`.

## 2. Put it on GitHub Pages

1. Create a new GitHub repository (public is fine, the Firebase settings are not secrets).
2. Upload all files of this folder to it (keep the `icons` folder), **except `firestore.rules`**. Don't put your real emails in any file that goes on GitHub: the repo is public. The rules are pasted directly into the Firebase console (step 4 above), which is private.
3. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root → Save.**
4. After a minute the app is live at `https://<your-username>.github.io/<repo-name>/`.

## 3. First launch

1. Open the URL on your phone, tap **First time? Create the account** and sign up with your email. Your partner does the same with theirs.
2. Once both accounts exist, in Firebase go to **Authentication → Settings → User actions** and turn off **Enable create (sign-up)**, so nobody else can register.
3. Install it:
   - **iPhone (Safari):** Share → **Add to Home Screen**.
   - **Android (Chrome):** menu → **Install app / Add to Home screen**.
4. Allow location when asked.

## What it does

- Map (OpenStreetMap) and list views, filters by type, cuisine, city, status, price level and "open now".
- Jumps to the city you're in (nearest city that has saved places, within 40 km).
- Distance from you with an estimated walking time (straight line at 5 km/h).
- Three ratings (food, vibe, value for money) plus the average, one shared rating per place.
- Wishlist / visited, price level (€ under 15, €€ 15–30, €€€ 30–60, €€€€ over 60 per person), notes, one photo per place.
- Add a place: type "name + city" and tap **Find**. Address, coordinates and often the opening hours are filled in for you (OpenStreetMap / Nominatim).
- Random picker (respects the current filters), Open in Google Maps button.
- More menu: share a read-only link, backup to JSON (with photos), CSV export, JSON import.

## Import format (JSON)

```json
{ "places": [
  { "name": "Le Perroquet", "address": "31 Rue Saint-Gilles, 1060 Brussels", "city": "Brussels",
    "types": ["bar", "cocktail bar"], "cuisines": ["french"], "status": "wishlist",
    "ratings": { "food": 4, "vibe": 5, "value": 3 }, "price_level": 2,
    "opening_hours": "Mo-Su 12:00-23:00", "notes": "Try the negroni" }
] }
```

`lat` / `lon` are optional: missing ones are looked up from the address (about 1 place per second).
Opening hours use the OpenStreetMap style: `Mo-Fr 09:00-18:00; Sa 10:00-14:00; Su off`.

## Good to know

- Photos are shrunk to about 900 px and stored inside Firestore, which keeps everything on the free plan (Firebase's file storage needs a billing card).
- Share links are snapshots with no notes and no photos. Anyone with the link can open them.
- The free Firebase plan is far above what two people will use.
- The OpenStreetMap public tile server and address search are meant for light use, which fits a personal app. Don't bulk-import thousands of places.
