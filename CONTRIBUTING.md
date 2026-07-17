# Contributing

## Local setup

```sh
npm install
npm run check
npm run build
```

Package the extension with:

```sh
npm run package
```

## Validation

Before opening a pull request:

```sh
npm run check
npm run build
git diff --check
```

Keep protocol changes synchronized with [docs/CHATDEV_API_SPEC.md](docs/CHATDEV_API_SPEC.md). The specification is a proposal; do not describe server behavior as deployed until chat.dev production actually implements it.

## Documentation images

The editor walkthrough source is `docs/images/editor-screens.html`. Generated screenshots use Chromium at 1440 by 900 pixels. The wordmark and extension icon are cropped from a live `https://chat.dev` screenshot.

Example:

```sh
chromium --headless --no-sandbox --hide-scrollbars \
  --window-size=1440,900 \
  --screenshot=docs/images/install.png \
  'file:///absolute/path/to/docs/images/editor-screens.html?screen=install'
```

Inspect regenerated images before committing them. Text must be readable and dialogs must not overlap other interface elements.

## Pull requests

- Keep changes focused.
- Add or update tests for behavior changes.
- Explain user-visible changes in the pull-request description.
- Update `CHANGELOG.md` for release-worthy changes.
