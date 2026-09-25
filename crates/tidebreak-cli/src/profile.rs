//! Which profile a command works on.
//!
//! A profile is one data directory (chats, settings, logs, `listen.json`) plus
//! the credential item stored for it. Every command picks it the same way:
//!
//! - When `TIDEBREAK_DATA_DIR` names a directory, the profile is that one.
//! - Otherwise it is the Tidebreak app's own profile, in the data directory the
//!   desktop build of this channel uses. A client command connects to the app
//!   there (see [`crate::connect`]). `serve`, `folder`, `rehome-secrets`, and
//!   `--embed` open it in this process.
//!
//! Nothing defaults to the current directory. A command run from a project
//! folder used to start a new, empty profile in `./.tidebreak`, and because
//! the credential item did not depend on the directory, a key set there
//! rewrote the app's.
//!
//! The app's data directory is named for its identifier, which changed in
//! decision 103. Before a command uses the app's profile, it moves an install
//! from the previous identifier across the way the app does
//! ([`tidebreak_server::identity_move`]). While an older build is running on
//! the previous folder, the command uses that folder as it is, so it attaches
//! to the running app as before.
//!
//! The directory also decides the credential item. The app's own profile keeps
//! the keychain service the app uses, which moves with its folder. Any other
//! profile keeps its credentials under a service derived from its directory,
//! so a key set or removed there never reaches the app's. That folder never
//! moves, so neither does its item.
//!
//! A profile other than the app's used to share the app's item, so after an
//! upgrade its own item starts empty. `tidebreak rehome-secrets` copies the
//! shared item into it once ([`adopt_previous_bundle`]), and leaves the shared
//! one as it is. Nothing copies it without being asked: that would hand every
//! new profile the app's credentials, and on macOS reading an item another
//! build created can raise an access prompt a headless run cannot answer.

use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use sha2::{Digest, Sha256};
use tidebreak_core::{AgentError, Config, Profile, Result, SecretProvider, BUNDLE_KEY};
use tidebreak_server::identity_move::{self, IdentityChange, OpenSecrets, Plan, PlatformFolders};

/// The folder the desktop app puts code worktrees in, under the home
/// directory. Every channel shares it.
const WORKTREE_ROOT_FOLDER: &str = "Tidebreak";

/// A packaged desktop channel.
///
/// The values mirror `tidebreak-desktop`'s `channel` module, which the CLI
/// cannot depend on. `the_channels_match_the_desktop` pins them to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Channel {
    Production,
    Dev,
    Staging,
}

impl Channel {
    /// The channel this binary was built as, chosen the way the desktop
    /// chooses its own. A debug build is the dev channel. A release build is
    /// staging only when `TIDEBREAK_CHANNEL=staging` was set at compile time,
    /// which the staging workflow does for the app and its bundled CLI alike.
    pub(crate) fn current() -> Self {
        if cfg!(debug_assertions) {
            return Self::Dev;
        }
        match option_env!("TIDEBREAK_CHANNEL") {
            Some("staging") => Self::Staging,
            _ => Self::Production,
        }
    }

    /// The app's bundle identifier, which names its data directory and its
    /// managed-preferences domain.
    fn identifier(self) -> &'static str {
        match self {
            Self::Production => "io.github.naingthet.tidebreak",
            Self::Dev => "io.github.naingthet.tidebreak.dev",
            Self::Staging => "io.github.naingthet.tidebreak.staging",
        }
    }

    /// The keychain service the app's profile uses: its identifier.
    fn keychain_service(self) -> &'static str {
        self.identifier()
    }

    /// The service a profile other than the app's derives its own from.
    /// These are the channel services from before decision 103: a profile in
    /// a folder of its own did not move, so its item keeps its name.
    fn profile_service_base(self) -> &'static str {
        match self {
            Self::Production => "tidebreak",
            Self::Dev => "tidebreak.dev",
            Self::Staging => "tidebreak.staging",
        }
    }

    /// The identity this channel ran under before, which the move carries
    /// the app's profile from.
    fn identity_change(self) -> IdentityChange {
        identity_move::identity_change(self.identifier())
            .expect("every channel names its previous identity")
    }
}

/// Where the app of a channel keeps its profile, under both identities.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AppFolders {
    /// The folder the current identifier names.
    current: PathBuf,
    /// The folder the previous identifier names.
    previous: PathBuf,
}

