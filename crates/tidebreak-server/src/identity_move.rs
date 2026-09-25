//! Carry an install from Tidebreak's previous app identity to its current one.
//!
//! Tidebreak shipped as `io.brightwave.tidebreak` and now ships as
//! `io.github.naingthet.tidebreak` (decision 103). The identifier names the
//! folders the platform gives an app, so a build under the new identifier
//! would open an empty profile beside the person's data. [`run`] moves that
//! data across once, before anything opens it:
//!
//! - the data folder, first, and only while no process of an older build holds
//!   it;
//! - the other folders the identifier names on this platform: WebKit's storage
//!   on macOS, the local data folder that holds WebView2's storage on Windows,
//!   and the settings folder on Linux;
//! - the profile's credentials, from the previous keychain service to the
//!   current one.
//!
//! The rules that keep it from losing anything:
//!
//! - A folder moves only onto a location that is missing or empty. When both
//!   hold something, nothing is merged or overwritten: the current folder
//!   stays in use and the previous one stays where it is.
//! - A folder moves with one rename when it can. Across volumes it is copied
//!   beside its destination, compared file by file, renamed into place, and
//!   only then removed from where it was. So the previous folder is whole
//!   until the current one is, and a fresh look at the two folders is always
//!   safe.
//! - A journal beside the data folder names the step in progress, so a move a
//!   crash cut short finishes on the next launch. It stays until every folder
//!   and the credentials are done, so a later launch tries again what failed.
//! - Once the data folder has moved, a link at its old path points at the new
//!   one. Worktrees made before 0.59 live inside the data folder, and their
//!   rows and git's own records name them by absolute paths under the old
//!   one; through the link those paths still resolve.
//! - A credential is copied, read back, and only then removed from the
//!   previous service. Anything that fails keeps the previous item.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tidebreak_core::{SecretProvider, BUNDLE_KEY};

/// The identity a build runs under, and the one builds before it used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdentityChange {
    /// The bundle identifier this build runs under. The app's own profile
    /// keeps its credentials under a keychain service of the same name.
    pub identifier: &'static str,
    /// The bundle identifier earlier builds ran under.
    pub previous_identifier: &'static str,
    /// The keychain service earlier builds kept the app profile's
    /// credentials under.
    pub previous_keychain_service: &'static str,
}

/// Production, dev, and staging, in that order.
pub const IDENTITY_CHANGES: [IdentityChange; 3] = [
    IdentityChange {
        identifier: "io.github.naingthet.tidebreak",
        previous_identifier: "io.brightwave.tidebreak",
        previous_keychain_service: "tidebreak",
    },
    IdentityChange {
        identifier: "io.github.naingthet.tidebreak.dev",
        previous_identifier: "io.brightwave.tidebreak.dev",
        previous_keychain_service: "tidebreak.dev",
    },
    IdentityChange {
        identifier: "io.github.naingthet.tidebreak.staging",
        previous_identifier: "io.brightwave.tidebreak.staging",
        previous_keychain_service: "tidebreak.staging",
    },
];

/// The change that led to `identifier`, or `None` for an identifier this
/// table does not name.
pub fn identity_change(identifier: &str) -> Option<IdentityChange> {
    IDENTITY_CHANGES
        .into_iter()
        .find(|change| change.identifier == identifier)
}

/// The record the move leaves in the current data folder: what moved, and
/// whether the app has told the person.
pub const RECORD_FILE: &str = "identity-move.json";

/// Files processes lock to claim a data folder: the server's instance lock
/// and the host broker's. A folder moves only while neither is held.
const INSTANCE_LOCK_FILE: &str = crate::INSTANCE_LOCK_FILE;
const BROKER_LOCK_FILE: &str = "host-broker.lock";

/// How many times a credential move is tried before its item is left where it
/// was. A refused access prompt and a keychain that was briefly unavailable
/// read the same, so each gets one more try on a later launch.
const CREDENTIAL_ATTEMPTS: u32 = 2;

/// How long a move waits for another process that is moving the same data.
const MOVER_WAIT: Duration = Duration::from_secs(600);
const MOVER_POLL: Duration = Duration::from_millis(100);

/// How long a rename keeps retrying a folder another process still has a
/// file open in. Windows refuses the rename until the handle closes, which a
/// just-exited app's webview helpers take a moment to do.
#[cfg(windows)]
const BUSY_RETRY: Duration = Duration::from_secs(5);
#[cfg(windows)]
const BUSY_POLL: Duration = Duration::from_millis(250);

/// The per-user folders the platform gives an app, before the app's
/// identifier is appended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformFolders {
    /// `~/Library/Application Support`, `%APPDATA%`, or `$XDG_DATA_HOME`.
    pub data: PathBuf,
    /// `%LOCALAPPDATA%` on Windows, where WebView2 keeps the window's storage.
    /// The data folder elsewhere.
    pub local_data: Option<PathBuf>,
    /// `$XDG_CONFIG_HOME` on Linux, where the window's size and place are
    /// saved. The data folder elsewhere.
    pub config: Option<PathBuf>,
    /// `~/Library/WebKit` on macOS, where WebKit keeps each app's storage
    /// under its bundle identifier. `None` elsewhere.
    pub webkit: Option<PathBuf>,
}

impl PlatformFolders {
    /// The folders as this process's environment names them. On macOS and
    /// Linux this is what the `dirs` crate, and so Tauri, resolves; on Windows
    /// it reads `%APPDATA%` and `%LOCALAPPDATA%` where Tauri asks the shell for
    /// the same known folders.
    pub fn from_env() -> Option<Self> {
        let home = std::env::home_dir().filter(|home| home.is_absolute());
        if cfg!(target_os = "macos") {
            let library = home?.join("Library");
            let support = library.join("Application Support");
            Some(Self {
                data: support.clone(),
                local_data: Some(support.clone()),
                config: Some(support),
                webkit: Some(library.join("WebKit")),
            })
        } else if cfg!(windows) {
            let data = absolute_env("APPDATA")?;
            Some(Self {
                config: Some(data.clone()),
                data,
                local_data: absolute_env("LOCALAPPDATA"),
                webkit: None,
            })
        } else {
            let data = absolute_env("XDG_DATA_HOME")
                .or_else(|| home.as_ref().map(|home| home.join(".local").join("share")))?;
            Some(Self {
                local_data: Some(data.clone()),
                data,
                config: absolute_env("XDG_CONFIG_HOME")
                    .or_else(|| home.as_ref().map(|home| home.join(".config"))),
                webkit: None,
            })
        }
    }
}

