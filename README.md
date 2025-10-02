# 6 Nimmt Tracker

Tampermonkey userscript that enhances BoardGameArena's **6 Nimmt!** tables with live card tracking, round detection, and an ISMCTS-based recommendation panel.

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open the raw userscript URL (Tampermonkey will prompt to install or update automatically):
   - [6-nimmt-script.user.js](https://raw.githubusercontent.com/RiversGravity/6-nimmt-tracker/main/6-nimmt-script.user.js)
3. Accept the installation prompt. The script will run automatically on BoardGameArena once installed.

Tampermonkey checks [`6-nimmt-script.meta.js`](https://raw.githubusercontent.com/RiversGravity/6-nimmt-tracker/main/6-nimmt-script.meta.js) for updates. Pushing to the `main` branch with a bumped `@version` field will trigger clients to pull the latest build on their next update cycle.

## Local development

- Edit `6-nimmt-script.user.js` directly; it is the single source of truth.
- Use the metadata block to increment `@version` whenever you ship behavioral changes so Tampermonkey clients refresh promptly.
- To test without publishing, load the script into Tampermonkey via *Utilities → Import from file* and select your local copy.

## Support

Report issues or feature requests at <https://github.com/RiversGravity/6-nimmt-tracker/issues>.
