# Now and Then brand

The brand guide is at https://claude.ai/artifact/EZtHFJbGomCacRv1VkaScQ (colors, list colors, type, icon, voice, motion). This folder holds the values it describes, so the web app and the native app read from one place.

- `tokens.json`: every color, font, size, radius and motion value. Change a value here first, then in `app/styles.css`, then in the guide.
- `tokens.css`: the same values as CSS custom properties.
- `icon/`: the **Margin line** app icon, chosen November 4, 2026.
  - `icon.svg`, `icon-1024.png`: full-bleed light icon (App Store, Icon Composer preview).
  - `icon-dark.svg`, `icon-dark-1024.png`: reference for the dark look.
  - `paper.svg`, `margin.svg`, `tick.svg`: the three layers to drop into Icon Composer, back to front, to build `NowAndThen.icon` for the native app. iOS makes the Dark, Clear and Tinted looks from them.

The web app's icons in `app/icons/` are rendered from these: `icon.svg`, `icon-192.png` and `icon-512.png` have rounded corners; `icon-maskable-512.png` and `apple-touch-icon.png` are full bleed because the system rounds them.