fn absolute_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// What a folder holds, and so why it moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderKind {
    /// Conversations, settings, credentials' companions, and logs. On Linux,
    /// also the window's webview storage.
    Data,
    /// Windows: WebView2's storage for the window, and the app's caches.
    LocalData,
    /// Linux: the window's saved size and place.
    Settings,
    /// macOS: WebKit's storage for the window and the code browsers.
    WebView,
}

/// One folder to carry from the previous identifier to the current one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderMove {
    pub kind: FolderKind,
    pub from: PathBuf,
    pub to: PathBuf,
}

/// The credential item to carry from one keychain service to another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialMove {
    pub from_service: String,
    pub to_service: String,
}

/// Everything one identity change moves on this computer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub previous_identifier: String,
    pub identifier: String,
    /// The data folder first: it decides whether anything else moves.
    pub folders: Vec<FolderMove>,
    /// `None` in a build without a keychain.
    pub credentials: Option<CredentialMove>,
}

impl Plan {
    /// The moves `change` makes under `folders`. `keychain_service` is the
    /// service the app profile uses now, or `None` in a build without a
    /// keychain.
    pub fn new(
        change: IdentityChange,
        folders: &PlatformFolders,
        keychain_service: Option<&str>,
    ) -> Self {
        let folder = |kind, base: &Path| FolderMove {
            kind,
            from: base.join(change.previous_identifier),
            to: base.join(change.identifier),
        };
        let mut moves = vec![folder(FolderKind::Data, &folders.data)];
        for (kind, base) in [
            (FolderKind::LocalData, &folders.local_data),
            (FolderKind::Settings, &folders.config),
            (FolderKind::WebView, &folders.webkit),
        ] {
            let Some(base) = base else {
                continue;
            };
            let candidate = folder(kind, base);
            // Most platforms put two of these in one folder. It moves once.
            if moves.iter().all(|existing| existing.to != candidate.to) {
                moves.push(candidate);
            }
        }
        Self {
            previous_identifier: change.previous_identifier.to_owned(),
            identifier: change.identifier.to_owned(),
            folders: moves,
            credentials: keychain_service.map(|service| CredentialMove {
                from_service: change.previous_keychain_service.to_owned(),
                to_service: service.to_owned(),
            }),
        }
    }

    /// The data folder's move.
    pub fn data(&self) -> &FolderMove {
        &self.folders[0]
    }

    /// The journal of a move in progress, beside the current data folder.
    pub fn journal_path(&self) -> PathBuf {
        beside(&self.data().to, ".move.json")
    }

    /// The lock one process holds while it moves, so two never move at once.
    fn mover_lock_path(&self) -> PathBuf {
        beside(&self.data().to, ".move.lock")
    }
}

/// `path` with `suffix` added to its last component: a file beside it.
fn beside(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// What happened to one folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderResult {
    /// The previous identifier had no such folder, or an empty one.
    Absent,
    /// Moved with one rename.
    Renamed,
    /// Moved across volumes: copied, compared, and removed from where it was.
    Copied,
    /// Both locations hold something, so both were left as they were.
    LeftBoth,
    /// The folder could not move and is where it was.
    Failed(String),
}

impl FolderResult {
    pub fn moved(&self) -> bool {
        matches!(self, Self::Renamed | Self::Copied)
    }
}

/// What happened to the profile's credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialResult {
    /// The previous service held nothing to move.
    Nothing,
    /// Copied, read back, and removed from the previous service.
    Moved,
    /// Not moved: the previous item is where it was. On macOS this is usually
    /// a refused access prompt. The person signs in again.
    Kept(String),
}

/// One folder in a [`Report`] or a [`Record`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderReport {
    pub kind: FolderKind,
    pub from: PathBuf,
    pub to: PathBuf,
    pub result: FolderResult,
}

/// What a finished [`run`] did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Report {
    /// Empty when nothing of the previous identifier's was found.
    pub folders: Vec<FolderReport>,
    /// `None` when the data folder did not move, or there is no keychain.
    pub credentials: Option<CredentialResult>,
}

impl Report {
    /// Whether this run moved the data folder.
    pub fn data_moved(&self) -> bool {
        self.data_result().is_some_and(FolderResult::moved)
    }

    /// The previous data folder, when both it and the current one hold data
    /// and this run left them both as they were.
    pub fn previous_left_beside(&self) -> Option<&Path> {
        self.folders
            .iter()
            .find(|folder| {
                folder.kind == FolderKind::Data && folder.result == FolderResult::LeftBoth
            })
            .map(|folder| folder.from.as_path())
    }

    fn data_result(&self) -> Option<&FolderResult> {
        self.folders
            .iter()
            .find(|folder| folder.kind == FolderKind::Data)
            .map(|folder| &folder.result)
    }

    /// One line per folder that did something, and one for the credentials,
    /// for the log.
    pub fn log_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        for folder in &self.folders {
            let (from, to) = (folder.from.display(), folder.to.display());
            match &folder.result {
                FolderResult::Absent => {}
                FolderResult::Renamed => lines.push(format!("moved {from} to {to}")),
                FolderResult::Copied => lines.push(format!(
                    "copied {from} to {to} across volumes, then removed it"
                )),
                FolderResult::LeftBoth => lines.push(format!(
                    "left {from} as it is: {to} already holds data, and nothing is merged"
                )),
                FolderResult::Failed(error) => {
                    lines.push(format!("could not move {from} to {to}: {error}"))
                }
            }
        }
        match &self.credentials {
            None | Some(CredentialResult::Nothing) => {}
            Some(CredentialResult::Moved) => lines.push("moved the saved credentials".to_owned()),
            Some(CredentialResult::Kept(reason)) => lines.push(format!(
                "kept the saved credentials in the previous keychain entry: {reason}"
            )),
        }
        lines
    }
}

/// Where a [`run`] leaves the profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Use the current data folder. The report says what, if anything,
    /// moved into it.
    Ready(Report),
    /// A process of an older build holds the previous data folder, so
    /// nothing moved and nothing was created. Quit it, then run again.
    InUse { previous: PathBuf },
    /// The data folder could not move. It is whole where it was, and the
    /// current location was not created.
    Failed {
        previous: PathBuf,
        current: PathBuf,
        error: String,
    },
}

/// Opens the credential store for one keychain service.
pub type OpenSecrets<'a> = &'a (dyn Fn(&str) -> Arc<dyn SecretProvider> + Send + Sync);