impl AppFolders {
    fn for_channel(channel: Channel, data: &Path) -> Self {
        let change = channel.identity_change();
        Self {
            current: data.join(change.identifier),
            previous: data.join(change.previous_identifier),
        }
    }
}

/// The app's profile this command uses, once any move from the previous
/// identity is done.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AppProfile {
    folders: AppFolders,
    /// The folder in use: the current one, or the previous one while an
    /// older build is running on it or it could not move.
    dir: PathBuf,
}

/// The configuration of the profile a command works on.
pub(crate) fn config() -> Result<Config> {
    let channel = Channel::current();
    // Move the app's profile only for a command that works on it: by default,
    // or when `TIDEBREAK_DATA_DIR` names the app's folder under either name.
    let app = match std::env::var_os("TIDEBREAK_DATA_DIR").filter(|dir| !dir.is_empty()) {
        None => app_profile(),
        Some(named) => app_folders(channel)
            .filter(|folders| names_app_folder(Path::new(&named), folders))
            .and_then(|_| app_profile()),
    };
    let mut config = Config::from_env_with_default_data_dir(|profile| match profile {
        Profile::Desktop => app.map(|app| app.dir.clone()),
        // A self-host server has no app to default to, so it needs the
        // variable. The image sets it.
        _ => None,
    })?;
    if config.profile == Profile::Desktop {
        if let Some(app) = app {
            config.data_dir = follow_move(&config.data_dir, app);
        }
        let home = home_dir().map(|home| home.canonicalize().unwrap_or(home));
        let identity = identity(
            channel,
            &config.data_dir,
            app_folders(channel).as_ref(),
            home.as_deref(),
        );
        config.keychain_service = identity.keychain_service;
        config.bundle_id = identity.bundle_id;
        config.code_worktree_root_default = identity.worktree_root_default;
    }
    if let Some(service) = keychain_service_override() {
        config.keychain_service = Some(service);
    }
    Ok(config)
}

/// Whether `named` is the app's folder, under the current identifier or the
/// previous one.
fn names_app_folder(named: &Path, folders: &AppFolders) -> bool {
    let named = resolved(named);
    named == resolved(&folders.current) || named == resolved(&folders.previous)
}

/// `TIDEBREAK_DATA_DIR` naming the app's previous folder, once that folder has
/// moved, means the folder it moved to. The move leaves a link at the old path,
/// so a link there that points at the current folder counts as moved too.
/// Anything else stays as named.
fn follow_move(data_dir: &Path, app: &AppProfile) -> PathBuf {
    let previous = &app.folders.previous;
    let moved = app.dir == app.folders.current
        && spelled(data_dir) == spelled(previous)
        && (std::fs::symlink_metadata(previous).is_err()
            || identity_move::links_to(previous, &app.folders.current));
    if !moved {
        return data_dir.to_path_buf();
    }
    eprintln!(
        "tidebreak: TIDEBREAK_DATA_DIR names {}, which Tidebreak moved to {}. Using {}; \
         update TIDEBREAK_DATA_DIR to it.",
        app.folders.previous.display(),
        app.folders.current.display(),
        app.folders.current.display()
    );
    app.folders.current.clone()
}

/// The app's profile, after moving an install from the previous identity
/// across. Runs the move at most once per process.
fn app_profile() -> Option<&'static AppProfile> {
    static PROFILE: OnceLock<Option<AppProfile>> = OnceLock::new();
    PROFILE
        .get_or_init(|| {
            let channel = Channel::current();
            let folders = PlatformFolders::from_env()?;
            Some(resolve_app_profile(channel, &folders, keychain_opener()))
        })
        .as_ref()
}

