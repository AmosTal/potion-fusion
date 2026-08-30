# Potion Fusion 🧪

A colour-mixing sort puzzle. Every other sorting game tells you not to mix —
this one says **mix**. Pour two primaries together and they fuse into a new
colour, but fusion shrinks the potion, so every mix is a real decision.

**▶ Play: https://amostal.github.io/potion-fusion/**

Works on phones and desktop, installs to your home screen, and plays fully
offline once loaded. No account, no sign-up.

- Fuse colours on purpose — red + yellow = orange, and deeper chains unlock
  teal, magenta and lime
- Fill order flasks that cork at 4/4; plan your pours and your space
- Two spendable tools bend the rules: a pipette lifts one unit, a catalyst
  splits a mixed unit back into its parts
- Raise an aquarium: 12 fish species across 5 rarity tiers, a collection
  album, and tanks you decorate to complete
- Every level is generated backwards from a solution and solver-verified, so
  it is always winnable; undo and restart are always free

Also on Android — see the [sideload APK][apk].

[apk]: https://github.com/AmosTal/try/tree/main/potion-fusion/dist

---

This repository is the deployed web build. It is generated from the game
source by `web/build.sh` in the main project repository; edit the game
there, not here.

Served by GitHub Pages straight from `main` at `/` (root) — there is no
build step and no Actions workflow.