/// Move whatever `plan` names that has not moved yet, or finish a move a
/// crash cut short. Blocking: it renames, copies, and reads the keychain.
/// `secrets` opens a keychain service; `None` leaves credentials alone.
pub fn run(plan: &Plan, secrets: Option<OpenSecrets<'_>>) -> Outcome {
    match Mover::new(plan, secrets).run() {
        Ok(outcome) => outcome,
        // Only a test interrupts a move.
        Err(Interrupted) => Outcome::Failed {
            previous: plan.data().from.clone(),
            current: plan.data().to.clone(),
            error: "the move was interrupted".to_owned(),
        },
    }
}

/// A place a test can cut a move short, as a crash there would.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Point {
    /// The journal names the move, and nothing has moved yet.
    Begun,
    /// The journal says a rename is next.
    BeforeRename,
    /// The rename landed; the journal does not say so yet.
    Renamed,
    /// One file of a copy across volumes is written.
    CopyingFile,
    /// The copy is complete and not yet compared.
    Copied,
    /// The copy matched, and the journal says it is next to go into place.
    Verified,
    /// The copy is in place; the journal does not say so yet.
    Committed,
    /// One file of the previous folder is removed.
    RemovingFile,
    /// The previous folder is gone; the journal does not say so yet.
    Removed,
    /// A folder after the data folder moved.
    OtherFolderMoved,
    /// A credential is written to the current service, not yet read back.
    CredentialCopied,
    /// It read back, and the previous item is not yet removed.
    CredentialVerified,
    /// The previous item is removed; the journal does not say so yet.
    CredentialRemoved,
    /// The record is written, and the journal is not yet removed.
    Recorded,
}

/// A test cut the move short.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Interrupted;

/// Why a step stopped: a test's interruption, which leaves everything as a
/// crash would, or a real failure.
#[derive(Debug)]
enum Stop {
    Interrupted,
    Io(io::Error),
}

impl From<io::Error> for Stop {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<Interrupted> for Stop {
    fn from(_: Interrupted) -> Self {
        Self::Interrupted
    }
}

struct Mover<'a> {
    plan: &'a Plan,
    secrets: Option<OpenSecrets<'a>>,
    #[cfg(test)]
    interrupt_at: Option<Point>,
    /// Treat every rename as one across volumes.
    #[cfg(test)]
    across_volumes: bool,
    /// Fail the move of this kind of folder, as a folder another process
    /// holds open would.
    #[cfg(test)]
    fail_kind: Option<FolderKind>,
}

impl<'a> Mover<'a> {
    fn new(plan: &'a Plan, secrets: Option<OpenSecrets<'a>>) -> Self {
        Self {
            plan,
            secrets,
            #[cfg(test)]
            interrupt_at: None,
            #[cfg(test)]
            across_volumes: false,
            #[cfg(test)]
            fail_kind: None,
        }
    }

    fn checkpoint(&self, point: Point) -> Result<(), Interrupted> {
        if self.interrupts_at(point) {
            Err(Interrupted)
        } else {
            Ok(())
        }
    }

    #[cfg(test)]
    fn interrupts_at(&self, point: Point) -> bool {
        self.interrupt_at == Some(point)
    }

    #[cfg(not(test))]
    fn interrupts_at(&self, _point: Point) -> bool {
        false
    }

    fn run(&self) -> Result<Outcome, Interrupted> {
        let data = self.plan.data();
        let journal_path = self.plan.journal_path();
        // Nothing to do, and nothing to create, is the common case: a fresh
        // install, or one that moved long ago.
        if !journal_path.exists() {
            if !holds_something(&data.from) || links_to(&data.from, &data.to) {
                return Ok(Outcome::Ready(Report::default()));
            }
            if occupied(&data.to) {
                return Ok(Outcome::Ready(left_both(data)));
            }
            // An older build that holds the folder means nothing starts, so
            // look before creating even the lock below.
            match Claim::take(&data.from) {
                Ok(claim) => drop(claim),
                Err(ClaimError::InUse) => {
                    return Ok(Outcome::InUse {
                        previous: data.from.clone(),
                    })
                }
                Err(ClaimError::Io(error)) => return Ok(self.in_use_unknown(&error)),
            }
        }

        // Held until this run returns. The file is never removed: a process
        // waiting on it would otherwise lock a file no longer there while a
        // third locks a new one, and two moves would run at once.
        let _mover = match MoverLock::acquire(&self.plan.mover_lock_path()) {
            Ok(mover) => mover,
            Err(error) => return Ok(self.failed(format!("could not start the move: {error}"))),
        };
        self.run_locked(&journal_path)
    }

    fn in_use_unknown(&self, error: &io::Error) -> Outcome {
        self.failed(format!(
            "could not check whether another Tidebreak is using {}: {error}",
            self.plan.data().from.display()
        ))
    }