/// Move the app's profile from the previous identity, as the app itself does
/// at launch, and answer the folder to use.
fn resolve_app_profile(
    channel: Channel,
    folders: &PlatformFolders,
    secrets: Option<OpenSecrets<'_>>,
) -> AppProfile {
    let app_folders = AppFolders::for_channel(channel, &folders.data);
    let service = secrets.is_some().then_some(channel.keychain_service());
    let plan = Plan::new(channel.identity_change(), folders, service);
    let dir = match identity_move::run(&plan, secrets) {
        identity_move::Outcome::Ready(report) => {
            if report.data_moved() {
                for line in report.log_lines() {
                    eprintln!("tidebreak: {line}");
                }
            }
            app_folders.current.clone()
        }
        // An older build is running on it: attach to it there, as before.
        identity_move::Outcome::InUse { previous } => previous,
        identity_move::Outcome::Failed {
            previous, error, ..
        } => {
            eprintln!(
                "tidebreak: could not move Tidebreak's data to its new folder, so this command \
                 uses {} as it is: {error}",
                previous.display()
            );
            previous
        }
    };
    AppProfile {
        folders: app_folders,
        dir,
    }
}

/// Opens a keychain service for the move, or `None` when this process must
/// not touch the app's credentials: a build without the keychain, or a debug
/// build pointed at a scratch service.
fn keychain_opener() -> Option<OpenSecrets<'static>> {
    #[cfg(feature = "keychain")]
    {
        fn open(service: &str) -> std::sync::Arc<dyn SecretProvider> {
            std::sync::Arc::new(tidebreak_core::KeychainSecretProvider::with_service(
                service,
            ))
        }
        if keychain_service_override().is_none() {
            return Some(&open);
        }
    }
    None
}

/// The keychain service a debug build was pointed at with
/// `TIDEBREAK_KEYCHAIN_SERVICE`, which wins over the profile's own.
///
/// A headless rig can point a debug build at a scratch service of its own
/// choosing. A freshly re-linked binary reading items another build created
/// trips the macOS access prompt, which blocks a session with no window
/// forever; a scratch service starts empty. A release build ignores it.
fn keychain_service_override() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("TIDEBREAK_KEYCHAIN_SERVICE")
        .ok()
        .filter(|service| !service.is_empty())
}

/// Where a profile other than the app's kept its credentials before it had a
/// keychain service of its own, most likely first. Empty for the app's own
/// profile, a self-host profile, and a debug build pointed at
/// `TIDEBREAK_KEYCHAIN_SERVICE`.
#[cfg_attr(not(feature = "keychain"), allow(dead_code))]
pub(crate) fn previous_keychain_services(config: &Config) -> Vec<&'static str> {
    if config.profile != Profile::Desktop || keychain_service_override().is_some() {
        return Vec::new();
    }
    let channel = Channel::current();
    previous_services_for(channel, &config.data_dir, app_folders(channel).as_ref())
}

/// Until each profile had its own, the CLI kept every desktop profile under
/// one service: `tidebreak.dev` in a debug build, and the default `tidebreak`
/// in every release build, staging included. That shared item was the app's,
/// so once the app's profile moved to its current identity (decision 103),
/// the same credentials are in the app's current service.
#[cfg_attr(not(feature = "keychain"), allow(dead_code))]
fn previous_services_for(
    channel: Channel,
    data_dir: &Path,
    app: Option<&AppFolders>,
) -> Vec<&'static str> {
    if app.is_some_and(|app| names_app_folder(data_dir, app)) {
        return Vec::new();
    }
    let shared = match channel {
        Channel::Dev => Channel::Dev,
        Channel::Production | Channel::Staging => Channel::Production,
    };
    vec![shared.profile_service_base(), shared.keychain_service()]
}

/// What [`adopt_previous_bundle`] did.
#[cfg_attr(not(feature = "keychain"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Adoption {
    /// The profile already has its own item, so nothing was read or written.
    AlreadyOwn,
    /// No shared item holds anything.
    NothingToCopy,
    /// The shared item at this index was copied into the profile's own and
    /// left as it was.
    Copied(usize),
}

/// Copy the credential bundle the first of `previous` that holds one into
/// `own`, but only while `own` holds none, so running it again never
/// overwrites a key set since. `previous` is read and never changed: the app
/// still uses it.
#[cfg_attr(not(feature = "keychain"), allow(dead_code))]
pub(crate) async fn adopt_previous_bundle(
    previous: &[&dyn SecretProvider],
    own: &dyn SecretProvider,
) -> Result<Adoption> {
    if own.get_secret(BUNDLE_KEY).await?.is_some() {
        return Ok(Adoption::AlreadyOwn);
    }
    for (index, shared) in previous.iter().enumerate() {
        let Some(bundle) = shared.get_secret(BUNDLE_KEY).await? else {
            continue;
        };
        own.set_secret(BUNDLE_KEY, &bundle).await?;
        return match own.get_secret(BUNDLE_KEY).await? {
            Some(stored) if stored == bundle => Ok(Adoption::Copied(index)),
            _ => Err(AgentError::Secret(
                "the copied credentials did not read back unchanged; the previous entry is \
                 untouched, so run rehome-secrets again"
                    .to_owned(),
            )),
        };
    }
    Ok(Adoption::NothingToCopy)
}

