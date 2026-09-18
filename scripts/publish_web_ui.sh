#!/usr/bin/env bash
#
# Build the browser UI and publish it to the rolling `web-ui` release.
#
# Frontend-only publish path. The UI is served from disk and is never embedded
# in the herdr binary, so a UI change does not need a herdr release. Publishing
# through a version tag would rebuild and upload the platform binaries even
# though no Rust changed, which is what this script exists to avoid.
#
# The page carries a `herdr-web-ui version:` marker that `herdr update web`
# compares against the installed copy. That comparison is string inequality, not
# ordering, but the marker still has to differ from what users already have or
# the update is treated as "already up to date" and skipped. The marker defaults
# to the crate version, so a frontend-only build must pass its own value through
# HERDR_WEB_UI_VERSION.
#
# Usage:
#   scripts/publish_web_ui.sh [--dry-run] [version]
#
# With no argument a version is derived from the crate version plus a UTC
# timestamp, which is unique per build and always distinct from the released
# crate version.
#
# --dry-run builds and runs every check, then stops before uploading. Use it to
# confirm the marker and the built page without touching the public release.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

dry_run=false
if [ "${1:-}" = "--dry-run" ]; then
    dry_run=true
    shift
fi

tag="${WEB_UI_TAG:-web-ui}"
asset="herdr-web-ui.html"
remote="${WEB_UI_REMOTE:-origin}"

# Resolve the repository the release lives in from the remote, so a fork or a
# different remote name publishes to the right place.
remote_url="$(git remote get-url "$remote" 2>/dev/null || true)"
if [ -z "$remote_url" ]; then
    echo "error: no git remote named '$remote'" >&2
    exit 1
fi
repo_slug="$(printf '%s' "$remote_url" | sed -e 's#^git@[^:]*:##' -e 's#^https\?://[^/]*/##' -e 's#\.git$##')"
if [ -z "$repo_slug" ] || [ "$repo_slug" = "$remote_url" ]; then
    echo "error: cannot derive owner/repo from remote url: $remote_url" >&2
    exit 1
fi

crate_version="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
if [ -z "$crate_version" ]; then
    echo "error: could not read version from Cargo.toml" >&2
    exit 1
fi

# `+` and `.` are accepted by the updater's marker parser.
version="${1:-${crate_version}+web.$(date -u +%Y%m%d%H%M%S)}"

# Reject values the updater would not be able to parse back out of the page.
if ! printf '%s' "$version" | grep -Eq '^[0-9][A-Za-z0-9.+-]*$'; then
    echo "error: version must start with a digit and contain only [A-Za-z0-9.+-]: $version" >&2
    exit 1
fi

command -v gh >/dev/null 2>&1 || {
    echo "error: gh is required to publish the UI" >&2
    exit 1
}

echo "publishing web UI to $repo_slug@$tag"
echo "  marker version: $version"
if [ "$dry_run" = true ]; then
    echo "  (dry run: nothing will be uploaded)"
fi

# Build. `bun run build` runs tsc first, so a type error fails the publish.
(
    cd web
    bun install --frozen-lockfile
    HERDR_WEB_UI_VERSION="$version" bun run build
)

built="web/dist/index.html"
[ -f "$built" ] || {
    echo "error: build did not produce $built" >&2
    exit 1
}

# The publish is worthless if the marker did not land, because the updater
# validates the downloaded page by looking for it.
marker="herdr-web-ui version: $version"
if ! grep -qF "$marker" "$built"; then
    echo "error: built page is missing the expected marker: $marker" >&2
    exit 1
fi

cp "$built" "$asset"

if [ "$dry_run" = true ]; then
    marker_in_build="$(grep -o 'herdr-web-ui version: [^ ]*' "$asset" | head -1)"
    size="$(wc -c < "$asset" | tr -d ' ')"
    echo
    echo "dry run complete"
    echo "  built page: $asset ($size bytes)"
    echo "  $marker_in_build"
    echo "  would upload to $repo_slug@$tag with --clobber"
    rm -f "$asset"
    exit 0
fi

# `--clobber` replaces the asset in place, which keeps the rolling tag stable.
# The release itself is created by the normal release workflow; if it is
# missing, create it so a UI publish does not depend on a herdr release.
if ! gh release view "$tag" --repo "$repo_slug" >/dev/null 2>&1; then
    echo "  creating rolling release '$tag'"
    gh release create "$tag" --repo "$repo_slug" \
        --title "herdr web UI (rolling)" \
        --notes "Rolling release for the herdr browser UI.

This tag always points at the newest UI build. It is published
alongside every release, but it is not versioned: the UI is served
from disk and can be updated without a new herdr binary.

Download \`herdr-web-ui.html\`, rename it to \`index.html\`, and point
\`[web] static_dir\` at its directory." \
        --latest=false
fi

gh release upload "$tag" "$asset" --repo "$repo_slug" --clobber
rm -f "$asset"

echo
echo "published $asset to $repo_slug@$tag"
echo "users pick it up with: herdr update web"