    fn run_locked(&self, journal_path: &Path) -> Result<Outcome, Interrupted> {
        let data = self.plan.data();
        let mut journal = match Journal::read(journal_path) {
            Ok(Some(journal)) if !journal.data_ended_unmoved() => journal,
            Ok(Some(_)) | Ok(None) => {
                // A journal whose data folder ended without moving recorded a
                // failure that no longer holds; look again from the start.
                let _ = fs::remove_file(journal_path);
                // Another process may have finished the move while this one
                // waited for the lock. Look again.
                if !holds_something(&data.from) || links_to(&data.from, &data.to) {
                    return Ok(Outcome::Ready(Report::default()));
                }
                if occupied(&data.to) {
                    return Ok(Outcome::Ready(left_both(data)));
                }
                Journal::begin(self.plan)
            }
            Err(error) => {
                // Nothing moves until the new folder is whole, so a fresh look
                // at the two folders is safe without the journal.
                tracing::warn!(
                    "the identity move's journal at {} cannot be read, so the move starts \
                     over: {error}",
                    journal_path.display()
                );
                let _ = fs::remove_file(journal_path);
                if !holds_something(&data.from) || links_to(&data.from, &data.to) {
                    return Ok(Outcome::Ready(Report::default()));
                }
                if occupied(&data.to) {
                    return Ok(Outcome::Ready(left_both(data)));
                }
                Journal::begin(self.plan)
            }
        };
        // What an earlier launch could not finish, it tries again now.
        journal.retry_unfinished();

        // Claim the previous data folder before anything moves: an older
        // build that holds it is running, and one that starts now must not
        // find it half moved.
        let data_step = journal.folders[0].step.clone();
        let mut claim = None;
        if !matches!(data_step, Step::Done { .. }) && fs::symlink_metadata(&data.from).is_ok() {
            match Claim::take(&data.from) {
                Ok(taken) => claim = Some(taken),
                Err(ClaimError::InUse) => {
                    return Ok(Outcome::InUse {
                        previous: data.from.clone(),
                    })
                }
                Err(ClaimError::Io(error)) => return Ok(self.in_use_unknown(&error)),
            }
        }

        if !journal_path.exists() {
            if let Err(error) = journal.save(journal_path) {
                return Ok(self.failed(format!("could not record the move: {error}")));
            }
            self.checkpoint(Point::Begun)?;
        }

        // The data folder decides the rest: when it cannot move, nothing does.
        let result = self.move_folder(&mut journal, 0, journal_path, &mut claim)?;
        drop(claim);
        match result {
            FolderResult::Failed(error) => {
                let _ = fs::remove_file(journal_path);
                return Ok(self.failed(error));
            }
            FolderResult::Absent | FolderResult::LeftBoth => {
                let _ = fs::remove_file(journal_path);
                let mut report = Report::default();
                report.folders.push(journal.folders[0].report(result));
                return Ok(Outcome::Ready(report));
            }
            FolderResult::Renamed | FolderResult::Copied => {}
        }
        let (from, to) = (
            journal.folders[0].from.clone(),
            journal.folders[0].to.clone(),
        );
        link_previous(&from, &to);

        for index in 1..journal.folders.len() {
            let result = self.move_folder(&mut journal, index, journal_path, &mut None)?;
            if result.moved() {
                self.checkpoint(Point::OtherFolderMoved)?;
            }
        }

        self.move_credentials(&mut journal, journal_path)?;

        let report = journal.report();
        if let Err(error) = Record::write(&to, &journal, &report) {
            tracing::warn!("could not record the identity move: {error}");
        }
        self.checkpoint(Point::Recorded)?;
        if journal.finished() {
            let _ = fs::remove_file(journal_path);
        } else if let Err(error) = journal.save(journal_path) {
            tracing::warn!("could not record what is left of the identity move: {error}");
        }
        Ok(Outcome::Ready(report))
    }

    fn failed(&self, error: String) -> Outcome {
        Outcome::Failed {
            previous: self.plan.data().from.clone(),
            current: self.plan.data().to.clone(),
            error,
        }
    }

    /// Carry folder `index` as far as it goes, recording each step before it
    /// takes it. A real failure is the folder's result; only a test's
    /// interruption stops the move itself.
    fn move_folder(
        &self,
        journal: &mut Journal,
        index: usize,
        journal_path: &Path,
        claim: &mut Option<Claim>,
    ) -> Result<FolderResult, Interrupted> {
        loop {
            let entry = journal.folders[index].clone();
            let next = match self.folder_step(&entry, claim) {
                Ok(next) => next,
                Err(Stop::Interrupted) => return Err(Interrupted),
                Err(Stop::Io(error)) => Step::Done {
                    result: FolderResult::Failed(error.to_string()),
                },
            };
            journal.folders[index].step = next.clone();
            if let Err(error) = journal.save(journal_path) {
                tracing::warn!("could not record the identity move's progress: {error}");
            }
            if let Step::Done { result } = next {
                return Ok(result);
            }
        }
    }

    /// Take the step `entry` names and answer the one after it.
    fn folder_step(&self, entry: &JournalFolder, claim: &mut Option<Claim>) -> Result<Step, Stop> {
        let (from, to) = (&entry.from, &entry.to);
        match &entry.step {
            Step::Pending => {
                if !holds_something(from) || links_to(from, to) {
                    return Ok(done(FolderResult::Absent));
                }
                if occupied(to) {
                    return Ok(done(FolderResult::LeftBoth));
                }
                Ok(Step::Renaming)
            }
            Step::Renaming => {
                self.checkpoint(Point::BeforeRename)?;
                #[cfg(test)]
                if self.fail_kind == Some(entry.kind) {
                    return Err(io::Error::other("the folder is in use").into());
                }
                if fs::symlink_metadata(from).is_err() || links_to(from, to) {
                    // The rename landed before a crash could record it.
                    return Ok(if fs::symlink_metadata(to).is_ok() {
                        done(FolderResult::Renamed)
                    } else {
                        done(FolderResult::Absent)
                    });
                }
                if occupied(to) {
                    return Ok(done(FolderResult::LeftBoth));
                }
                clear_empty(to)?;
                if self.must_copy(from) {
                    return Ok(Step::Copying {
                        staging: staging_path(to),
                    });
                }
                // Windows will not rename a folder with a file open in it, the
                // claim's own lock files included.
                if cfg!(windows) {
                    *claim = None;
                }
                match rename_folder(from, to) {
                    Ok(()) => {
                        self.checkpoint(Point::Renamed)?;
                        Ok(done(FolderResult::Renamed))
                    }
                    Err(error) if crosses_volumes(&error) => Ok(Step::Copying {
                        staging: staging_path(to),
                    }),
                    Err(error) => Err(error.into()),
                }
            }
            Step::Copying { staging } => {
                if fs::symlink_metadata(from).is_err() {
                    // The source went away underneath the copy. What the copy
                    // holds may be all there is, so it stays.
                    return Ok(done(FolderResult::Failed(format!(
                        "{} disappeared while it was being copied; the copy is at {}",
                        from.display(),
                        staging.display()
                    ))));
                }
                // A copy a crash cut short: the source is whole, so start again.
                remove_tree(staging, &|| Ok(()))?;
                match self.copy_tree(from, staging, true) {
                    Ok(()) => {}
                    Err(Stop::Io(error)) => {
                        // A copy that failed takes nothing with it: the source
                        // is whole.
                        let _ = remove_tree(staging, &|| Ok(()));
                        return Err(error.into());
                    }
                    Err(Stop::Interrupted) => return Err(Stop::Interrupted),
                }
                self.checkpoint(Point::Copied)?;
                if let Err(difference) = verify_tree(from, staging, true)? {
                    let _ = remove_tree(staging, &|| Ok(()));
                    return Ok(done(FolderResult::Failed(format!(
                        "the copy of {} did not match it ({difference}), so nothing moved",
                        from.display()
                    ))));
                }
                Ok(Step::Committing {
                    staging: staging.clone(),
                })
            }
            Step::Committing { staging } => {
                self.checkpoint(Point::Verified)?;
                if fs::symlink_metadata(staging).is_ok() {
                    if occupied(to) {
                        // Something took the destination while the copy ran.
                        // The source is whole, so the copy can go.
                        remove_tree(staging, &|| Ok(()))?;
                        return Ok(done(FolderResult::LeftBoth));
                    }
                    if let Err(error) = clear_empty(to).and_then(|()| fs::rename(staging, to)) {
                        // The source is whole, so the copy goes with the try.
                        let _ = remove_tree(staging, &|| Ok(()));
                        return Err(error.into());
                    }
                    self.checkpoint(Point::Committed)?;
                } else if fs::symlink_metadata(to).is_err() {
                    // Neither the copy nor its destination: copy again.
                    return Ok(Step::Copying {
                        staging: staging.clone(),
                    });
                }
                Ok(Step::RemovingSource)
            }
            Step::RemovingSource => {
                // The destination is whole. Release the claim's lock files
                // last on Windows, which will not delete a file still open.
                if cfg!(windows) {
                    *claim = None;
                }
                match remove_tree(from, &|| self.checkpoint(Point::RemovingFile)) {
                    Ok(()) => {}
                    Err(Stop::Interrupted) => return Err(Stop::Interrupted),
                    // The data is whole where it moved to. What could not be
                    // removed stays, and the next launch leaves it beside.
                    Err(Stop::Io(error)) => tracing::warn!(
                        "moved {} to {}, but could not remove all of the previous folder: \
                         {error}",
                        from.display(),
                        to.display()
                    ),
                }
                self.checkpoint(Point::Removed)?;
                Ok(done(FolderResult::Copied))
            }
            Step::Done { result } => Ok(done(result.clone())),
        }
    }

