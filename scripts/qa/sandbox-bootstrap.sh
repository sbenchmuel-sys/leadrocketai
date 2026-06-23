#!/usr/bin/env bash
# QA sandbox bootstrap — make the mounted (Windows-built) node_modules runnable
# on the Linux Cowork sandbox so `npm test` / `npm run test:isolation` work.
#
# The mount carries a Windows `node_modules`; only the NATIVE binaries are
# platform-specific (rollup, esbuild, @swc/core). A full `npm install` can't
# finish inside the sandbox's 45s/command cap, so instead we add ONLY the
# matching Linux native packages — at the exact versions already resolved in the
# tree — alongside the existing win32 ones. Each tool selects its platform
# binary at runtime, so this is non-destructive to the Windows install too.
#
# Idempotent + resumable: skips packages already present and installs one at a
# time, so a run killed by the time cap can simply be re-run to continue.
#
# Usage (from anywhere):  bash scripts/qa/sandbox-bootstrap.sh [--deno] [--verify]
#   --deno    also install the Deno binary (for `npm run test:edge`), best-effort.
#   --verify  also run one unit test file end-to-end as proof.
#   Tip: if combined downloads risk the 45s cap, run the flags as a SEPARATE
#   command from the bare run — the script is idempotent, so the second run only
#   does the new work.
#
# NOTE: tsc is pure JS and already runs from the mount — just use
#       `npx tsc -b --noEmit` (the root tsconfig is a solution file; plain
#       `tsc --noEmit` checks nothing and passes vacuously).
set -u
cd "$(dirname "$0")/../.." || exit 1   # repo root

WANT_DENO=0; WANT_VERIFY=0
for a in "$@"; do
  case "$a" in
    --deno)   WANT_DENO=1 ;;
    --verify) WANT_VERIFY=1 ;;
    *) echo "Unknown flag: $a (use --deno and/or --verify)"; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Linux" ]; then
  echo "Not Linux ($(uname -s)) — native deps are already correct here, nothing to do."
  exit 0
fi

case "$(uname -m)" in
  x86_64|amd64)  ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported arch $(uname -m); install native deps manually."; exit 1 ;;
esac
# esbuild ships a static (libc-agnostic) linux binary; rollup/swc are libc-specific.
if ldd --version 2>&1 | grep -qi musl; then LIBC=musl; else LIBC=gnu; fi
echo "Detected: linux-$ARCH ($LIBC libc)"

# Best-effort Deno install for `npm run test:edge`. Lands at node_modules/.bin/deno
# so npm scripts find it on PATH automatically (no global install, no repo churn —
# node_modules is gitignored). Never fails the script: vitest is the priority.
install_deno() {
  if command -v deno >/dev/null 2>&1; then
    echo "  ✓ deno already on PATH ($(deno --version 2>/dev/null | head -1))"; return 0
  fi
  if [ -x node_modules/.bin/deno ]; then
    echo "  ✓ deno already at node_modules/.bin/deno ($(node_modules/.bin/deno --version 2>/dev/null | head -1))"; return 0
  fi
  if [ "$LIBC" = "musl" ]; then
    echo "  ⚠ Deno has no official musl build — skipping; rely on the vitest mirrors."; return 0
  fi
  local triple
  case "$ARCH" in
    x64)   triple=x86_64-unknown-linux-gnu ;;
    arm64) triple=aarch64-unknown-linux-gnu ;;
    *) echo "  ⚠ no Deno build for $ARCH — skipping."; return 0 ;;
  esac
  local url="https://github.com/denoland/deno/releases/latest/download/deno-${triple}.zip"
  local tmp; tmp="$(mktemp -d)"
  echo "  → downloading $url"
  if ! curl -fsSL "$url" -o "$tmp/deno.zip"; then
    echo "  ⚠ download failed — skipping Deno (vitest mirrors still cover the logic)."; rm -rf "$tmp"; return 0
  fi
  mkdir -p node_modules/.bin
  if command -v unzip >/dev/null 2>&1; then
    unzip -o -j "$tmp/deno.zip" deno -d node_modules/.bin >/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import zipfile; zipfile.ZipFile('$tmp/deno.zip').extract('deno','node_modules/.bin')"
  else
    echo "  ⚠ no unzip or python3 to extract — skipping Deno."; rm -rf "$tmp"; return 0
  fi
  chmod +x node_modules/.bin/deno
  rm -rf "$tmp"
  if node_modules/.bin/deno --version >/dev/null 2>&1; then
    echo "  ✓ deno → node_modules/.bin/deno ($(node_modules/.bin/deno --version | head -1))"
    echo "    (npm run test:edge finds it automatically — npm puts node_modules/.bin on PATH)"
  else
    echo "  ⚠ deno binary won't run here (libc mismatch?) — skipping."
  fi
}

# Read by relative path — a bare specifier (`rollup/package.json`) is blocked by
# packages' `exports` maps; a file path is not.
ver() { node -p "require('./node_modules/$1/package.json').version" 2>/dev/null; }
ROLLUP_V=$(ver rollup)
ESBUILD_V=$(ver esbuild)
SWC_V=$(ver @swc/core)

# package name -> pinned version, matched to the installed core packages
names=()
specs=()
add() { [ -n "$2" ] && { names+=("$1"); specs+=("$1@$2"); }; }
add "@rollup/rollup-linux-$ARCH-$LIBC" "$ROLLUP_V"
add "@esbuild/linux-$ARCH"             "$ESBUILD_V"   # no libc suffix for esbuild
add "@swc/core-linux-$ARCH-$LIBC"      "$SWC_V"

installed_any=0
i=0
while [ $i -lt ${#names[@]} ]; do
  name="${names[$i]}"; spec="${specs[$i]}"; i=$((i+1))
  if [ -d "node_modules/$name" ]; then
    echo "  ✓ $name already present"
    continue
  fi
  echo "  → installing $spec"
  if npm i --no-save --no-package-lock --no-audit --no-fund "$spec"; then
    installed_any=1
  else
    echo "  ✗ install failed for $spec — re-run this script to resume."
    exit 1
  fi
done

# Functional check: exercise the esbuild + swc native binaries directly (fast).
echo "Verifying native binaries…"
node -e "require('esbuild').transformSync('const x=1', {}); console.log('  ✓ esbuild native ok')" \
  || { echo "  ✗ esbuild failed to load its native binary"; exit 1; }
node -e "require('@swc/core').transformSync('const x=1', {}); console.log('  ✓ @swc/core native ok')" \
  || { echo "  ✗ @swc/core failed to load its native binary"; exit 1; }
[ -d "node_modules/@rollup/rollup-linux-$ARCH-$LIBC" ] \
  && echo "  ✓ rollup native present (loaded on first bundle)"

if [ "$WANT_DENO" = 1 ]; then
  echo
  echo "Installing Deno (best-effort)…"
  install_deno
fi

echo
echo "✅ Sandbox ready. Run:"
echo "     npm test                       # unit suite (vitest)"
echo "     npx tsc -b --noEmit            # type-check (note: -b, solution file)"
echo "     npm run test:isolation         # live staging RLS isolation"
[ "$WANT_DENO" = 1 ] && echo "     npm run test:edge              # Deno edge suite"

if [ "$WANT_VERIFY" = 1 ]; then
  echo
  echo "End-to-end proof — running one unit test file:"
  npx vitest run src/lib/cleanBodyText.test.ts
fi