/// Whether `TIDEBREAK_DATA_DIR` names a directory. An empty value names none,
/// the same rule the configuration applies.
pub(crate) fn data_dir_is_named() -> bool {
    std::env::var_os("TIDEBREAK_DATA_DIR").is_some_and(|dir| !dir.is_empty())
}

/// The Tidebreak app's data directory for this build's channel, once any
/// move from the previous identity is done, or `None` when this computer has
/// no per-user data directory to find it in.
pub(crate) fn app_data_dir() -> Option<PathBuf> {
    app_profile().map(|app| app.dir.clone())
}

/// Where the app of `channel` keeps its data, under both identifiers: the
/// platform's per-user data directory joined with the app's identifier, the
/// way the app itself resolves it.
fn app_folders(channel: Channel) -> Option<AppFolders> {
    PlatformFolders::from_env().map(|folders| AppFolders::for_channel(channel, &folders.data))
}

fn home_dir() -> Option<PathBuf> {
    std::env::home_dir().filter(|home| home.is_absolute())
}

/// What a desktop-profile configuration takes from the profile its data
/// directory holds.
#[derive(Debug, PartialEq, Eq)]
struct Identity {
    keychain_service: Option<String>,
    bundle_id: Option<String>,
    worktree_root_default: Option<PathBuf>,
}

fn identity(
    channel: Channel,
    data_dir: &Path,
    app: Option<&AppFolders>,
    home: Option<&Path>,
) -> Identity {
    let data_dir = resolved(data_dir);
    // The app's own profile, under either identity. It keeps the credential
    // item, the managed-preferences domain, and the worktree root that app
    // uses, so opening it here reads the same credentials and obeys the same
    // policy as the app does.
    let app_identity = app.and_then(|app| {
        let change = channel.identity_change();
        if resolved(&app.current) == data_dir {
            Some((channel.keychain_service(), channel.identifier()))
        } else if resolved(&app.previous) == data_dir {
            Some((change.previous_keychain_service, change.previous_identifier))
        } else {
            None
        }
    });
    if let Some((service, bundle_id)) = app_identity {
        return Identity {
            keychain_service: Some(service.to_owned()),
            bundle_id: Some(bundle_id.to_owned()),
            worktree_root_default: home
                .map(|home| home.join(WORKTREE_ROOT_FOLDER).join("workspaces")),
        };
    }
    Identity {
        keychain_service: Some(format!(
            "{}.profile.{}",
            channel.profile_service_base(),
            profile_id(&data_dir)
        )),
        bundle_id: None,
        worktree_root_default: None,
    }
}

/// `path` made absolute with its parent resolved but its last component as
/// written, so a link is compared by its own name rather than by where it
/// points.
fn spelled(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    match (absolute.parent(), absolute.file_name()) {
        (Some(parent), Some(name)) => resolved(parent).join(name),
        _ => resolved(&absolute),
    }
}

/// `path` made absolute, with symlinks and `..` resolved, so two spellings of
/// one directory name one profile. A directory that does not exist yet
/// resolves the same way before and after it is created, because the part of
/// it that exists does the resolving.
fn resolved(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut lexical = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // Resolve what exists first, so `..` leaves a symlink's
                // target rather than the folder the link sits in.
                if let Ok(canonical) = lexical.canonicalize() {
                    lexical = canonical;
                }
                lexical.pop();
            }
            other => lexical.push(other),
        }
    }
    let mut existing = lexical.as_path();
    let mut missing = Vec::new();
    loop {
        if let Ok(canonical) = existing.canonicalize() {
            return missing
                .iter()
                .rev()
                .fold(canonical, |path, part| path.join(part));
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name.to_owned());
                existing = parent;
            }
            _ => return lexical,
        }
    }
}