    /// Whether `from` has to be copied rather than renamed: a test asked, or
    /// it is a mount point, which no rename can move.
    fn must_copy(&self, from: &Path) -> bool {
        #[cfg(test)]
        if self.across_volumes {
            return true;
        }
        is_mount_point(from)
    }

    /// Copy `from` into `to`, which must not exist. Links are copied as
    /// links; sockets and pipes, which nothing keeps, are passed over. The
    /// lock files at the top are left: they hold nothing, and the process
    /// that serves the folder makes its own.
    fn copy_tree(&self, from: &Path, to: &Path, top: bool) -> Result<(), Stop> {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            let name = entry.file_name();
            if top && is_lock_file(&name) {
                continue;
            }
            let (source, target) = (entry.path(), to.join(&name));
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                copy_link(&source, &target)?;
            } else if kind.is_dir() {
                self.copy_tree(&source, &target, false)?;
            } else if kind.is_file() {
                fs::copy(&source, &target)?;
                File::open(&target)?.sync_all()?;
                self.checkpoint(Point::CopyingFile)?;
            }
        }
        Ok(())
    }

    fn move_credentials(
        &self,
        journal: &mut Journal,
        journal_path: &Path,
    ) -> Result<(), Interrupted> {
        let Some(secrets) = self.secrets else {
            return Ok(());
        };
        let Some(entry) = journal.credentials.clone() else {
            return Ok(());
        };
        let resuming = match entry.step {
            CredentialStep::Done { .. } => return Ok(()),
            CredentialStep::Moving => true,
            CredentialStep::Pending => false,
        };
        if let Some(credentials) = journal.credentials.as_mut() {
            credentials.step = CredentialStep::Moving;
            if !resuming {
                credentials.attempts += 1;
            }
        }
        if let Err(error) = journal.save(journal_path) {
            tracing::warn!("could not record the identity move's progress: {error}");
        }
        let previous = secrets(&entry.from_service);
        let current = secrets(&entry.to_service);
        let result = block_on(move_credentials(
            self,
            previous.as_ref(),
            current.as_ref(),
            resuming,
        ))?;
        if let Some(credentials) = journal.credentials.as_mut() {
            credentials.step = CredentialStep::Done { result };
        }
        if let Err(error) = journal.save(journal_path) {
            tracing::warn!("could not record the identity move's progress: {error}");
        }
        Ok(())
    }
}

fn done(result: FolderResult) -> Step {
    Step::Done { result }
}

fn left_both(data: &FolderMove) -> Report {
    Report {
        folders: vec![FolderReport {
            kind: data.kind,
            from: data.from.clone(),
            to: data.to.clone(),
            result: FolderResult::LeftBoth,
        }],
        credentials: None,
    }
}

/// Where a copy across volumes is assembled: beside its destination, on the
/// destination's volume, so a rename puts it in place whole.
fn staging_path(to: &Path) -> PathBuf {
    beside(to, ".moving")
}

/// Run `future` to completion on a thread of its own, so a caller inside an
/// async runtime and one outside it can both wait on it.
fn block_on<F>(future: F) -> F::Output
where
    F: std::future::Future + Send,
    F::Output: Send,
{
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("a runtime for the credential move")
                    .block_on(future)
            })
            .join()
            .expect("the credential move panicked")
    })
}

/// Every key a profile may keep a credential under without its store open:
/// the one bundle item, then the per-key items builds before the bundle
/// wrote (decision 56), which the server sweeps into the bundle at boot.
fn credential_keys() -> Vec<String> {
    let mut keys = vec![BUNDLE_KEY.to_owned()];
    keys.extend(crate::secret_rehome::static_secret_keys());
    keys
}

/// What happened to one credential item.
#[derive(Debug, PartialEq, Eq)]
enum ItemMove {
    Absent,
    AlreadyThere,
    Moved,
    Kept(String),
}

async fn move_credentials(
    mover: &Mover<'_>,
    previous: &dyn SecretProvider,
    current: &dyn SecretProvider,
    resuming: bool,
) -> Result<CredentialResult, Interrupted> {
    let mut moved = false;
    for key in credential_keys() {
        match move_credential(mover, previous, current, &key, resuming).await? {
            ItemMove::Absent | ItemMove::AlreadyThere => {}
            ItemMove::Moved => moved = true,
            // One refusal is the answer for all: asking again for each item
            // would only repeat the access prompt the person turned down.
            ItemMove::Kept(reason) => return Ok(CredentialResult::Kept(reason)),
        }
    }
    Ok(if moved {
        CredentialResult::Moved
    } else {
        CredentialResult::Nothing
    })
}

