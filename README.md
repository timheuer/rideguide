# Scottsdale Weekend Ride Guide

The guide is generated from `rides.yaml`; edit that file to update ride details.

## Generate the guide

1. Install Node.js 20 or newer.
2. Run `npm install` once.
3. Run `npm run build:html` to write `index.html` and `ride-guide.html`. For the PDF too, run `npm run build` (uses your installed Edge or Chrome; set `BROWSER_PATH` if it isn't found).
4. Open either HTML file, or run `npm start` to view the guide in a browser.

`index.html` is the GitHub Pages homepage, so publishing it at the site root makes the guide available at the short site URL. Use `npm run build:html` in the Pages build step; it does not require a browser.

The generator creates one section per ride, validates the fields it needs, and escapes ride-provided text before writing HTML. Each ride starts on a new printed page; long route notes can continue naturally onto another page.

## Publish with GitHub Pages

The workflow in `.github/workflows/deploy-pages.yml` builds and deploys the guide whenever changes are pushed to `main`. In the repository's **Settings > Pages**, set the build and deployment source to **GitHub Actions**. The workflow publishes only the generated `index.html`.

## Serve it locally

Run `npm start` and open <http://127.0.0.1:3000>. The guide is rebuilt on each page load, so refresh after editing `rides.yaml` or a GPX file. Set `PORT` or `HOST` to change the address (for example `HOST=0.0.0.0` to share on your network).

## Map and elevation profile

Add a `gpx_file` path (relative to this folder, e.g. `gpx/brownboldy.gpx`) to a ride. Export the GPX from Strava (route page > Export GPX) and save it there. The guide then shows a route map (OpenStreetMap tiles, so the map background needs an internet connection) and an elevation profile (metres, with elevation gain shown in each ride's facts alongside feet) with climbing, descending, high and low points. If the file is missing, the ride renders without them and a warning is logged.

## Ride data

Each entry in the top-level `rides` list needs:

- `route_name`
- `gpx_url` (an HTTP or HTTPS route link)
- `distance.kilometers` (miles are calculated automatically, rounded up to a whole number; `distance.miles` is only used if kilometers is omitted)
- `description`
- `start_location`

Optional: `gpx_file` for the map and elevation profile.
