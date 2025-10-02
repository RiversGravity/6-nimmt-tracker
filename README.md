# 6 Nimmt Tracker

Tampermonkey userscript that enhances BoardGameArena's **6 Nimmt!** tables with live card tracking, round detection, and an ISMCTS-based recommendation panel.

## Quick start (first-time setup)

1. **Install Tampermonkey.** Grab the extension for your browser from [tampermonkey.net](https://www.tampermonkey.net/).
2. **Install the tracker.** Click the userscript link below; Tampermonkey will pop up an install dialog:
   - [Install 6 Nimmt Tracker](https://raw.githubusercontent.com/RiversGravity/6-nimmt-tracker/main/6-nimmt-script.user.js)
3. **Confirm installation.** In the Tampermonkey tab that opens, press **Install**. The script is now active for any BoardGameArena page.
4. **Join a 6 Nimmt table.** Open or refresh a game on BoardGameArena; the tracker panel appears automatically in the top-right corner once the table loads.

### After installation

- The script auto-updates: Tampermonkey periodically re-downloads [`6-nimmt-script.user.js`](https://raw.githubusercontent.com/RiversGravity/6-nimmt-tracker/main/6-nimmt-script.user.js). Whenever we publish a new build (and bump `@version`), it replaces your local copy automatically.
- You can force an update at any time from the Tampermonkey icon → *Check for userscript updates*.
- To temporarily disable the tracker, toggle it off from the Tampermonkey dashboard without uninstalling.

### Common troubleshooting

- **No install prompt?** Make sure you visited the `.user.js` link above. If the tab shows the raw code instead, Tampermonkey might be disabled—re-enable the extension and retry.
- **Tracker not appearing in-game?** Verify the script is enabled in the Tampermonkey dashboard and refresh the BoardGameArena table once.
- **Stuck on an older build?** Use *Check for userscript updates* or uninstall/reinstall the script via the link above.

## Local development

- Edit `6-nimmt-script.user.js` directly; it is the single source of truth.
- Use the metadata block to increment `@version` whenever you ship behavioral changes so Tampermonkey clients refresh promptly.
- To test without publishing, load the script into Tampermonkey via *Utilities → Import from file* and select your local copy.

## Support

Report issues or feature requests at <https://github.com/RiversGravity/6-nimmt-tracker/issues>.
