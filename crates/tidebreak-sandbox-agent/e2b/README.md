# The Tidebreak documents template on E2B

E2B provisions sandboxes from templates registered with an E2B account, not
from arbitrary OCI references. Publishing a template makes it public: any E2B
account can create sandboxes from it — by its opaque *template ID*. The human
alias is not portable: E2B resolves a custom template's alias only inside the
team that owns it, and only E2B's own base templates (`code-interpreter-v1`)
resolve by alias from anywhere (verified against `api.e2b.app`, 2026-08-04).
That is how a user who has pasted nothing but an
E2B API key still gets Tidebreak's official documents image — LibreOffice, the
`exec` helper scripts, and the document skills' Python dependencies already
installed, so a document run needs no in-sandbox `pip install`.

The alias is version-suffixed — `tidebreak-documents-v0-26-0` — so publishing a
new image version cannot change what an older client gets. `E2B_TEMPLATE` in
[`crates/tidebreak-code-execution/src/e2b.rs`](../../tidebreak-code-execution/src/e2b.rs)
pins the template ID that alias resolves to, with the alias kept alongside in
its doc comment for legibility.

## What is here

- `e2b.Dockerfile` — the template's build definition: the published documents
  image by digest, plus E2B's expected `user` account.
- `e2b.toml` — the template's identity and sizing, for CLI commands that read
  it rather than taking arguments.

## Publishing

Nothing in this repository publishes the template on its own: an E2B build
needs an E2B account, and E2B is a paid service. To publish a new version, run
the commands under [Publishing by hand](#publishing-by-hand) with your own
E2B API key.

A publish from inside the owning account cannot prove *cross-account*
resolution, which is the whole point of publishing. Check it once, by hand,
with a throwaway account's API key and the template ID the publish printed
(the alias would 404 from another account even when everything is right):

```sh
E2B_API_KEY=<other-account-key> \
  e2b sandbox create <template-id>
```

### Publishing by hand

Run from this directory, on a machine authenticated against the E2B account
that will own the template. `e2b auth login` uses a browser; `E2B_API_KEY`
works headless.

```sh
npm install --global @e2b/cli@2.16.1    # or: brew install e2b
export E2B_API_KEY=<your-e2b-api-key>

# Build System 2.0 (current CLI). The build runs on E2B's infrastructure — no
# local Docker daemon. The name is the public alias; `create` takes no config
# file, so the sizing recorded in e2b.toml is passed explicitly.
e2b template create tidebreak-documents-v0-26-0 \
  --dockerfile e2b.Dockerfile --cpu-count 2 --memory-mb 2048

# Make it public. Without the argument the CLI would read e2b.toml's
# template_id, which is this same alias.
e2b template publish tidebreak-documents-v0-26-0
```

`e2b template list --format json` shows every template the account owns with a
`public` field; `e2b template unpublish tidebreak-documents-v0-26-0` reverses
the publish. The client tolerates an unpublished alias: sandbox creation falls
back to `code-interpreter-v1` when E2B cannot resolve the Tidebreak template, in
a degraded mode where the document skills install their Python dependencies at
run time.

## Bumping the version

The image tag, the digest in `e2b.Dockerfile`, the alias in `e2b.toml`, and
`E2B_TEMPLATE` in `e2b.rs` move together — but not at the same moment, and each
step is a PR someone merges:

1. Publish the new sandbox image (`.github/workflows/publish-sandbox-image.yml`
   runs on version tags). Its `pin` job opens a PR that updates
   `e2b.Dockerfile`'s digest and tag comment and renames the alias in
   `e2b.toml` to match the new version, e.g. `tidebreak-documents-v0-27-0`.
   Merge it.
2. Publish the new alias [by hand](#publishing-by-hand), then open a PR that
   moves `E2B_TEMPLATE` onto the new template's ID.

`E2B_TEMPLATE` moves last on purpose: until the template is actually published,
the new template resolves for nobody and every E2B user drops to
`code-interpreter-v1`. Leave the previous template published until clients
pinned to it are out of circulation — unpublishing it drops those users to the
same degraded fallback.

## Notes on the template

- E2B runs `envd` as PID 1 and ignores the image's `ENTRYPOINT`, so the sandbox
  agent binary the image carries is dormant on E2B. Tidebreak's E2B provider
  talks to `envd` directly; the image is here for its contents.
- The template needs no start command: everything the document skills use is
  installed at image-build time and nothing has to be running.
- E2B's default sandbox user is `user` with `/home/user` as its home, which is
  also the workspace root the provider's file APIs address. The Tidebreak image
  runs as `tidebreak` out of a different home, so the Dockerfile creates `user`
  explicitly rather than depending on E2B's builder to add it.
