# @operator package registry migration

Status: **superseded**.

The earlier private-registry plan has been retired. `@operator/projectkit` stays
private and git-tag based, and protected suite consumers must resolve it from
Bitbucket or from an explicit local `file:` dependency. Do not add package
registry credentials or route protected-suite packages through GitHub Packages.

Current guidance:

- For suite/testbed consumers that need a pinned git dependency, use
  `bitbucket:taylor_sando/projectkit#vX.Y.Z`.
- For in-repo examples that are meant to exercise the checkout under test, use a
  local `file:` dependency.
- Keep real package-registry credentials out of the repo. No npmrc token
  templates are required for the current Bitbucket-only package flow.
