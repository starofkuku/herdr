{
  lib,
  stdenv,
  rustPlatform,
  callPackage,
  runCommand,
  zig_0_15,
  zstd,
  pkg-config,
  git,
  cctools ? null,
  xcbuild ? null,
}:

let
  manifest = lib.importTOML ../Cargo.toml;
  zigDeps = callPackage ../vendor/libghostty-vt/build.zig.zon.nix {
    name = "herdr-libghostty-vt-zig-cache";
    inherit zstd;
    linkFarm =
      name: entries:
      runCommand name { } ''
        mkdir -p $out
        ${lib.concatMapStringsSep "\n" (entry: ''
          cp -rL ${entry.path} $out/${entry.name}
        '') entries}
      '';
  };
in
rustPlatform.buildRustPackage {
  pname = "herdr";
  version = manifest.package.version;

  src = lib.fileset.toSource {
    root = ./..;
    fileset = lib.fileset.intersection (lib.fileset.fromSource (lib.sources.cleanSource ./..)) (
      lib.fileset.unions [
        ../assets
        ../docs/next/api/herdr-api.schema.json
        ../plugins
        ../src
        ../vendor/libghostty-vt
        ../vendor/libghostty-vt.vendor.json
        ../vendor/portable-pty
        ../build.rs
        ../Cargo.lock
        ../Cargo.toml
      ]
    );
  };

  cargoLock = {
    lockFile = ../Cargo.lock;
    outputHashes = {
      # `codex-trace-parser` is a git dependency, so its crate source is not in
      # the crates.io index and Nix cannot vendor it without a hash. Regenerate
      # this when the pinned revision in Cargo.lock changes:
      #   nix hash path $(nix eval --impure --raw --expr '\
      #     (builtins.fetchGit { url = "<repo>"; rev = "<rev>"; }).outPath')
      "codex-trace-parser-0.4.20" = "sha256-5sXupX5V99Tc4Akz9dTXQZbegqvlPlJP9a+pvEbhssA=";
    };
  };

  nativeBuildInputs = [
    git
    pkg-config
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [
    cctools
    xcbuild
  ];

  env = {
    LIBGHOSTTY_VT_OPTIMIZE = "ReleaseFast";
    LIBGHOSTTY_VT_SIMD = "true";
    LIBGHOSTTY_VT_ZIG_SYSTEM_DIR = zigDeps;
    ZIG = lib.getExe zig_0_15;
  };

  preBuild = ''
    export ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-global-cache"
    export ZIG_LOCAL_CACHE_DIR="$TMPDIR/zig-local-cache"
  '';

  # Rust tests are covered by the normal CI workflow. The Nix check is
  # intentionally build-only so it validates packaging inputs without
  # duplicating the full Rust test suite.
  doCheck = false;

  meta = {
    description = "Terminal workspace manager for AI coding agents";
    homepage = "https://herdr.dev";
    license = lib.licenses.agpl3Plus;
    mainProgram = "herdr";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
