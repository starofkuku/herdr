#!/bin/sh
set -eu

# Install the fork release directly from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/starofkuku/herdr/master/install.sh | sh
#
# Optional overrides:
#   HERDR_VERSION=0.7.5
#   HERDR_REPOSITORY=starofkuku/herdr
#   HERDR_INSTALL_DIR="$HOME/.local/bin"
#   HERDR_DOWNLOAD_URL=https://example.com/herdr-linux-x86_64

BIN="herdr"
VERSION="${HERDR_VERSION:-0.7.5}"
REPOSITORY="${HERDR_REPOSITORY:-starofkuku/herdr}"
INSTALL_DIR="${HERDR_INSTALL_DIR:-$HOME/.local/bin}"

main() {
    echo ""
    echo "      ,ww"
    echo "     wWWWWWWW_)  herdr installer"
    echo "     \`WWWWWW'    ${REPOSITORY}"
    echo "      II  II"
    echo ""

    need curl
    need mktemp

    OS="$(uname -s)"
    case "$OS" in
        Linux)  os="linux" ;;
        Darwin) os="macos" ;;
        *)      err "unsupported OS: $OS" ;;
    esac

    ARCH="$(uname -m)"
    case "$ARCH" in
        x86_64|amd64)  arch="x86_64" ;;
        aarch64|arm64) arch="aarch64" ;;
        *)             err "unsupported architecture: $ARCH" ;;
    esac

    asset="${BIN}-${os}-${arch}"
    case "$VERSION" in
        v*) tag="$VERSION"; display_version="${VERSION#v}" ;;
        *)  tag="v${VERSION}"; display_version="$VERSION" ;;
    esac
    url="${HERDR_DOWNLOAD_URL:-https://github.com/${REPOSITORY}/releases/download/${tag}/${asset}}"

    log "detected ${os}/${arch}"
    log "downloading v${display_version}..."

    TMP="$(mktemp -d)" || err "could not create a temporary directory"
    trap 'rm -rf "$TMP"' EXIT HUP INT TERM
    download="${TMP}/${BIN}"

    if ! curl -fsSL --retry 3 --connect-timeout 10 --max-time 120 "$url" -o "$download"; then
        err "download failed from ${url}; make sure release ${tag} contains ${asset}"
    fi

    chmod +x "$download"
    if ! "$download" --version >/dev/null 2>&1; then
        err "downloaded file is not a working ${BIN} binary for ${os}/${arch}"
    fi

    mkdir -p "$INSTALL_DIR"
    mv "$download" "${INSTALL_DIR}/${BIN}"
    log "installed ${BIN} v${display_version} to ${INSTALL_DIR}/${BIN}"

    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*) ;;
        *)
            echo ""
            warn "${INSTALL_DIR} is not in your PATH"
            echo "  add this line to your shell config:"
            echo ""
            echo "    export PATH=\"${INSTALL_DIR}:\$PATH\""
            ;;
    esac

    echo ""
    log "ready. run 'herdr' to get started."
    echo ""
}

log()  { printf '  \033[32m>\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
err()  { printf '  \033[31mx\033[0m %s\n' "$1" >&2; exit 1; }

need() {
    if ! command -v "$1" >/dev/null 2>&1; then
        err "requires '$1' -- install it first"
    fi
}

main "$@"
