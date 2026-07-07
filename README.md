# karlkrecke.com

Personal website for Karl Krecke — a static HTML/CSS site hosted on Vercel.

## Structure

```
.
├── index.html          # Home page
├── projects/
│   └── index.html      # Projects (served at /projects)
├── tools/
│   └── index.html      # RevOps calculator (served at /tools)
├── karl-krecke.jpg     # Profile photo
└── CNAME               # Custom domain (karlkrecke.com)
```

## Analytics

- **Vercel Web Analytics** — via the official `/_vercel/insights/script.js` injection (active only in the Vercel-hosted environment).
- **PostHog** — product analytics via the standard JS snippet.

No Google Analytics.

## Deploying

This repo is connected to Vercel and auto-deploys on every push to `main`.
There is no build step — files are served statically.