/// The first 16 hex digits of the SHA-256 of a resolved directory: the same
/// for one directory every time, and different for two.
fn profile_id(resolved: &Path) -> String {
    Sha256::digest(resolved.as_os_str().as_encoded_bytes())
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use super::*;

    /// The app's folders under a scratch data directory.
    fn app_under(root: &Path) -> AppFolders {
        AppFolders {
            current: root.join("app-data"),
            previous: root.join("previous-app-data"),
        }
    }

    /// The app's own profile keeps the item the app reads, under whichever
    /// identity names the folder it opens.
    #[test]
    fn the_app_profile_keeps_the_app_keychain_item() {
        let home = tempfile::tempdir().unwrap();
        let app = app_under(home.path());
        for (channel, service, previous_service, previous_id) in [
            (
                Channel::Production,
                "io.github.naingthet.tidebreak",
                "tidebreak",
                "io.brightwave.tidebreak",
            ),
            (
                Channel::Dev,
                "io.github.naingthet.tidebreak.dev",
                "tidebreak.dev",
                "io.brightwave.tidebreak.dev",
            ),
            (
                Channel::Staging,
                "io.github.naingthet.tidebreak.staging",
                "tidebreak.staging",
                "io.brightwave.tidebreak.staging",
            ),
        ] {
            let worktrees = Some(home.path().join("Tidebreak").join("workspaces"));
            assert_eq!(
                identity(channel, &app.current, Some(&app), Some(home.path())),
                Identity {
                    keychain_service: Some(service.to_owned()),
                    bundle_id: Some(channel.identifier().to_owned()),
                    worktree_root_default: worktrees.clone(),
                },
                "{channel:?}"
            );
            // The folder an older build still runs on keeps that build's item
            // and policy domain, so a command attached to it reads the same.
            assert_eq!(
                identity(channel, &app.previous, Some(&app), Some(home.path())),
                Identity {
                    keychain_service: Some(previous_service.to_owned()),
                    bundle_id: Some(previous_id.to_owned()),
                    worktree_root_default: worktrees,
                },
                "{channel:?}"
            );
        }
    }

    /// Any other profile gets a service of its own, so its credentials never
    /// reach the app's item and two profiles never share one. Its folder did
    /// not move, so its service keeps the name it had.
    #[test]
    fn another_profile_gets_its_own_keychain_service() {
        let root = tempfile::tempdir().unwrap();
        let app = app_under(root.path());
        let first = root.path().join("first");
        let second = root.path().join("second");

        let service = |channel, dir: &Path| {
            identity(channel, dir, Some(&app), None)
                .keychain_service
                .expect("a profile other than the app's names its service")
        };
        let first_service = service(Channel::Production, &first);
        assert!(
            first_service.starts_with("tidebreak.profile."),
            "{first_service}"
        );
        assert_eq!(first_service.len(), "tidebreak.profile.".len() + 16);
        assert_ne!(first_service, service(Channel::Production, &second));
        assert!(service(Channel::Dev, &first).starts_with("tidebreak.dev.profile."));
        assert!(service(Channel::Staging, &first).starts_with("tidebreak.staging.profile."));

        let other = identity(Channel::Production, &first, Some(&app), None);
        assert_eq!(other.bundle_id, None);
        assert_eq!(other.worktree_root_default, None);
        // With no app directory to compare against, nothing is the app's.
        let unknown_app = identity(Channel::Production, &app.current, None, None)
            .keychain_service
            .expect("a profile with no app to match names its own service");
        assert!(
            unknown_app.starts_with("tidebreak.profile."),
            "{unknown_app}"
        );
    }

    /// One directory is one profile however it is spelled, and whether or not
    /// it exists yet.
    #[test]
    fn two_spellings_of_one_directory_are_one_profile() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("profile");
        let dotted = root.path().join("elsewhere").join("..").join("profile");
        let before = resolved(&dir);
        assert_eq!(resolved(&dotted), before);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(resolved(&dir), before, "creating it changes nothing");

        #[cfg(unix)]
        {
            let link = root.path().join("link");
            std::os::unix::fs::symlink(&dir, &link).unwrap();
            assert_eq!(resolved(&link), resolved(&dir));
            let app = app_under(root.path());
            assert_eq!(
                identity(Channel::Dev, &link, Some(&app), None),
                identity(Channel::Dev, &dir, Some(&app), None)
            );
            // A link to the app's directory is the app's profile.
            let app_link = root.path().join("app-link");
            std::fs::create_dir_all(&app.current).unwrap();
            std::os::unix::fs::symlink(&app.current, &app_link).unwrap();
            assert_eq!(
                identity(Channel::Dev, &app_link, Some(&app), None).keychain_service,
                Some("io.github.naingthet.tidebreak.dev".to_owned())
            );
        }
    }

    /// The app's data directory is the platform's per-user data directory
    /// joined with the channel's identifier.
    #[test]
    fn the_app_data_dir_ends_in_the_channel_identifier() {
        if let Some(folders) = app_folders(Channel::Production) {
            assert!(
                folders.current.is_absolute(),
                "{}",
                folders.current.display()
            );
            assert!(folders.current.ends_with("io.github.naingthet.tidebreak"));
            assert!(folders.previous.ends_with("io.brightwave.tidebreak"));
            assert_eq!(folders.current.parent(), folders.previous.parent());
        }
        if let Some(folders) = app_folders(Channel::Staging) {
            assert!(folders
                .current
                .ends_with("io.github.naingthet.tidebreak.staging"));
        }
    }

    /// The CLI cannot depend on the desktop crate, so the values it copies are
    /// checked against the desktop's source.
    #[test]
    fn the_channels_match_the_desktop() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../tidebreak-desktop/src/channel.rs");
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        for (constant, value) in [
            ("PRODUCTION_IDENTIFIER", Channel::Production.identifier()),
            ("DEV_IDENTIFIER", Channel::Dev.identifier()),
            ("STAGING_IDENTIFIER", Channel::Staging.identifier()),
            (
                "PRODUCTION_KEYCHAIN_SERVICE",
                Channel::Production.keychain_service(),
            ),
            ("DEV_KEYCHAIN_SERVICE", Channel::Dev.keychain_service()),
            (
                "STAGING_KEYCHAIN_SERVICE",
                Channel::Staging.keychain_service(),
            ),
            ("PRODUCTION_PRODUCT_NAME", WORKTREE_ROOT_FOLDER),
        ] {
            let line = format!("pub const {constant}: &str = \"{value}\";");
            assert!(source.contains(&line), "{} lacks `{line}`", path.display());
        }
    }

    /// Keychain services in memory: items by (service, key).
    #[derive(Clone, Default)]
    struct Keychain(Arc<Mutex<HashMap<(String, String), String>>>);

    impl Keychain {
        fn service(&self, service: &str) -> Items {
            Items {
                keychain: self.clone(),
                service: service.to_owned(),
            }
        }

        fn get(&self, service: &str, key: &str) -> Option<String> {
            self.0
                .lock()
                .unwrap()
                .get(&(service.to_owned(), key.to_owned()))
                .cloned()
        }
    }

    /// One keychain service of a [`Keychain`].
    struct Items {
        keychain: Keychain,
        service: String,
    }

    #[async_trait::async_trait]
    impl SecretProvider for Items {
        async fn get_secret(&self, key: &str) -> Result<Option<String>> {
            Ok(self.keychain.get(&self.service, key))
        }

        async fn set_secret(&self, key: &str, value: &str) -> Result<()> {
            self.keychain
                .0
                .lock()
                .unwrap()
                .insert((self.service.clone(), key.to_owned()), value.to_owned());
            Ok(())
        }

        async fn delete_secret(&self, key: &str) -> Result<()> {
            self.keychain
                .0
                .lock()
                .unwrap()
                .remove(&(self.service.clone(), key.to_owned()));
            Ok(())
        }
    }

    /// A made-up credential bundle. Built from pieces so nothing here reads as
    /// a key.
    fn bundle(value: &str) -> String {
        let credential = ["fixture", value].join("-");
        serde_json::json!({ "provider.openai.credential": credential }).to_string()
    }

    /// The keys a profile stored in the shared item come back into its own,
    /// once, and the shared item the app still reads is left as it was.
    #[tokio::test]
    async fn rehoming_copies_the_shared_item_once_and_leaves_it() {
        let keychain = Keychain::default();
        let shared = keychain.service("tidebreak");
        let moved = keychain.service("io.github.naingthet.tidebreak");
        let own = keychain.service("tidebreak.profile.0123456789abcdef");
        shared
            .set_secret(BUNDLE_KEY, &bundle("before"))
            .await
            .unwrap();

        assert_eq!(
            adopt_previous_bundle(&[&shared, &moved], &own)
                .await
                .unwrap(),
            Adoption::Copied(0)
        );
        assert_eq!(
            own.get_secret(BUNDLE_KEY).await.unwrap(),
            Some(bundle("before"))
        );
        assert_eq!(
            shared.get_secret(BUNDLE_KEY).await.unwrap(),
            Some(bundle("before")),
            "the app's item is never changed"
        );

        // A key set in the profile since is never overwritten by a second run.
        own.set_secret(BUNDLE_KEY, &bundle("since")).await.unwrap();
        assert_eq!(
            adopt_previous_bundle(&[&shared, &moved], &own)
                .await
                .unwrap(),
            Adoption::AlreadyOwn
        );
        assert_eq!(
            own.get_secret(BUNDLE_KEY).await.unwrap(),
            Some(bundle("since"))
        );

        // Once the app's item has moved to its current service, that is
        // where the shared credentials are.
        let other = keychain.service("tidebreak.profile.fedcba9876543210");
        shared.delete_secret(BUNDLE_KEY).await.unwrap();
        moved
            .set_secret(BUNDLE_KEY, &bundle("moved"))
            .await
            .unwrap();
        assert_eq!(
            adopt_previous_bundle(&[&shared, &moved], &other)
                .await
                .unwrap(),
            Adoption::Copied(1)
        );
        assert_eq!(
            other.get_secret(BUNDLE_KEY).await.unwrap(),
            Some(bundle("moved"))
        );

        let empty = Keychain::default();
        let fresh = empty.service("tidebreak.profile.0000000000000000");
        assert_eq!(
            adopt_previous_bundle(&[&empty.service("tidebreak")], &fresh)
                .await
                .unwrap(),
            Adoption::NothingToCopy
        );
        assert_eq!(fresh.get_secret(BUNDLE_KEY).await.unwrap(), None);
    }

    /// Only a profile other than the app's had its credentials somewhere
    /// else before; the app's own profile, under either identity, never did.
    #[test]
    fn only_a_profile_other_than_the_apps_has_a_previous_entry() {
        let root = tempfile::tempdir().unwrap();
        let app = app_under(root.path());
        let named = root.path().join("named");
        assert_eq!(
            previous_services_for(Channel::Dev, &named, Some(&app)),
            ["tidebreak.dev", "io.github.naingthet.tidebreak.dev"]
        );
        assert_eq!(
            previous_services_for(Channel::Production, &named, Some(&app)),
            ["tidebreak", "io.github.naingthet.tidebreak"]
        );
        // A staging release build used production's service.
        assert_eq!(
            previous_services_for(Channel::Staging, &named, Some(&app)),
            ["tidebreak", "io.github.naingthet.tidebreak"]
        );
        assert!(previous_services_for(Channel::Dev, &app.current, Some(&app)).is_empty());
        assert!(previous_services_for(Channel::Dev, &app.previous, Some(&app)).is_empty());
    }

    /// A scratch home with the platform folders the move works in.
    struct Home {
        root: tempfile::TempDir,
        keychain: Keychain,
    }

    impl Home {
        fn new() -> Self {
            Self {
                root: tempfile::tempdir().unwrap(),
                keychain: Keychain::default(),
            }
        }

        fn folders(&self) -> PlatformFolders {
            let data = self.root.path().join("data");
            PlatformFolders {
                data: data.clone(),
                local_data: Some(data.clone()),
                config: Some(data),
                webkit: Some(self.root.path().join("WebKit")),
            }
        }

        fn app(&self) -> AppFolders {
            AppFolders::for_channel(Channel::Dev, &self.folders().data)
        }

        fn resolve(&self) -> AppProfile {
            let keychain = self.keychain.clone();
            let open = move |service: &str| -> Arc<dyn SecretProvider> {
                Arc::new(keychain.service(service))
            };
            resolve_app_profile(Channel::Dev, &self.folders(), Some(&open))
        }

        /// An older build's profile: a database file and its credentials.
        fn install_previous(&self) {
            let previous = self.app().previous;
            std::fs::create_dir_all(&previous).unwrap();
            std::fs::write(previous.join("tidebreak.db"), b"conversations").unwrap();
            self.keychain.0.lock().unwrap().insert(
                ("tidebreak.dev".to_owned(), BUNDLE_KEY.to_owned()),
                bundle("app"),
            );
        }
    }

    /// The command line finds the app's profile where the app will: moved
    /// from the previous identity when nothing holds it, and left where it
    /// is, to attach to, while an older build runs on it.
    #[test]
    fn the_command_line_moves_the_app_profile_the_way_the_app_does() {
        // Nothing to move: the current folder, created by nothing.
        let home = Home::new();
        let profile = home.resolve();
        assert_eq!(profile.dir, home.app().current);
        assert!(!home.app().current.exists());

        // Only the previous folder, and nothing running on it: it moves, and
        // so do its credentials.
        let home = Home::new();
        home.install_previous();
        let profile = home.resolve();
        assert_eq!(profile.dir, home.app().current);
        assert_eq!(
            std::fs::read(home.app().current.join("tidebreak.db")).unwrap(),
            b"conversations"
        );
        assert!(
            identity_move::links_to(&home.app().previous, &home.app().current),
            "the old path links to the new folder"
        );
        assert_eq!(
            home.keychain
                .get("io.github.naingthet.tidebreak.dev", BUNDLE_KEY),
            Some(bundle("app"))
        );
        // Named through the link, the profile is the app's current one.
        assert_eq!(follow_move(&home.app().previous, &profile), profile.dir);
        assert_eq!(home.keychain.get("tidebreak.dev", BUNDLE_KEY), None);

        // An older build holds the previous folder: nothing moves, and the
        // command uses that folder, with that build's credential item.
        let home = Home::new();
        home.install_previous();
        let lock = std::fs::File::create(home.app().previous.join("tidebreak.lock")).unwrap();
        lock.try_lock().unwrap();
        let profile = home.resolve();
        assert_eq!(profile.dir, home.app().previous);
        assert!(!home.app().current.exists());
        assert_eq!(
            identity(Channel::Dev, &profile.dir, Some(&profile.folders), None).keychain_service,
            Some("tidebreak.dev".to_owned())
        );
        assert_eq!(
            home.keychain.get("tidebreak.dev", BUNDLE_KEY),
            Some(bundle("app"))
        );

        // Both hold data: the current one wins and the previous one stays.
        let home = Home::new();
        home.install_previous();
        std::fs::create_dir_all(&home.app().current).unwrap();
        std::fs::write(home.app().current.join("tidebreak.db"), b"newer").unwrap();
        let profile = home.resolve();
        assert_eq!(profile.dir, home.app().current);
        assert!(home.app().previous.join("tidebreak.db").is_file());
    }

    /// `TIDEBREAK_DATA_DIR` naming the app's previous folder follows it to
    /// where it moved, and names it as it is while it is still there.
    #[test]
    fn a_data_dir_naming_the_previous_folder_follows_the_move() {
        let root = tempfile::tempdir().unwrap();
        let folders = app_under(root.path());
        let moved = AppProfile {
            folders: folders.clone(),
            dir: folders.current.clone(),
        };
        assert_eq!(follow_move(&folders.previous, &moved), folders.current);
        let elsewhere = root.path().join("elsewhere");
        assert_eq!(follow_move(&elsewhere, &moved), elsewhere);

        // A link the move left at the old path counts as moved.
        #[cfg(unix)]
        {
            std::fs::create_dir_all(&folders.current).unwrap();
            std::os::unix::fs::symlink(&folders.current, &folders.previous).unwrap();
            assert_eq!(follow_move(&folders.previous, &moved), folders.current);
            // The current folder, named as itself, stays as named.
            assert_eq!(follow_move(&folders.current, &moved), folders.current);
            std::fs::remove_file(&folders.previous).unwrap();
        }

        // Still there, beside a current folder: the named one is used.
        std::fs::create_dir_all(&folders.previous).unwrap();
        assert_eq!(follow_move(&folders.previous, &moved), folders.previous);
        assert!(names_app_folder(&folders.previous, &folders));
        assert!(names_app_folder(&folders.current, &folders));
        assert!(!names_app_folder(&elsewhere, &folders));
    }
}
