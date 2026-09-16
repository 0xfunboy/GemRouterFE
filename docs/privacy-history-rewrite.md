# Authorized privacy rewrite — 2026-09-16

The operator explicitly authorized removal of private account identifiers from
already-published history, alongside the two-account Codex dashboard release.

## Scope and safeguards

- All six remote branches were captured at their actual remote tips: `main`,
  `feat/codex-provider`, `archive/widget-wake-probe-2026-09-16`,
  `feat/native-chatgpt-mcp-onboarding`, `gemrouter`, and `leakrouter`.
  There were no advertised tags or pull-request refs at the audit time.
- Full local recovery bundles, the old Git metadata and production rollback
  files are stored in an owner-only private directory outside the checkout.
  The old metadata's push URL is disabled. None of this material is published.
- A separate mirror was rewritten using git-filter-repo 2.47.0. Real private
  emails, connected-account identifiers, personal conversation URLs, deployment
  domains/paths and opaque runtime identifiers were anonymized where found.
  Author/committer metadata uses a generic maintainer name and technical GitHub
  noreply email. Public repository attribution, licensing and third-party notices
  are preserved: they are not identities of the connected Codex account.
- The only initial credential-pattern match was an empty example PEM marker,
  not a usable private key. It was replaced with an inert placeholder.
- The rewritten publication set contained 123 commits and 813 unique blobs before
  the release-report commits. Full-history scans found no private email,
  configured private identifier, credential pattern or private-storage path.
  Five historical image assets were inspected as well; no connected-account
  identifiers were found in their metadata or visible content.
- The new application's current source tree was byte-identical before and after
  history rewriting. The actual local environment, saved Codex login and tunnel
  configuration were not rewritten. Old Git objects/reflogs are outside the
  active checkout, retained privately for recovery only.

Pushes use an atomic, explicit six-branch refspec and a separate expected-old-OID
lease for each branch. A concurrent remote update must abort publication rather
than silently overwrite it. No mirror push, unrelated ref deletion or tag push
is used.

## Verification and future publication

```sh
pnpm check:privacy --all-history main feat/codex-provider \
  archive/widget-wake-probe-2026-09-16 feat/native-chatgpt-mcp-onboarding \
  gemrouter leakrouter
```

The scanner covers commit metadata and every historical tree, not only diffs.
Supply additional private identity terms through `GEMROUTER_PRIVACY_DENY`, never
by committing the actual identifiers into the scanner, documentation or tests.
Reserved example/test identities are intentionally allowed for fixtures.

## Important limits and collaborator action

Old clones must not merge or push pre-rewrite history back into this repository.
Make a fresh clone, preserving any unrelated local work privately first. Any
changes to carry forward must be reviewed for sensitive data before reapplying.

Changing branch refs does **not** prove that GitHub has purged cached commit URLs,
unreachable server objects, pull-request caches or third-party forks/clones.
GitHub Support may need to purge those retained objects. The private recovery
directory contains the old/new commit map for a support request; do not publish
that map or old sensitive commit links as a public issue.

See [GitHub's sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
No claim is made that copies outside the managed branch histories have disappeared.

## Observed remote result

The atomic leased push succeeded for all six branches, and a subsequent remote
ref check matched every published tip to its sanitized local counterpart. The
active checkout is free of unreachable old objects. The repository API reported
zero forks, and no pull-request refs were advertised.

**Residual exposure verified:** three previously published commits containing
private author metadata still returned HTTP 200 at their old direct GitHub URLs
after the rewrite. These are retained server objects/cached views, not ancestors
of the new branch tips. Thus the branch-history cleanup is complete, but total
server-side erasure is **not** complete and cannot be claimed from a Git push.

A ready-to-submit GitHub Support request, the exact affected URLs and the original
commit map are stored only in the private recovery directory outside the repo.
The request was not submitted automatically. The repository owner must submit it
privately to GitHub Support, which determines eligibility and performs the purge.
