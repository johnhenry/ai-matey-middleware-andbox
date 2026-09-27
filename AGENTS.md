# Agent playbook

`@johnhenry/aimatey-middleware-andbox` -- an [aimatey](https://github.com/johnhenry/aimatey)
middleware that routes LLM-authored code through the [andbox](https://github.com/johnhenry/andbox)
sandbox for code-based tool execution. Single package, Node >= 26,
`node --test` (`npm test`), ships source directly -- no build step, no
`dist/`. `andbox` is a peer dependency (`>=0.1.1`), not a direct dependency
-- consumers install it themselves.

`CLAUDE.md` in this directory is a symlink to this file.

## The verification loop (before every push)

1. `npm test` -- `node --test test/*.test.mjs`. Both suites
   (`code-extractor.test.mjs`, `middleware.test.mjs`) run against a real
   `andbox` sandbox (`mode: 'inline'`/worker as andbox itself exercises it),
   not a mock -- a change here can be broken by an andbox behavior change
   even with no code edits in this repo.
2. A genuinely fresh clone:
   `git clone . /tmp/aimatey-middleware-andbox-verifyN && cd $_ && npm ci && npm test`.
   This is the only way to catch "works on my checked-out tree" bugs
   (missing files in `package.json`'s `files`, undeclared deps) -- and
   catches whether `andbox` really is resolvable only as a peer dependency,
   not silently present via a hoisted transitive install.
3. Commit, push, close the issue with a comment naming the commit SHA.

CI (`.github/workflows/ci.yml`) runs `npm ci` then `npm test`; match it
locally.

## Repo-specific gotchas

- **`executeToolFn` must be wired into the sandbox's capabilities at
  creation time, not after.** andbox only accepts `capabilities` at
  `createSandbox({ capabilities })` time -- there is no way to attach them
  later. This middleware needs *either* andbox's `createSandbox` factory
  itself (so it can build a correctly-wired sandbox), *or* an already-built
  sandbox created with `capabilities: toolsToCapabilities(tools,
  executeToolFn)` already set. Passing a bare, capability-less sandbox
  silently reproduces the exact bug fixed in `0.0.0` (see `CHANGELOG.md`
  and [#3](https://github.com/johnhenry/aimatey-middleware-andbox/issues/3)):
  `host.call('toolName', ...)` from LLM-authored code always fails with
  "Unknown capability".
- **The `## Security model` section is not decorative.** This middleware
  inherits every gap in andbox's own security model unchanged (see the
  README's cross-reference). Don't describe a fix here as "closing" one of
  andbox's own gaps unless the fix actually lives in andbox.

## Definition of done

A change is done when all of the following hold, not just when tests pass:
- A regression test exists for any bug fixed against a real `andbox`
  sandbox, not a stub -- the `0.0.0` fix shipped because the prior tests
  didn't actually exercise `host.call()` end-to-end.
- Anything the change does **not** do is stated in the README's
  `## Security model`, not only in an issue comment.
- `CHANGELOG.md` has an entry citing the commit/PR or the closed issue.

## Non-goals

This package does not attempt to close any of andbox's own documented
security gaps (see andbox's `## Security model`) -- doing so is out of
scope here; consumers who need a stronger boundary pair this middleware
with OS-level isolation, per the README.

## Releases

Bump `version` in `package.json` in a PR, add the `CHANGELOG.md` entry, merge,
then `gh release create v<version>` -- the release event triggers
`.github/workflows/publish.yml`, which is idempotent (skips if the version is
already on npm).
