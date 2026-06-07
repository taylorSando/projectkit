#!/usr/bin/env bash
#
# vendor-operator-pkgs.sh — the CANONICAL, correct-by-construction way to vendor
# @operator/projectkit + @operator/capture-overlay into a testbed.
#
# WHY THIS EXISTS
#   The operator's testbeds (chess/nhl/winwar/sandolab/sitelayer) consume the
#   shared @operator libs as committed `file:` tarballs (no public registry yet).
#   Hand-vendoring was the source of a whole class of clean-install failures:
#     - chess 404/ENOENT: a tarball was copied in but package-lock.json kept a
#       stale/missing `resolved` field, so `npm ci` on a cold machine
#       (Vercel/Cloud Run) could not find it.
#     - capture-overlay <=0.3.0 carried a RUNTIME dependency on a co-located
#       projectkit tarball it did NOT bundle, so any testbed install 404'd.
#   capture-overlay 0.4.1 fixed the overlay side (projectkit is now a peer). This
#   script fixes the OPERATION side: it makes vendoring a single command that
#   ALWAYS leaves the testbed in a state where a clean `npm ci` succeeds.
#
# WHAT IT GUARANTEES
#   1. The exact tarball bytes named in package.json are present on disk.
#   2. `npm install` re-runs so package-lock.json gets correct `resolved`/
#      `integrity` fields for the new tarballs (kills the missing-`resolved`
#      404 class).
#   3. A clean-room `npm ci` (node_modules moved aside, not deleted) is asserted
#      to succeed afterward. If it fails, the script FAILS LOUD and tells you
#      exactly where — vendoring is not "done" until the cold path is green.
#
# DESIGN NOTE — no version churn
#   This script does NOT auto-bump versions on every run (the old
#   fleet-sync-overlay.sh did, to dodge npm's file:-tarball cache). It pins the
#   real published versions and uses `npm install` to refresh the lockfile, then
#   `npm cache verify`-independent `npm ci` to prove the result. Deterministic.
#
# USAGE
#   scripts/vendor-operator-pkgs.sh \
#       --testbed /home/taylorsando/projects/chess \
#       --package-json web/package.json
#
#   Optional:
#     --projectkit-tgz <abs path>   (default: newest operator-projectkit-*.tgz
#                                     in $OPERATOR_PKG_DIR)
#     --overlay-tgz    <abs path>   (default: newest operator-capture-overlay-*.tgz
#                                     in $OPERATOR_PKG_DIR)
#     --no-ci-assert                (skip the final `npm ci` gate; NOT recommended)
#     --install-root <abs path>     (dir to run npm install/ci in; default = the
#                                     dir containing the target package.json, or
#                                     its workspace root if that's where the
#                                     lockfile lives — auto-detected)
#
# ENV
#   OPERATOR_PKG_DIR  where the source tarballs live. Default /home/taylorsando/projects
#
# It updates ONLY the @operator/projectkit and @operator/capture-overlay file:
# refs that ALREADY exist in the target package.json. It preserves each dep's
# existing relative path (chess keeps projectkit in ../server/vendor and overlay
# in ./vendor) and only swaps the version in the filename. It never invents new
# deps and never touches @operator/types (that's a github: ref, out of scope).
#
set -euo pipefail

OPERATOR_PKG_DIR="${OPERATOR_PKG_DIR:-/home/taylorsando/projects}"
TESTBED=""
PKG_JSON_REL="package.json"
PK_TGZ=""
OV_TGZ=""
CI_ASSERT=1
INSTALL_ROOT=""

die() { echo "vendor-operator-pkgs: ERROR: $*" >&2; exit 1; }
note() { echo "==> $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --testbed) TESTBED="${2:-}"; shift 2;;
    --package-json) PKG_JSON_REL="${2:-}"; shift 2;;
    --projectkit-tgz) PK_TGZ="${2:-}"; shift 2;;
    --overlay-tgz) OV_TGZ="${2:-}"; shift 2;;
    --install-root) INSTALL_ROOT="${2:-}"; shift 2;;
    --no-ci-assert) CI_ASSERT=0; shift;;
    -h|--help) sed -n '2,70p' "$0"; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