/// Copy one item, read it back, then remove the previous one. Nothing here
/// overwrites a value the current service holds, and every failure leaves
/// the previous item where it was.
async fn move_credential(
    mover: &Mover<'_>,
    previous: &dyn SecretProvider,
    current: &dyn SecretProvider,
    key: &str,
    resuming: bool,
) -> Result<ItemMove, Interrupted> {
    match current.get_secret(key).await {
        Ok(Some(_)) if !resuming => return Ok(ItemMove::AlreadyThere),
        Ok(Some(existing)) => {
            // A move a crash cut short can leave one value in both places.
            // Finish it, but only for the value it copied.
            return Ok(match previous.get_secret(key).await {
                Ok(Some(value)) if value == existing => {
                    if let Err(error) = previous.delete_secret(key).await {
                        tracing::warn!(
                            "moved a credential but could not remove the previous item: {error}"
                        );
                    }
                    ItemMove::Moved
                }
                // The move removed it before the crash.
                Ok(None) => ItemMove::Moved,
                _ => ItemMove::AlreadyThere,
            });
        }
        Ok(None) => {}
        Err(error) => return Ok(ItemMove::Kept(error.to_string())),
    }
    let value = match previous.get_secret(key).await {
        Ok(Some(value)) => value,
        Ok(None) => return Ok(ItemMove::Absent),
        Err(error) => return Ok(ItemMove::Kept(error.to_string())),
    };
    if let Err(error) = current.set_secret(key, &value).await {
        return Ok(ItemMove::Kept(error.to_string()));
    }
    mover.checkpoint(Point::CredentialCopied)?;
    if current.get_secret(key).await.ok().flatten().as_deref() != Some(value.as_str()) {
        // Take back a copy that is not the value, so the next launch does
        // not mistake it for a finished move.
        let _ = current.delete_secret(key).await;
        return Ok(ItemMove::Kept(
            "the copy did not read back unchanged".to_owned(),
        ));
    }
    mover.checkpoint(Point::CredentialVerified)?;
    if let Err(error) = previous.delete_secret(key).await {
        // The copy is in place. The previous item is a spare, not a loss.
        tracing::warn!("moved a credential but could not remove the previous item: {error}");
    }
    mover.checkpoint(Point::CredentialRemoved)?;
    Ok(ItemMove::Moved)
}

/// The step a folder's move is on, as the journal records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "step")]
enum Step {
    /// Nothing has happened to this folder yet.
    Pending,
    /// A rename of `from` onto `to` is next, or just happened.
    Renaming,
    /// `from` is being copied into `staging`, on `to`'s volume.
    Copying {
        staging: PathBuf,
    },
    /// `staging` holds a copy that matched `from`, and goes onto `to` next.
    Committing {
        staging: PathBuf,
    },
    /// `to` is whole. What is left of `from` is being removed.
    RemovingSource,
    Done {
        result: FolderResult,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "step")]
enum CredentialStep {
    Pending,
    /// Items are being copied. A crash here may leave one in both services.
    Moving,
    Done {
        result: CredentialResult,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct JournalFolder {
    kind: FolderKind,
    from: PathBuf,
    to: PathBuf,
    #[serde(flatten)]
    step: Step,
}

impl JournalFolder {
    fn report(&self, result: FolderResult) -> FolderReport {
        FolderReport {
            kind: self.kind,
            from: self.from.clone(),
            to: self.to.clone(),
            result,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct JournalCredentials {
    from_service: String,
    to_service: String,
    /// How many launches have tried the move.
    #[serde(default)]
    attempts: u32,
    #[serde(flatten)]
    step: CredentialStep,
}

/// The move in progress. It names its own paths, so a move resumes where it
/// was even if the environment that planned it has changed since.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Journal {
    version: u32,
    previous_identifier: String,
    identifier: String,
    started_at: DateTime<Utc>,
    folders: Vec<JournalFolder>,
    credentials: Option<JournalCredentials>,
}

impl Journal {
    fn begin(plan: &Plan) -> Self {
        Self {
            version: 1,
            previous_identifier: plan.previous_identifier.clone(),
            identifier: plan.identifier.clone(),
            started_at: Utc::now(),
            folders: plan
                .folders
                .iter()
                .map(|folder| JournalFolder {
                    kind: folder.kind,
                    from: folder.from.clone(),
                    to: folder.to.clone(),
                    step: Step::Pending,
                })
                .collect(),
            credentials: plan
                .credentials
                .as_ref()
                .map(|credentials| JournalCredentials {
                    from_service: credentials.from_service.clone(),
                    to_service: credentials.to_service.clone(),
                    attempts: 0,
                    step: CredentialStep::Pending,
                }),
        }
    }

    /// Set what an earlier launch could not finish back to the start, so this
    /// one tries it again: a folder after the data folder that failed to
    /// move, and a credential move with a try left. A folder whose
    /// destination has since filled is not moved; its first step says so.
    fn retry_unfinished(&mut self) {
        for folder in self.folders.iter_mut().skip(1) {
            if matches!(
                &folder.step,
                Step::Done {
                    result: FolderResult::Failed(_)
                }
            ) {
                folder.step = Step::Pending;
            }
        }
        if let Some(credentials) = self.credentials.as_mut() {
            if matches!(
                &credentials.step,
                CredentialStep::Done {
                    result: CredentialResult::Kept(_)
                }
            ) && credentials.attempts < CREDENTIAL_ATTEMPTS
            {
                credentials.step = CredentialStep::Pending;
            }
        }
    }

    /// Whether nothing is left for a later launch to try.
    fn finished(&self) -> bool {
        let folders = self.folders.iter().all(|folder| {
            matches!(&folder.step, Step::Done { result } if !matches!(result, FolderResult::Failed(_)))
        });
        let credentials =
            self.credentials
                .as_ref()
                .is_none_or(|credentials| match &credentials.step {
                    CredentialStep::Done {
                        result: CredentialResult::Kept(_),
                    } => credentials.attempts >= CREDENTIAL_ATTEMPTS,
                    CredentialStep::Done { .. } => true,
                    CredentialStep::Pending | CredentialStep::Moving => false,
                });
        folders && credentials
    }

    /// Whether the data folder's step ended without moving it: nothing to
    /// resume.
    fn data_ended_unmoved(&self) -> bool {
        matches!(
            self.folders.first().map(|folder| &folder.step),
            Some(Step::Done { result }) if !result.moved()
        )
    }

    fn read(path: &Path) -> io::Result<Option<Self>> {
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(io::Error::other),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Replace the journal whole: written beside it, then renamed over it.
    fn save(&self, path: &Path) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        write_whole(path, &bytes)
    }

    fn report(&self) -> Report {
        Report {
            folders: self
                .folders
                .iter()
                .map(|folder| {
                    let result = match &folder.step {
                        Step::Done { result } => result.clone(),
                        // A folder the move never reached did not move.
                        _ => FolderResult::Absent,
                    };
                    folder.report(result)
                })
                .collect(),
            credentials: self.credentials.as_ref().and_then(|credentials| {
                match &credentials.step {
                    CredentialStep::Done { result } => Some(result.clone()),
                    _ => None,
                }
            }),
        }
    }
}

/// Write `bytes` to a file beside `path`, flush it to disk, and rename it
/// over `path`, so a reader sees the old contents or the new, never half.
fn write_whole(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = beside(path, ".tmp");
    let mut file = File::create(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)
}

/// What moved, kept in the current data folder so the app can tell the
/// person once, and so a report of a problem can say where the data came
/// from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub previous_identifier: String,
    pub identifier: String,
    pub moved_at: DateTime<Utc>,
    pub folders: Vec<FolderReport>,
    pub credentials: Option<CredentialResult>,
    /// Whether the app has shown the notice that says the data moved.
    #[serde(default)]
    pub notice_shown: bool,
}

impl Record {
    /// Write what the move has done so far. A later launch that finishes
    /// what an earlier one could not updates the record, and keeps whether
    /// the app has already shown its notice.
    fn write(data_dir: &Path, journal: &Journal, report: &Report) -> io::Result<()> {
        let earlier = Self::read(data_dir);
        let record = Self {
            previous_identifier: journal.previous_identifier.clone(),
            identifier: journal.identifier.clone(),
            moved_at: earlier
                .as_ref()
                .map_or_else(Utc::now, |earlier| earlier.moved_at),
            folders: report.folders.clone(),
            credentials: report.credentials.clone(),
            notice_shown: earlier.is_some_and(|earlier| earlier.notice_shown),
        };
        record.save(data_dir)
    }

    fn save(&self, data_dir: &Path) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        write_whole(&data_dir.join(RECORD_FILE), &bytes)
    }

    /// The record in `data_dir`, if a move left one there.
    pub fn read(data_dir: &Path) -> Option<Self> {
        let bytes = fs::read(data_dir.join(RECORD_FILE)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// The record, while its data folder moved and the app has not yet said
    /// so.
    pub fn unannounced(data_dir: &Path) -> Option<Self> {
        Self::read(data_dir).filter(|record| {
            !record.notice_shown
                && record
                    .folders
                    .iter()
                    .any(|folder| folder.kind == FolderKind::Data && folder.result.moved())
        })
    }

    /// Note that the app has shown its notice, so it never shows it again.
    pub fn mark_announced(data_dir: &Path) -> io::Result<()> {
        let Some(mut record) = Self::read(data_dir) else {
            return Ok(());
        };
        record.notice_shown = true;
        record.save(data_dir)
    }
}

/// The lock one moving process holds, so two never move the same data at
/// once. A process that finds it held waits: the other is moving, and when it
/// is done there is nothing left to move.
struct MoverLock {
    _file: File,
}

impl MoverLock {
    fn acquire(path: &Path) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        let deadline = Instant::now() + MOVER_WAIT;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Self { _file: file }),
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(MOVER_POLL);
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "another Tidebreak is still moving its data",
                    ))
                }
                Err(TryLockError::Error(error)) => return Err(error),
            }
        }
    }
}

