# Contributing

Thanks for helping improve PlaySG. This project is a small production web app, so changes should stay scoped and easy to verify.

## Local Setup

Use Node 22, or any version that satisfies the `engines` field in `package.json`.

```bash
npm install
cp .env.example .env
npm run dev
```

The playground map and weather planning features work without private API keys. Leave `GA_MEASUREMENT_ID` blank locally unless you specifically want local analytics traffic.

## Checks

Before opening a pull request, run:

```bash
npm run check
```

This runs the production dependency audit and the Vite build.

## Pull Requests

- Keep pull requests focused on one behavior change or cleanup.
- Do not commit `.env`, credentials, local screenshots, `dist`, or `node_modules`.
- Explain user-visible changes and any production config changes.
- Include screenshots for UI changes when helpful.
- For data-source changes, document which source was used and whether credentials are required.

## Data And Credentials

Keep private deployment credentials server-side. Google Analytics is configured at runtime with `GA_MEASUREMENT_ID`; do not add build-time `VITE_` analytics variables.

If you update generated playground data, make sure the update complies with the source terms listed in `NOTICE.md`.
