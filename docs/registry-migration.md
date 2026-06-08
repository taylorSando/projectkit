# @operator package registry migration — RUNBOOK

Status: **READY-TO-EXECUTE, NOT EXECUTED.** Nothing here has been published and no
testbed has been flipped to a registry dependency. This is the single canonical
plan for moving `@operator/projectkit` + `@operator/capture-overlay` off committed
`file:` tarballs and onto a private npm registry.

> **Do not run the "execute" steps until the BLOCKING DECISION below is resolved
> AND tokens are provisioned in every build sandbox.** Flipping a testbed's
> `package.json` to a registry dependency before its sandbox has a token will break
> that deploy (clean `npm ci` will 401/404). The vendored `file:` tarballs are the
> safe fallback and stay in place until the registry path is proven green.

---

## 0. BLOCKING DECISION (must be made by the operator first)

The recommendation was "private GitHub Packages." Preparing it surfaced a hard
constraint that makes GitHub Packages **not drop-in** for the current scope:

**GitHub Packages requires the npm `@scope` to equal the owning GitHub org/user
login.** (Verified against GitHub docs: a scoped package `@NAMESPACE/name` must use
the namespace of "the user or organization account to which the package will be
scoped," and the `package.json` `repository` URL must point at that owner's repo.)

Observed facts on this machine:
- GH auth user is **`taylorSando`**; its orgs are **`pedestal`, `Brownie-Points-Club`, `cios-so`**.
- There **is** a GitHub org literally named **`operator`**, but it is **not owned
  by `taylorSando`** (it's someone else's). So `@operator` on `npm.pkg.github.com`
  is unavailable.
- Today `@operator/types` is already consumed from GitHub via a plain
  `github:taylorSando/operator-types#vX` ref (a git dependency, NOT GitHub
  Packages). projectkit + capture-overlay still live on **Bitbucket**.
- The current `gh` token scopes are `admin:public_key, gist, read:org, repo` —
  it has **neither `write:packages` nor `read:packages`**, so even a correctly
  scoped GitHub Packages publish would fail auth until the token is upgraded.

Therefore one of these must be chosen before any publish:

| Option | What it means | Pros | Cons |
| --- | --- | --- | --- |
| **A. Rename scope to a namespace you own on GitHub** (e.g. `@taylorsando/projectkit` + `@taylorsando/capture-overlay`) and host on GitHub Packages | Keeps the recommended registry; scope matches `taylorSando` | Works with GH Packages today; matches the existing `taylorSando/operator-types` GitHub home | Touches the package `name` in BOTH libs and EVERY testbed import (`@operator/...` → `@taylorsando/...`) — a much wider diff than a `file:`→registry swap |
| **B. Create a GitHub org you own named `operator`** | Keep `@operator` scope, host on GH Packages under the new org | Zero import-string churn in testbeds | The `operator` org name is **taken**; you'd need a different org name (which reintroduces the rename) — so this is effectively blocked unless you can obtain that exact org |
| **C. Keep `@operator` scope, use a registry that allows arbitrary scopes** — private **npmjs.org** org, or self-hosted **Verdaccio** on mesh-hetzner | No rename; `@operator` stays | npmjs private org = recurring cost; Verdaccio = one more service to run/back up. Neither is "GitHub Packages." | Diverges from the recommendation; ops surface |
| **D. Do nothing yet** — keep committed `file:` tarballs (current state) | The `vendor-operator-pkgs.sh` flow already makes cold `npm ci` correct | No new infra, no tokens, no cost | The thing the migration was meant to remove (vendored tarball churn across 8 testbeds) stays |

**Recommendation:** **Option A (rename to `@taylorsando/*` on GitHub Packages).**
Rationale: it matches the already-established `taylorSando/operator-types` GitHub
home, needs no new paid service and no new self-hosted infra, and `taylorSando`
already has a working GH SSH/token identity. The cost is a one-time scope rename
across the two libs + the testbed imports — but that rename is a find/replace, it
is reversible, and it can land behind the `file:` fallback so no deploy breaks
during cutover. **Decision owner: operator. Do not proceed on A/B/C/D without it.**

> The publishing config in both repos currently still uses the `@operator` name
> with `publishConfig.registry=https://npm.pkg.github.com`. If Option A is chosen,
> the `name` fields and every testbed import string change to `@taylorsando/*`
> before publish; the registry/`.npmrc`/secret mechanics in the rest of this
> runbook are identical either way. The rest of this doc is written so only the
> scope literal changes.

### Public vs private

Recommend **private (restricted)**. These libs encode the operator's capture /
dispatch / handoff contract and are testbeds-internal; there is no distribution or
support intent (per the "hassle test" / operator-private posture). Both
`package.json` files set `publishConfig.access=restricted`. GitHub Packages npm is
private-by-default for user/org packages anyway. If a package is ever made public,
flip `access` to `public` deliberately — don't default into it.

---

## 1. What is already prepared in the repos (done, not executed)

Branch `agent/claude/registry-publish-prep` in **both** repos contains:

**projectkit** (`~/projects/projectkit`, package `@operator/projectkit@0.7.0`):
- `package.json`: added `publishConfig.registry=https://npm.pkg.github.com` +
  `access=restricted`; added `LICENSE` to `files`.
- `LICENSE` (MIT) added — it was declared in `package.json` but the file was missing.
- `.npmrc.example` added (scope routing + `${NPM_TOKEN}` authToken placeholder).
- `.gitignore`: ignore real `.npmrc`.
- `docs/registry-migration.md` (this file).

**capture-overlay** (`~/projects/capture-overlay`, package `@operator/capture-overlay@0.4.1`):
- `package.json`: added `publishConfig.registry` + `access=restricted`; added
  `LICENSE` to `files`.
- `LICENSE` (MIT) added.
- `README.md` added — `files` referenced a README that did not exist (would have
  shipped a docless package).
- `.npmrc.example` + `.gitignore` `.npmrc` ignore.

**Dry-run proof (no real publish):**
- `@operator/projectkit@0.7.0` → 73 files, 87.7 kB, "Publishing to
  https://npm.pkg.github.com with tag latest and **restricted** access". LICENSE,
  README.md, CONTRACT.md, bin, schemas, dist, src all present. No `.tgz`,
  `.npmrc`, lockfile, or `scripts/` leaked into the tarball.
- `@operator/capture-overlay@0.4.1` → 38 files, 26.0 kB, same registry/access.
  LICENSE + README present. No stray secret/tgz files.

---

## 2. One-time setup (per token-holder)

1. **Create the token.** A GitHub classic PAT with **`write:packages`** (publish)
   + **`read:packages`** (install) + **`repo`** (read the private source repo).
   Fine-grained PAT equivalent: repository access to the package's repo with
   **Packages: read and write**. The current `gh` token does **not** have packages
   scopes — generate a dedicated one; don't reuse the CLI token.
2. **Never commit it.** `.npmrc` is gitignored in both repos. Always template from
   `.npmrc.example`, which reads the token from `${NPM_TOKEN}`.
3. **Local publish/install env:** `export NPM_TOKEN=ghp_xxx` then copy
   `.npmrc.example` → `.npmrc`.

---

## 3. Publish (EXECUTE step — gated on §0 + §2)

From each repo, on a clean checkout with the token set:

```sh
# projectkit
cd ~/projects/projectkit
cp .npmrc.example .npmrc            # NPM_TOKEN must be exported
npm publish                         # prepack runs `npm run build`

# capture-overlay (publish AFTER projectkit — overlay builds against it)
cd ~/projects/capture-overlay
cp .npmrc.example .npmrc
npm publish
```

Notes:
- `prepublishOnly`/`prepack` build `dist/` fresh; do not hand-edit `dist/`.
- capture-overlay's **build** still needs `@operator/projectkit` resolvable at
  publish time (it's a peer at runtime, a `file:` devDependency at build time).
  Until testbeds + this repo are on the registry, keep the committed
  `operator-projectkit-0.7.0.tgz` devDependency so `npm ci && npm run build`
  works on the publishing machine.
- Re-publishing the **same version** is rejected by the registry. Bump the patch
  version for any content change (`0.7.0` → `0.7.1`).

---

## 4. Per-sandbox token provisioning (the part that actually gates cutover)

A testbed must NOT be flipped to a registry dep (§5) until its build sandbox can
authenticate. Each sandbox needs the scope-routing `.npmrc` **and** a token.

### 4a. Vercel (sandolab; any Vercel-deployed testbed)
- Add an env var **`NPM_TOKEN`** in Project Settings → Environment Variables
  (Production + Preview + Development as needed). Vercel preview-deploys every
  branch, so set it for Preview too or branch builds 401.
- Commit a **project `.npmrc`** (repo root, or the app dir Vercel builds from):
  ```ini
  @operator:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=${NPM_TOKEN}
  //npm.pkg.github.com/:always-auth=true
  ```
  Vercel substitutes `${NPM_TOKEN}` from the env var at install time. The file is
  safe to commit because it carries no secret — only the env-var reference.

### 4b. nhl / sitelayer Docker (Cloud Run images)
Pass the token as a **BuildKit build secret**, never as a build ARG or a COPYed
file (both leak into image layers / history).

```dockerfile
# deps stage
COPY package*.json ./            # + workspace package.json globs as today
RUN --mount=type=secret,id=npm_token \
    sh -c 'printf "@operator:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n//npm.pkg.github.com/:always-auth=true\n" "$(cat /run/secrets/npm_token)" > .npmrc \
    && npm ci --omit=dev \
    && rm -f .npmrc'
```

Build with:
```sh
DOCKER_BUILDKIT=1 docker build --secret id=npm_token,env=NPM_TOKEN -t img .
# or: --secret id=npm_token,src=/path/to/tokenfile
```

- The `.npmrc` is written and **deleted inside the same RUN layer** so it is never
  committed to an image layer; the secret mount is not persisted.
- **sitelayer Dockerfile change:** today line ~12 does
  `COPY --parents ... apps/*/operator-projectkit-*.tgz ...` then `npm ci --omit=dev`.
  On cutover, drop the `operator-projectkit-*.tgz` from that COPY glob and add the
  secret-mounted `.npmrc` to the `npm ci` RUN (above).
- **nhl/apps/web Dockerfile change:** today it `COPY apps/web/vendor/` then
  `npm ci`. On cutover, drop the vendor COPY and add the secret-mounted `.npmrc`.
  (Note: that Dockerfile's comment still references `operator-projectkit-0.1.0.tgz`
  while package.json is at `0.7.0` — update the comment too.)
- The fleet `deploy-production-local.sh` path must export `NPM_TOKEN` before the
  build so `--secret id=npm_token,env=NPM_TOKEN` resolves.

### 4c. chess / Bitbucket CI (and other Bitbucket Pipelines)
- Add a **repository variable** `NPM_TOKEN` (Repository settings → Repository
  variables, mark **Secured**).
- In the pipeline, before install, materialize the `.npmrc` from the variable:
  ```yaml
  - printf "@operator:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n//npm.pkg.github.com/:always-auth=true\n" "$NPM_TOKEN" > .npmrc
  - npm ci
  ```
- chess has no `bitbucket-pipelines.yml` today; if chess builds on Vercel instead,
  use §4a. The token-as-secured-variable pattern applies to any Bitbucket CI.

### 4d. mesh-hetzner
- mesh authority does not consume these npm packages at runtime (it's the Go
  mesh + a sink). If a node-side build there ever needs the scope, drop the same
  `.npmrc` with `NPM_TOKEN` from the host env. Otherwise mesh's existing SSH
  identity is sufficient and **no packages token is required here**.

---

## 5. Testbed `package.json` change — READY DIFF (do NOT apply until §4 is green per sandbox)

For each testbed, swap the committed `file:` tarball ref for a registry semver
range. Apply **one testbed at a time**, deploy, confirm green, then the next.

```diff
   "dependencies": {
-    "@operator/projectkit": "file:vendor/operator-projectkit-0.7.0.tgz",
+    "@operator/projectkit": "^0.7.0",
-    "@operator/capture-overlay": "file:vendor/operator-capture-overlay-0.4.1.tgz"
+    "@operator/capture-overlay": "^0.4.1"
   }
```

Exact current refs to replace (verified in-tree on 2026-06-07):

| Testbed file | projectkit | capture-overlay |
| --- | --- | --- |
| `chess/server/package.json` | `file:vendor/operator-projectkit-0.7.0.tgz` → `^0.7.0` | — |
| `chess/web/package.json` | `file:../server/vendor/operator-projectkit-0.7.0.tgz` → `^0.7.0` | `file:vendor/operator-capture-overlay-0.4.1.tgz` → `^0.4.1` |
| `nhl/apps/web/package.json` | `file:vendor/operator-projectkit-0.7.0.tgz` → `^0.7.0` | `file:vendor/operator-capture-overlay-0.4.1.tgz` → `^0.4.1` |
| `winwar/package.json` | `file:vendor/operator-projectkit-0.7.0.tgz` → `^0.7.0` | `file:vendor/operator-capture-overlay-0.4.1.tgz` → `^0.4.1` |
| `sandolab/package.json` | `file:vendor/operator-projectkit-0.7.0.tgz` → `^0.7.0` | `file:vendor/operator-capture-overlay-0.4.1.tgz` → `^0.4.1` |
| `learn/package.json` | `file:vendor/operator-projectkit-0.5.1.tgz` → `^0.5.1` (or bump to `^0.7.0`) | — |
| `sitelayer/apps/{api,web,worker}/package.json` | `file:./operator-projectkit-0.7.0.tgz` → `^0.7.0` | — |

After editing a testbed: delete its vendored `.tgz`, run `npm install` to refresh
the lockfile `resolved`/`integrity` to the registry URL, commit the updated
lockfile, then run a **clean `npm ci`** (node_modules moved aside) to prove the
cold path — the same gate `vendor-operator-pkgs.sh` enforces today.

> If Option A (rename) is chosen in §0, ALSO change the import string
> `@operator/...` → `@taylorsando/...` in both the dependency key above and in
> source imports across the testbed.

---

## 6. Rollback / fallback (keep until tokens confirmed everywhere)

The committed `file:` tarballs are the fallback. They are **not removed** by this
prep.

- **Per-testbed rollback:** revert that testbed's `package.json` to the `file:` ref,
  restore the vendored `.tgz` (re-run `scripts/vendor-operator-pkgs.sh --testbed
  <dir> --package-json <rel>`), `npm install`, commit. Cold `npm ci` is green again
  with no token.
- **Global rollback:** since cutover is one-testbed-at-a-time behind the fallback,
  a bad registry/token state never takes down more than the single testbed being
  migrated. Don't delete any vendored `.tgz` or the `vendor-operator-pkgs.sh` flow
  until **every** sandbox's token is confirmed and **every** testbed has had a
  green cold `npm ci` off the registry.
- The publishing repos can also be reverted: `publishConfig.registry` and the
  scope rename are isolated to `agent/claude/registry-publish-prep`; dropping that
  branch returns both libs to the npmjs default with no `file:`-consumer impact.

---

## 7. Order of operations checklist

1. [ ] Operator resolves §0 (scope/registry + public/private). **BLOCKING.**
2. [ ] If Option A: rename scope in both libs + all testbeds (separate diff).
3. [ ] Create packages PAT(s) with `write:packages` + `read:packages` + `repo`.
4. [ ] `npm publish` projectkit, then capture-overlay (§3).
5. [ ] Provision `NPM_TOKEN` + commit project `.npmrc` per sandbox (§4) — Vercel,
       nhl/sitelayer Docker, chess/Bitbucket, (mesh if needed).
6. [ ] For each provisioned sandbox: apply §5 diff to ONE testbed, refresh
       lockfile, clean `npm ci`, deploy, confirm green.
7. [ ] Repeat 6 per testbed. Keep `file:` fallback until all are green.
8. [ ] Only then retire the vendored `.tgz` flow.