/// Exclusive locks on the lock files the processes that serve a data folder
/// hold, taken so an older build cannot start on the folder while it moves.
struct Claim {
    _files: Vec<File>,
}

enum ClaimError {
    InUse,
    Io(io::Error),
}

impl Claim {
    /// Claim `folder`, or answer [`ClaimError::InUse`] when a live process
    /// holds either lock. The instance lock file is created when missing, so
    /// a server that starts now waits on this claim instead of taking the
    /// folder mid-move.
    fn take(folder: &Path) -> Result<Self, ClaimError> {
        let mut files = Vec::new();
        for (name, create) in [(INSTANCE_LOCK_FILE, true), (BROKER_LOCK_FILE, false)] {
            let path = folder.join(name);
            let file = match OpenOptions::new()
                .create(create)
                .truncate(false)
                .read(true)
                .write(true)
                .open(&path)
            {
                Ok(file) => file,
                Err(error) if !create && error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(ClaimError::Io(error)),
            };
            match file.try_lock() {
                Ok(()) => files.push(file),
                Err(TryLockError::WouldBlock) => return Err(ClaimError::InUse),
                Err(TryLockError::Error(error)) => return Err(ClaimError::Io(error)),
            }
        }
        Ok(Self { _files: files })
    }
}

fn is_lock_file(name: &std::ffi::OsStr) -> bool {
    name == INSTANCE_LOCK_FILE || name == BROKER_LOCK_FILE
}

/// Whether `from` is a link that resolves to `to`: the data folder moved, and
/// the link left at its old path points at where it went. On Windows a
/// directory junction reads as a link too.
pub fn links_to(from: &Path, to: &Path) -> bool {
    let is_link =
        fs::symlink_metadata(from).is_ok_and(|metadata| metadata.file_type().is_symlink());
    is_link
        && matches!(
            (fs::canonicalize(from), fs::canonicalize(to)),
            (Ok(from), Ok(to)) if from == to
        )
}

/// Leave a link at the data folder's old path that points at where it moved,
/// so absolute paths recorded under the old path still resolve: worktrees
/// made before 0.59 live in the data folder, and both their rows and git's
/// own records name them that way. Something already at the old path stays.
/// A link that cannot be made is logged, and the move goes on without it.
fn link_previous(from: &Path, to: &Path) {
    match fs::symlink_metadata(from) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!("could not look at {} to link it: {error}", from.display());
            return;
        }
        Ok(_) => {
            if !links_to(from, to) {
                tracing::info!(
                    "{} holds something again, so it stays and no link goes there",
                    from.display()
                );
            }
            return;
        }
    }
    if let Err(error) = make_link(to, from) {
        tracing::warn!(
            "could not leave a link at {} to {}: {error}",
            from.display(),
            to.display()
        );
    }
}

#[cfg(unix)]
fn make_link(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// A directory junction, which any user can make, where a symbolic link
/// needs Developer Mode or an administrator.
#[cfg(windows)]
fn make_link(target: &Path, link: &Path) -> io::Result<()> {
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("mklink /J exited with {status}")))
    }
}

#[cfg(not(any(unix, windows)))]
fn make_link(_target: &Path, _link: &Path) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// Whether `path` is a folder with something in it. A folder that holds only
/// empty folders and an empty instance lock file holds nothing: a process
/// that opened it and stopped before writing leaves exactly that.
fn holds_something(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => !holds_nothing(path, 0),
        _ => false,
    }
}

/// Whether something is at `to` that a move must not replace: anything but a
/// missing or empty folder. A link, even to an empty folder, counts.
fn occupied(to: &Path) -> bool {
    match fs::symlink_metadata(to) {
        Err(_) => false,
        Ok(metadata) if metadata.is_dir() => !holds_nothing(to, 0),
        Ok(_) => true,
    }
}