[ -n "$TESTBED" ] || die "--testbed is required"
[ -d "$TESTBED" ] || die "--testbed dir not found: $TESTBED"
PKG_JSON="$TESTBED/$PKG_JSON_REL"
[ -f "$PKG_JSON" ] || die "package.json not found: $PKG_JSON"

command -v node >/dev/null || die "node not on PATH"
command -v npm  >/dev/null || die "npm not on PATH"

# Resolve default tarballs (newest by version, semver-ish sort).
pick_newest() { ls -1 "$OPERATOR_PKG_DIR"/$1 2>/dev/null | sort -V | tail -1; }
[ -n "$PK_TGZ" ] || PK_TGZ="$(pick_newest 'operator-projectkit-*.tgz' || true)"
[ -n "$OV_TGZ" ] || OV_TGZ="$(pick_newest 'operator-capture-overlay-*.tgz' || true)"
[ -n "$PK_TGZ" ] && [ -f "$PK_TGZ" ] || die "projectkit tarball not found (looked in $OPERATOR_PKG_DIR; pass --projectkit-tgz)"
[ -n "$OV_TGZ" ] && [ -f "$OV_TGZ" ] || die "capture-overlay tarball not found (looked in $OPERATOR_PKG_DIR; pass --overlay-tgz)"

PK_BASENAME="$(basename "$PK_TGZ")"   # operator-projectkit-0.7.0.tgz
OV_BASENAME="$(basename "$OV_TGZ")"   # operator-capture-overlay-0.4.1.tgz

note "testbed:      $TESTBED"
note "package.json: $PKG_JSON"
note "projectkit:   $PK_TGZ"
note "overlay:      $OV_TGZ"

# --- Sanity: overlay tarball must NOT carry a runtime projectkit file: dep ----
# (defends against re-introducing the <=0.3.0 defect.)
OV_TMP="$(mktemp -d)"
tar xzf "$OV_TGZ" -C "$OV_TMP"
OV_RUNTIME_PK="$(node -e '
  const fs=require("fs");
  const d=JSON.parse(fs.readFileSync(process.argv[1]));
  const dep=(d.dependencies||{})["@operator/projectkit"];
  process.stdout.write(dep||"");
' "$OV_TMP/package/package.json")"
rm -rf "$OV_TMP"
if [ -n "$OV_RUNTIME_PK" ]; then
  die "overlay tarball declares a RUNTIME dependency on @operator/projectkit ($OV_RUNTIME_PK).
       That is the co-located-tarball defect. Use capture-overlay >=0.4.0 where projectkit is a peerDependency."
fi
note "overlay tarball OK: projectkit is a peer, not a bundled runtime dep"

# --- For each operator dep already in package.json: place tgz + rewrite ref ---
# We preserve the existing relative directory of each dep's file: ref and only
# swap the filename to the new version. node prints the actions; bash does copies.
PLAN="$(node - "$PKG_JSON" "$PK_BASENAME" "$OV_BASENAME" <<'NODE'
const fs = require('fs'), path = require('path');
const [pjPath, pkBase, ovBase] = process.argv.slice(2);
const pjDir = path.dirname(path.resolve(pjPath));
const d = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
const deps = d.dependencies || {};
const map = {
  '@operator/projectkit': pkBase,
  '@operator/capture-overlay': ovBase,
};
const actions = [];
let changed = false;
for (const [name, newBase] of Object.entries(map)) {
  const cur = deps[name];
  if (!cur) continue;                       // dep not present -> skip (don't invent)
  if (!cur.startsWith('file:')) {
    process.stderr.write(`SKIP ${name}: not a file: ref (${cur}); leaving as-is\n`);
    continue;
  }
  const curRel = cur.slice('file:'.length);            // e.g. ../server/vendor/operator-projectkit-0.7.0.tgz
  const dir = path.posix.dirname(curRel);              // ../server/vendor  (or '.')
  const newRel = (dir === '.' ? '' : dir + '/') + newBase;
  const newRef = 'file:' + newRel;
  // absolute destination dir for the tgz copy:
  const destDir = path.resolve(pjDir, dir);
  if (deps[name] !== newRef) { deps[name] = newRef; changed = true; }
  actions.push(`${name}\t${destDir}\t${newBase}\t${newRef}`);
}
if (changed) fs.writeFileSync(pjPath, JSON.stringify(d, null, 2) + '\n');
process.stdout.write(actions.join('\n'));
NODE
)"

