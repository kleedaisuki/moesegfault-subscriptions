# Self-hosted style distribution

These CSS assets are the public, pinned `v0.1.2` static release of
[moesegfault-style](https://github.com/kleedaisuki/moesegfault-style), copied without
modification from `static-releases/v0.1.2/css/` at source checkout commit
`8441e3b0e6673d9be8111b6e75d2b07fb4189b08`.

Only `tokens.css`, `foundation.css`, `components.css`, and `assets/icons/brand.svg` are needed. Self-hosting
keeps the subscription and account-embed views independent of a third-party CSS
network request and avoids installing unrelated editor/Markdown dependencies.
The upstream license and third-party notices are included alongside this file.

Update all three stylesheets together from one exact upstream release. Do not edit
vendored files; add product overrides in `src/styles.css` using public semantic
tokens instead.
