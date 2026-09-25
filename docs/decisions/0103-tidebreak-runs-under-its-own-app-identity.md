# 103. Tidebreak runs under its own app identity

- Status: Accepted
- Date: 2026-09-25
- Owners: desktop, command line
- Related: [decision 12](0012-data-dir-listen-endpoint.md) (the instance lock
  names the owner), [decision 16](0016-desktop-staging-channel.md) (channel
  identities), [decision 56](0056-one-credential-item-per-profile.md) (one
  credential item per profile),
  [decision 95](0095-computer-use-for-coding-harnesses.md) (the computer-use
  blocklist), `crates/tidebreak-server/src/identity_move.rs`,
  `crates/tidebreak-desktop/src/identity_move.rs`,
  `crates/tidebreak-cli/src/profile.rs`
- Supersedes: the identifiers and keychain services in decision 16's table

## Context

The desktop app ran as `io.brightwave.tidebreak`, and as `.dev` and
`.staging` for its other channels. Tidebreak now lives at
`github.com/naingthet/tidebreak` and needs an identity of its own.

The identifier is more than a label. The platform uses it to name:

- the data folder, which holds every conversation, setting, and log:
  `~/Library/Application Support/<id>`, `%APPDATA%\<id>`, or
  `~/.local/share/<id>`;