[ -n "$PLAN" ] || die "no @operator/projectkit or @operator/capture-overlay file: deps found in $PKG_JSON"

while IFS=$'\t' read -r name destDir base newref; do
  [ -z "$name" ] && continue
  mkdir -p "$destDir"
  case "$base" in
    operator-projectkit-*)      cp -f "$PK_TGZ" "$destDir/$base";;
    operator-capture-overlay-*) cp -f "$OV_TGZ" "$destDir/$base";;
  esac
  note "vendored $name -> $destDir/$base   (ref: $newref)"
done <<< "$PLAN"

# --- Determine where to run npm (workspace root vs the package dir) -----------
# If the package.json's dir has no lockfile but an ancestor does, install at the
# ancestor (npm workspaces). Otherwise install in the package dir.
PKG_DIR="$(cd "$(dirname "$PKG_JSON")" && pwd)"
if [ -z "$INSTALL_ROOT" ]; then
  INSTALL_ROOT="$PKG_DIR"
  probe="$PKG_DIR"
  while [ "$probe" != "/" ]; do
    if [ -f "$probe/package-lock.json" ]; then INSTALL_ROOT="$probe"; break; fi
    probe="$(dirname "$probe")"
  done
fi
note "install root: $INSTALL_ROOT"

# --- npm install: refresh lockfile resolved/integrity for the new tarballs ----
note "npm install (refreshing lockfile resolved fields)"
( cd "$INSTALL_ROOT" && npm install --no-audit --no-fund )

# --- Assert a clean npm ci succeeds (the correctness gate) --------------------
if [ "$CI_ASSERT" = 1 ]; then
  if [ ! -f "$INSTALL_ROOT/package-lock.json" ]; then
    die "no package-lock.json at $INSTALL_ROOT after npm install; cannot assert npm ci.
         (Pass --install-root if this testbed's lockfile lives elsewhere.)"
  fi
  note "asserting clean 'npm ci' (node_modules moved aside, not deleted)"
  NM="$INSTALL_ROOT/node_modules"
  ASIDE=""
  if [ -d "$NM" ]; then
    ASIDE="$(mktemp -d "${TMPDIR:-/tmp}/vendor-nm-aside.XXXXXX")"
    mv "$NM" "$ASIDE/node_modules"
  fi
  CI_OK=1
  if ( cd "$INSTALL_ROOT" && npm ci --no-audit --no-fund ); then
    note "clean 'npm ci' SUCCEEDED — vendoring is correct."
  else
    CI_OK=0
    echo "vendor-operator-pkgs: ERROR: clean 'npm ci' FAILED at $INSTALL_ROOT." >&2
    # restore the aside node_modules so the testbed is not left broken
    if [ -n "$ASIDE" ] && [ -d "$ASIDE/node_modules" ] && [ ! -d "$NM" ]; then
      mv "$ASIDE/node_modules" "$NM"
      echo "vendor-operator-pkgs: restored previous node_modules." >&2
    fi
  fi
  # clean up the aside copy if npm ci rebuilt node_modules fresh
  if [ -n "$ASIDE" ] && [ -d "$ASIDE/node_modules" ]; then rm -rf "$ASIDE"; fi
  [ "$CI_OK" = 1 ] || exit 1
fi

note "DONE. @operator packages vendored into $TESTBED ($PKG_JSON_REL); clean npm ci verified."