const MAX_EMPTY_DEPTH: usize = 16;

fn holds_nothing(dir: &Path, depth: usize) -> bool {
    if depth > MAX_EMPTY_DEPTH {
        return false;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return false;
        };
        let Ok(kind) = entry.file_type() else {
            return false;
        };
        if kind.is_dir() {
            if !holds_nothing(&entry.path(), depth + 1) {
                return false;
            }
        } else if !(depth == 0
            && kind.is_file()
            && is_lock_file(&entry.file_name())
            && entry.metadata().is_ok_and(|metadata| metadata.len() == 0))
        {
            return false;
        }
    }
    true
}

/// Remove an empty folder at `to`, so a rename can land there. It removes
/// only empty folders and empty lock files, so a file written there since
/// [`occupied`] looked stops it rather than going with it.
fn clear_empty(to: &Path) -> io::Result<()> {
    match fs::symlink_metadata(to) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(metadata) if metadata.is_dir() => remove_empty(to, true),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} is in the way", to.display()),
        )),
    }
}

fn remove_empty(dir: &Path, top: bool) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            remove_empty(&entry.path(), false)?;
        } else if top
            && kind.is_file()
            && is_lock_file(&entry.file_name())
            && entry.metadata()?.len() == 0
        {
            fs::remove_file(entry.path())?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} is in the way", entry.path().display()),
            ));
        }
    }
    fs::remove_dir(dir)
}

/// Rename a folder. On Windows, a folder another process still has a file
/// open in is retried for a few seconds: the webview helpers of an app that
/// just quit take a moment to let go.
fn rename_folder(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let deadline = Instant::now() + BUSY_RETRY;
        loop {
            match fs::rename(from, to) {
                Err(error) if is_busy(&error) && Instant::now() < deadline => {
                    std::thread::sleep(BUSY_POLL);
                }
                result => return result,
            }
        }
    }
    #[cfg(not(windows))]
    fs::rename(from, to)
}

#[cfg(windows)]
fn is_busy(error: &io::Error) -> bool {
    // ERROR_ACCESS_DENIED and ERROR_SHARING_VIOLATION.
    matches!(error.raw_os_error(), Some(5) | Some(32))
}

/// Whether a rename failed because the two paths are on different volumes.
fn crosses_volumes(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::CrossesDevices {
        return true;
    }
    // EXDEV on Unix, ERROR_NOT_SAME_DEVICE on Windows.
    let raw = error.raw_os_error();
    if cfg!(windows) {
        raw == Some(17)
    } else {
        raw == Some(18)
    }
}

/// Whether `path` is a folder mounted from another volume than the folder it
/// sits in. A link is never one: renaming it moves the link.
fn is_mount_point(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let Ok(metadata) = fs::symlink_metadata(path) else {
            return false;
        };
        if !metadata.is_dir() {
            return false;
        }
        path.parent()
            .and_then(|parent| fs::metadata(parent).ok())
            .is_some_and(|parent| parent.dev() != metadata.dev())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

#[cfg(unix)]
fn copy_link(source: &Path, target: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(source)?, target)
}

#[cfg(windows)]
fn copy_link(source: &Path, target: &Path) -> io::Result<()> {
    let destination = fs::read_link(source)?;
    if fs::metadata(source).is_ok_and(|metadata| metadata.is_dir()) {
        std::os::windows::fs::symlink_dir(destination, target)
    } else {
        std::os::windows::fs::symlink_file(destination, target)
    }
}

/// Compare the copy at `to` with `from`, file by file and byte by byte.
/// `Ok(Err(..))` names the first difference.
fn verify_tree(from: &Path, to: &Path, top: bool) -> io::Result<Result<(), String>> {
    let mut expected = 0usize;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if top && is_lock_file(&name) {
            continue;
        }
        expected += 1;
        let (source, copy) = (entry.path(), to.join(&name));
        let kind = entry.file_type()?;
        let Ok(copied) = fs::symlink_metadata(&copy) else {
            return Ok(Err(format!("{} is missing", copy.display())));
        };
        if kind.is_symlink() {
            if !copied.file_type().is_symlink() || fs::read_link(&source)? != fs::read_link(&copy)?
            {
                return Ok(Err(format!("the link {} differs", copy.display())));
            }
        } else if kind.is_dir() {
            if !copied.is_dir() {
                return Ok(Err(format!("{} is not a folder", copy.display())));
            }
            if let Err(difference) = verify_tree(&source, &copy, false)? {
                return Ok(Err(difference));
            }
        } else if kind.is_file() {
            if !copied.is_file() || !same_contents(&source, &copy)? {
                return Ok(Err(format!("{} differs", copy.display())));
            }
        } else {
            // Not copied, so not compared.
            expected -= 1;
        }
    }
    let found = fs::read_dir(to)?.count();
    if found != expected {
        return Ok(Err(format!(
            "{} holds {found} entries where {expected} were copied",
            to.display()
        )));
    }
    Ok(Ok(()))
}

fn same_contents(left: &Path, right: &Path) -> io::Result<bool> {
    let (mut left, mut right) = (File::open(left)?, File::open(right)?);
    if left.metadata()?.len() != right.metadata()?.len() {
        return Ok(false);
    }
    let (mut a, mut b) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let read = read_full(&mut left, &mut a)?;
        if read != read_full(&mut right, &mut b)? || a[..read] != b[..read] {
            return Ok(false);
        }
        if read == 0 {
            return Ok(true);
        }
    }
}

fn read_full(file: &mut File, buffer: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..])? {
            0 => break,
            read => filled += read,
        }
    }
    Ok(filled)
}

/// Remove `path` and everything under it without following links, calling
/// `after_file` after each file. A missing `path` is already removed. A
/// mount point's own folder cannot go, so it is left empty.
fn remove_tree(path: &Path, after_file: &dyn Fn() -> Result<(), Interrupted>) -> Result<(), Stop> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() {
        remove_file(path)?;
        after_file()?;
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        remove_tree(&entry?.path(), after_file)?;
    }
    match fs::remove_dir(path) {
        Err(_) if is_mount_point(path) => Ok(()),
        result => Ok(result?),
    }
}

/// Remove a file or a link, clearing a read-only flag that stops Windows.
fn remove_file(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            let metadata = fs::symlink_metadata(path)?;
            let mut permissions = metadata.permissions();
            if !permissions.readonly() {
                return Err(error);
            }
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            fs::set_permissions(path, permissions)?;
            fs::remove_file(path)
        }
        result => result,
    }
}

#[cfg(test)]
mod tests;
