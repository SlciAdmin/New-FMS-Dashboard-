# NDR MIS Dashboard

A static web dashboard that shows live MIS data from Google Sheets (through a Google Apps Script web app). It also lets users add comments to cells, which are written back to the sheet as notes.

**Live site:** https://slciadmin.github.io/New-FMS-Dashboard-/

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page layout |
| `style.css`  | Styles |
| `script.js`  | Data loading, charts (Chart.js), comments. Settings are in `CONFIG` at the top |

## Configuration

Edit `CONFIG` at the top of `script.js`:

- `SCRIPT_URL`: the deployed Apps Script web app URL (`/exec`)
- `SCRIPT_KEY`: must match `SECRET_KEY` in `Code.gs`
- `DEFAULT_SHEET`, `REFRESH_SECONDS`, `DEFAULT_WEEK_RANGE`

## Run locally

Open `index.html` in a browser, or serve the folder:

```sh
npx serve .
```

## Deployment

Every push to `main` deploys to GitHub Pages through `.github/workflows/pages.yml`.
In the repo, **Settings → Pages → Source** must be set to **GitHub Actions**.