- the webview's storage: `~/Library/WebKit/<id>` on macOS, and
  `%LOCALAPPDATA%\<id>` (WebView2's `EBWebView`) on Windows. On Linux,
  WebKitGTK keeps it inside the data folder;
- the window's saved size and place: in the data folder on macOS and Windows,
  and in `~/.config/<id>` on Linux;
- the macOS managed-preferences domain, and the macOS privacy grants
  (Accessibility, Screen Recording), which follow the signed identifier;
- the single-instance lock.

The profile's credentials sat in one keychain item (decision 56) under the
service `tidebreak`, `tidebreak.dev`, or `tidebreak.staging`. Those names did
not contain the identifier, so a build under a new identifier would read and
rewrite the same item as a build under the old one.

An app whose identifier changes finds every one of these empty. Without a
move, the update that changes it looks like a fresh install: no conversations,
no settings, no keys.

## Decision

### The identity

The channels run as `io.github.naingthet.tidebreak`,
`io.github.naingthet.tidebreak.dev`, and
`io.github.naingthet.tidebreak.staging`. Each keeps its app profile's
credentials under a keychain service of the same name, so no two channels,
and no build that still runs under the earlier identifier, share an item. The
deep-link scheme `tidebreak` does not change.

Everything else that named the product follows: the computer-use helper's
signing identifier (`io.github.naingthet.tidebreak.cu-helper`), the plugin
manifest's extension namespace, the symbol keys of the scripts the app injects
into pages, and the mobile bundle identifiers
(`io.github.naingthet.tidebreak.mobile`, with `.staging` and `.dev`, so the
phone app never shares an identifier with the desktop app).

Three readers also accept the earlier name, because they read something a
person or an organization wrote for it:

- The computer-use blocklist reserves both app families. An earlier build may
  still be installed, and it is Tidebreak all the same.
- The macOS managed-preferences reader reads the earlier domain after the
  current one, key by key, so a deployed policy keeps applying until the
  organization deploys it for the new domain.
- The plugin manifest reader reads the earlier extension namespace when the
  current one is absent.

A command-line profile in a folder of its own (`TIDEBREAK_DATA_DIR`) keeps
its keychain service, `tidebreak.profile.<id>`. Its folder does not move, so
its item does not either.

### The move

At launch, before the server opens its database and before a webview exists,
the desktop moves what the earlier identifier named to what the current one
names. The `tidebreak` command line runs the same move before a command uses
the app's profile. The contract:

1. **Nothing to move, nothing created.** If the earlier data folder is missing
   or holds nothing, the move does nothing and writes nothing.
2. **Never merge, never overwrite.** A folder moves only onto a location that
   is missing or empty. Empty folders and an empty instance lock count as
   empty. When both locations hold data, the current folder stays in use, the
   earlier one stays untouched, and the log says so. Nothing else moves then.
3. **Never move a folder in use.** Before it touches anything, the move claims
   the earlier data folder's instance lock and the host broker's lock
   (decision 12). If another process holds either, an older build is running,
   so nothing moves and nothing is created. The desktop then opens no window
   and no server; a native dialog asks the person to quit the other Tidebreak
   and offers Try Again. The command line uses the earlier folder as it is,
   so it attaches to that app as before. Two processes that would move at
   once take turns on `<data folder>.move.lock`, a file that is never
   removed: a process waiting on a removed file would lock it while a third
   locked a new one.
4. **One rename when it can.** Each folder moves with one rename. Across
   volumes, or from a mount point, it is copied beside its destination,
   compared byte for byte, renamed into place, and only then removed from
   where it was. The earlier folder stays whole until the current one is.
5. **A journal.** `<data folder>.move.json`, beside the data folder, names the
   step in progress for each folder and for the credentials, and is written
   before each step. A crash at any step resumes on the next launch. Because
   the earlier folder is removed only after the current one is whole, a fresh
   look at the two folders is safe even without the journal, so an unreadable
   journal starts the move over. The journal stays until every folder and the
   credentials are done. A later launch, before anything opens, tries again a
   folder after the data folder that failed to move, while its destination is
   still missing or empty, and a credential move that failed, once.
6. **A link at the old path.** Once the data folder has moved, the move
   leaves a link at its old path that points at the new one: a symbolic link
   on macOS and Linux, a directory junction on Windows, which needs no
   privilege. Worktrees made before 0.59 live inside the data folder, and
   both their rows and git's own records name them by absolute paths under
   the old folder. Through the link those paths still resolve, so checkpoints
   keep working and `git worktree prune` keeps them. A link that cannot be
   made is logged, and the move goes on. An old path that is a link to the
   new folder counts as moved, for the app and for `TIDEBREAK_DATA_DIR`.
7. **Credentials.** The profile's bundle item, and the per-key items with
   fixed names that builds older than decision 56 left, are copied from the
   earlier service to the current one, read back, and only then removed from
   the earlier service. The move never overwrites an item the current service
   holds, and any failure keeps the earlier item. On macOS the first read
   raises an access prompt, because a differently signed app created the
   item. A refusal and a keychain that was briefly unavailable read the same,
   so a failed move is tried once more on a later launch. If that fails too,
   the item stays where it was, the move asks nothing more, and the app asks
   the person to sign in again. Delete all data erases the earlier service's
   items as well as the current one's.
8. **The data folder decides.** The webview's storage, the settings folder,
   and the credentials move only when the data folder moves.
9. **One notice.** The move writes `identity-move.json` into the data folder,
   and a later launch that finishes what an earlier one could not updates it.
   After a move, the app shows one notice: where the data is now, and that
   macOS may ask again for Accessibility, Screen Recording, and keychain
   access. Dismissing it marks the record, so it never shows again.

Logs move with the data folder, which holds them. Caches stay behind:
`~/Library/Caches/<id>` and `~/.cache/<id>` hold staged updates and WebKit's
network cache, which the app rebuilds. On Windows the caches share the local
data folder with WebView2's storage, so they move with it.

## Alternatives Considered

**Keep `io.brightwave.tidebreak`.** No move and no prompts. Rejected: the
identifier names a product that is now separate, and two apps under one
identifier would share a data folder, a keychain item, and a set of macOS
grants.

**Start fresh and offer an import.** Simpler, and it never touches the earlier
folder. Rejected: the update would look like data loss, and an import that
copies leaves two profiles to keep in step.

**Copy instead of rename, and keep the original.** It leaves a backup.
Rejected: it doubles the disk a profile uses (blobs, backups, and worktrees
from before 0.59), and an older build started later would open the stale copy
as if it were current.

**Merge when both folders hold data.** Rejected: two SQLite profiles have no
safe merge, and a wrong guess destroys data. Leaving both is always
recoverable.

**Keep the keychain service `tidebreak`.** No prompt and no credential move.
Rejected: the service would be shared with builds under the earlier
identifier, which decision 16 forbids between identities, and on macOS two
differently signed apps rewriting one item would raise each other's access
prompt on every update.

**Move during the server's boot.** Rejected: the window's webview creates its
storage, and the window-state plugin writes its file, before the server
boots, and the move never merges into a folder that holds something.

## Consequences

- On macOS, the first launch after the update raises up to three prompts: the
  keychain item's access prompt, and later the Accessibility and Screen
  Recording requests when computer use first needs them.
- An older build started after the move follows the link and opens the moved
  data. If the link could not be made, it starts an empty profile at the old
  path instead, and the new build leaves both alone from then on; only the log
  says so.
- Per-key items from before decision 56 whose names only the database knows,
  a connected app's or an MCP server's credential, are not moved, because the
  move runs before the database opens. They stay under the earlier service,
  where Delete all data still erases them.
- Reading the earlier managed-preferences domain and extension namespace is
  compatibility code. Remove it once no supported install can hold the earlier
  identity.
- The move stays in the launch path until every install has run a build that
  has it. Revisit when the earliest supported upgrade starts after this
  release.
- The mobile bundle identifiers are new apps to the app stores. Nothing
  carries over from the earlier mobile app.

## Validation

`crates/tidebreak-server/src/identity_move/tests.rs` drives the move over
temporary folders with an in-memory keychain:

- a fresh install moves nothing and creates nothing;
- a single move carries the data folder, the webview's storage, the settings
  folder, and the credentials;
- when both folders hold data, both stay untouched;
- a held instance lock or broker lock moves nothing, and the move goes ahead
  once it is released;
- a crash at every step of a rename, and of a copy across volumes, resumes to
  the same result, with the data whole in one folder at every step;
- a copy that differs from its source is caught;
- a real git worktree inside the old data folder still resolves at its stored
  path after the move, survives `git worktree prune`, and a second launch is a
  no-op;
- a folder that failed to move, and a credential move that failed, succeed on
  a later launch; a credential refused twice is left and not asked for again;
- the lock file stays once a move has run;
- credentials move; a refused read keeps the earlier item; an item the
  current service holds is never overwritten.

`crates/tidebreak-cli/src/profile.rs` and `crates/tidebreak-cli/tests/serve.rs`
pin the command line's path: a command moves the app's data before it uses it,
follows the old path's link, and attaches to an older build that still runs on
the earlier folder. `crates/tidebreak-desktop/src/identity_move.rs` pins that
the move runs before the app is built, and `profile_data.rs` that Delete all
data erases the earlier keychain service.

No test runs the real platform. WebKit and WebView2 reading a moved folder,
the macOS keychain prompt, and the native dialog are covered only by the
behavior they depend on.
