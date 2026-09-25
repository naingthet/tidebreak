use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;

use async_trait::async_trait;
use sha2::Digest as _;
use tidebreak_core::{AgentError, Result as CoreResult};

use super::*;

/// A keychain in memory: items by (service, key). A service can be set to
/// refuse reads, the way macOS answers when the person turns down the access
/// prompt, and every read is recorded, so a test can tell a prompt that was
/// never raised from one that was.
#[derive(Clone, Default)]
struct Keychain {
    items: Arc<Mutex<HashMap<(String, String), String>>>,
    refused: Arc<Mutex<HashSet<String>>>,
    reads: Arc<Mutex<Vec<String>>>,
}

impl Keychain {
    fn put(&self, service: &str, key: &str, value: &str) {
        self.items
            .lock()
            .unwrap()
            .insert((service.to_owned(), key.to_owned()), value.to_owned());
    }

    fn get(&self, service: &str, key: &str) -> Option<String> {
        self.items
            .lock()
            .unwrap()
            .get(&(service.to_owned(), key.to_owned()))
            .cloned()
    }

    fn refuse(&self, service: &str) {
        self.refused.lock().unwrap().insert(service.to_owned());
    }

    fn allow(&self, service: &str) {
        self.refused.lock().unwrap().remove(service);
    }

    fn reads_of(&self, service: &str) -> usize {
        self.reads
            .lock()
            .unwrap()
            .iter()
            .filter(|read| *read == service)
            .count()
    }

    fn opener(&self) -> impl Fn(&str) -> Arc<dyn SecretProvider> + Send + Sync {
        let keychain = self.clone();
        move |service: &str| {
            Arc::new(Service {
                keychain: keychain.clone(),
                service: service.to_owned(),
            }) as Arc<dyn SecretProvider>
        }
    }
}

struct Service {
    keychain: Keychain,
    service: String,
}

#[async_trait]
impl SecretProvider for Service {
    async fn get_secret(&self, key: &str) -> CoreResult<Option<String>> {
        self.keychain
            .reads
            .lock()
            .unwrap()
            .push(self.service.clone());
        if self
            .keychain
            .refused
            .lock()
            .unwrap()
            .contains(&self.service)
        {
            return Err(AgentError::Secret(
                "the person denied access to the keychain item".to_owned(),
            ));
        }
        Ok(self.keychain.get(&self.service, key))
    }

    async fn set_secret(&self, key: &str, value: &str) -> CoreResult<()> {
        self.keychain.put(&self.service, key, value);
        Ok(())
    }

    async fn delete_secret(&self, key: &str) -> CoreResult<()> {
        self.keychain
            .items
            .lock()
            .unwrap()
            .remove(&(self.service.clone(), key.to_owned()));
        Ok(())
    }
}

const PRODUCTION: IdentityChange = IDENTITY_CHANGES[0];
const CURRENT_SERVICE: &str = "io.github.naingthet.tidebreak";

/// A made-up credential bundle, built from pieces so nothing here reads as a
/// key.
fn bundle() -> String {
    let credential = ["fixture", "credential"].join("-");
    serde_json::json!({ "provider.openai.credential": credential }).to_string()
}

/// A home directory in a temporary folder, laid out the way macOS lays out
/// the folders an app gets: data, local data, and settings in one folder,
/// and WebKit's storage in another. The settings folder is split out as
/// Linux does, so every kind of folder moves in one test.
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
        let support = self.root.path().join("Application Support");
        PlatformFolders {
            data: support.clone(),
            local_data: Some(support),
            config: Some(self.root.path().join("config")),
            webkit: Some(self.root.path().join("WebKit")),
        }
    }

    fn plan(&self) -> Plan {
        Plan::new(PRODUCTION, &self.folders(), Some(CURRENT_SERVICE))
    }

    fn previous(&self, kind: FolderKind) -> PathBuf {
        self.folder(kind).from.clone()
    }

    fn current(&self, kind: FolderKind) -> PathBuf {
        self.folder(kind).to.clone()
    }

    fn folder(&self, kind: FolderKind) -> FolderMove {
        self.plan()
            .folders
            .into_iter()
            .find(|folder| folder.kind == kind)
            .unwrap()
    }

    /// Give the previous identity a profile: a data folder, WebKit storage,
    /// window settings, and a credential bundle.
    fn install_previous(&self) {
        fill(&self.previous(FolderKind::Data));
        let webkit = self.previous(FolderKind::WebView);
        fs::create_dir_all(webkit.join("WebsiteData").join("LocalStorage")).unwrap();
        fs::write(
            webkit
                .join("WebsiteData")
                .join("LocalStorage")
                .join("tauri_localhost_0.localstorage"),
            b"drafts and layout",
        )
        .unwrap();
        let settings = self.previous(FolderKind::Settings);
        fs::create_dir_all(&settings).unwrap();
        fs::write(settings.join(".window-state.json"), b"{\"main\":{}}").unwrap();
        self.keychain.put("tidebreak", BUNDLE_KEY, &bundle());
    }

    fn run(&self) -> Outcome {
        let open = self.keychain.opener();
        run(&self.plan(), Some(&open))
    }

    /// Run with a test's hooks: stop at `interrupt_at` as a crash would, and
    /// treat every rename as one across volumes.
    fn run_with(
        &self,
        interrupt_at: Option<Point>,
        across_volumes: bool,
    ) -> Result<Outcome, Interrupted> {
        let open = self.keychain.opener();
        let plan = self.plan();
        let mut mover = Mover::new(&plan, Some(&open));
        mover.interrupt_at = interrupt_at;
        mover.across_volumes = across_volumes;
        mover.run()
    }

    /// Everything a move leaves beside the folders while it is in progress.
    /// The lock file is not one of them: it stays once a move has run.
    fn leftovers(&self) -> Vec<PathBuf> {
        let plan = self.plan();
        let mut paths = vec![plan.journal_path()];
        paths.extend(plan.folders.iter().map(|folder| staging_path(&folder.to)));
        paths
            .into_iter()
            .filter(|path| fs::symlink_metadata(path).is_ok())
            .collect()
    }
}

/// A profile's data folder, with a nested file larger than one comparison
/// buffer, an empty folder, the empty instance lock a server leaves, and on
/// Unix a link.
fn fill(dir: &Path) {
    fs::create_dir_all(dir.join("logs")).unwrap();
    fs::create_dir_all(dir.join("blobs").join("ab")).unwrap();
    fs::create_dir_all(dir.join("empty")).unwrap();
    fs::write(dir.join("tidebreak.db"), b"every conversation").unwrap();
    fs::write(dir.join("logs").join("tidebreak.log"), b"a log line\n").unwrap();
    let mut blob = vec![0u8; 200_000];
    blob[150_000] = 7;
    fs::write(dir.join("blobs").join("ab").join("cd"), blob).unwrap();
    fs::write(dir.join(INSTANCE_LOCK_FILE), b"").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("tidebreak.db", dir.join("latest.db")).unwrap();
}

/// What a folder holds, by path under it: each file's length and digest,
/// folders, and link targets. The lock files and the move's record at the
/// top are left out: they hold none of the profile's data.
#[derive(Debug, PartialEq, Eq)]
enum Entry {
    File(usize, String),
    Folder,
    Link(PathBuf),
}

fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Entry> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Entry>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap().to_path_buf();
            if dir == root && (is_lock_file(&entry.file_name()) || entry.file_name() == RECORD_FILE)
            {
                continue;
            }
            let kind = entry.file_type().unwrap();
            if kind.is_symlink() {
                out.insert(relative, Entry::Link(fs::read_link(&path).unwrap()));
            } else if kind.is_dir() {
                out.insert(relative, Entry::Folder);
                walk(root, &path, out);
            } else {
                let bytes = fs::read(&path).unwrap();
                let digest = sha2::Sha256::digest(&bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                out.insert(relative, Entry::File(bytes.len(), digest));
            }
        }
    }
    let mut out = BTreeMap::new();
    if fs::symlink_metadata(dir).is_ok() {
        walk(dir, dir, &mut out);
    }
    out
}

fn expected_data() -> BTreeMap<PathBuf, Entry> {
    let scratch = tempfile::tempdir().unwrap();
    fill(scratch.path());
    snapshot(scratch.path())
}

fn ready(outcome: Outcome) -> Report {
    match outcome {
        Outcome::Ready(report) => report,
        other => panic!("expected the move to finish, got {other:?}"),
    }
}

fn result_for(report: &Report, kind: FolderKind) -> FolderResult {
    report
        .folders
        .iter()
        .find(|folder| folder.kind == kind)
        .map(|folder| folder.result.clone())
        .unwrap_or_else(|| panic!("no {kind:?} folder in {report:?}"))
}

/// Everything that should be true once a move has finished.
fn assert_moved(home: &Home, report: &Report, data: FolderResult) {
    assert_eq!(result_for(report, FolderKind::Data), data);
    assert_eq!(
        snapshot(&home.current(FolderKind::Data)),
        expected_data(),
        "the data folder arrived whole"
    );
    assert!(
        links_to(
            &home.previous(FolderKind::Data),
            &home.current(FolderKind::Data)
        ),
        "the previous data folder's path links to the new one"
    );
    assert!(result_for(report, FolderKind::WebView).moved());
    assert_eq!(
        fs::read(
            home.current(FolderKind::WebView)
                .join("WebsiteData")
                .join("LocalStorage")
                .join("tauri_localhost_0.localstorage")
        )
        .unwrap(),
        b"drafts and layout"
    );
    assert!(fs::symlink_metadata(home.previous(FolderKind::WebView)).is_err());
    assert!(result_for(report, FolderKind::Settings).moved());
    assert!(home
        .current(FolderKind::Settings)
        .join(".window-state.json")
        .is_file());
    assert_eq!(report.credentials, Some(CredentialResult::Moved));
    assert_eq!(
        home.keychain.get(CURRENT_SERVICE, BUNDLE_KEY),
        Some(bundle())
    );
    assert_eq!(home.keychain.get("tidebreak", BUNDLE_KEY), None);
    assert_eq!(home.leftovers(), Vec::<PathBuf>::new());
    let record = Record::unannounced(&home.current(FolderKind::Data))
        .expect("the move is recorded for the app to announce");
    assert_eq!(record.previous_identifier, "io.brightwave.tidebreak");
    assert_eq!(record.identifier, "io.github.naingthet.tidebreak");
}

#[test]
fn a_fresh_install_moves_nothing_and_creates_nothing() {
    let home = Home::new();
    let report = ready(home.run());
    assert_eq!(report, Report::default());
    for kind in [FolderKind::Data, FolderKind::WebView, FolderKind::Settings] {
        assert!(
            fs::symlink_metadata(home.current(kind)).is_err(),
            "{kind:?}"
        );
    }
    assert_eq!(home.leftovers(), Vec::<PathBuf>::new());
    assert!(!home.plan().mover_lock_path().exists(), "not even the lock");
    assert!(
        home.keychain.reads.lock().unwrap().is_empty(),
        "no keychain read"
    );
}

#[test]
fn a_previous_install_moves_with_one_rename_each() {
    let home = Home::new();
    home.install_previous();
    let report = ready(home.run());
    assert_moved(&home, &report, FolderResult::Renamed);
    assert_eq!(
        result_for(&report, FolderKind::WebView),
        FolderResult::Renamed
    );

    // The next launch finds nothing to move and asks the keychain nothing.
    let reads = home.keychain.reads.lock().unwrap().len();
    assert_eq!(ready(home.run()), Report::default());
    assert_eq!(home.keychain.reads.lock().unwrap().len(), reads);
}

#[test]
fn an_empty_current_folder_is_taken() {
    let home = Home::new();
    home.install_previous();
    let current = home.current(FolderKind::Data);
    fs::create_dir_all(current.join("logs")).unwrap();
    fs::write(current.join(INSTANCE_LOCK_FILE), b"").unwrap();
    let report = ready(home.run());
    assert_moved(&home, &report, FolderResult::Renamed);
}

#[test]
fn both_folders_holding_data_are_left_as_they_are() {
    let home = Home::new();
    home.install_previous();
    let current = home.current(FolderKind::Data);
    fs::create_dir_all(&current).unwrap();
    fs::write(current.join("tidebreak.db"), b"a newer profile").unwrap();

    let report = ready(home.run());
    assert_eq!(
        result_for(&report, FolderKind::Data),
        FolderResult::LeftBoth
    );
    assert_eq!(
        report.previous_left_beside(),
        Some(home.previous(FolderKind::Data).as_path())
    );
    assert_eq!(snapshot(&home.previous(FolderKind::Data)), expected_data());
    assert_eq!(
        fs::read(current.join("tidebreak.db")).unwrap(),
        b"a newer profile"
    );
    // Nothing else of the previous identity's moves either.
    assert!(home.previous(FolderKind::WebView).is_dir());
    assert!(fs::symlink_metadata(home.current(FolderKind::WebView)).is_err());
    assert_eq!(home.keychain.get("tidebreak", BUNDLE_KEY), Some(bundle()));
    assert_eq!(home.keychain.get(CURRENT_SERVICE, BUNDLE_KEY), None);
    assert!(Record::read(&current).is_none());
    assert_eq!(home.leftovers(), Vec::<PathBuf>::new());
}

#[test]
fn a_previous_folder_another_process_holds_moves_nothing() {
    for lock in [INSTANCE_LOCK_FILE, BROKER_LOCK_FILE] {
        let home = Home::new();
        home.install_previous();
        let previous = home.previous(FolderKind::Data);
        let held = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(previous.join(lock))
            .unwrap();
        held.try_lock().unwrap();

        assert_eq!(
            home.run(),
            Outcome::InUse {
                previous: previous.clone()
            },
            "{lock}"
        );
        assert_eq!(snapshot(&previous), expected_data(), "{lock}");
        assert!(fs::symlink_metadata(home.current(FolderKind::Data)).is_err());
        assert!(home.previous(FolderKind::WebView).is_dir());
        assert_eq!(home.keychain.get("tidebreak", BUNDLE_KEY), Some(bundle()));
        assert_eq!(home.leftovers(), Vec::<PathBuf>::new(), "{lock}");
        assert!(
            !home.plan().mover_lock_path().exists(),
            "{lock}: an older build that is running means nothing is created"
        );

        // Once the older build quits, the move goes ahead.
        drop(held);
        let report = ready(home.run());
        assert_moved(&home, &report, FolderResult::Renamed);
    }
}

/// Wherever a crash stops a move, the data is whole in one of the two
/// folders, the credential is in one of the two services, and the next
/// launch finishes the move.
fn crash_then_resume(points: &[Point], across_volumes: bool) {
    for &point in points {
        let home = Home::new();
        home.install_previous();
        assert_eq!(
            home.run_with(Some(point), across_volumes),
            Err(Interrupted),
            "{point:?}"
        );
        let whole = expected_data();
        assert!(
            snapshot(&home.previous(FolderKind::Data)) == whole
                || snapshot(&home.current(FolderKind::Data)) == whole,
            "{point:?}: no folder holds the data whole"
        );
        assert!(
            home.keychain.get("tidebreak", BUNDLE_KEY).is_some()
                || home.keychain.get(CURRENT_SERVICE, BUNDLE_KEY).is_some(),
            "{point:?}: the credential is in neither service"
        );

        let report = ready(home.run_with(None, across_volumes).unwrap());
        let data = if across_volumes {
            FolderResult::Copied
        } else {
            FolderResult::Renamed
        };
        assert_moved(&home, &report, data);
    }
}

#[test]
fn a_crash_at_each_step_of_a_rename_resumes() {
    crash_then_resume(
        &[
            Point::Begun,
            Point::BeforeRename,
            Point::Renamed,
            Point::OtherFolderMoved,
            Point::CredentialCopied,
            Point::CredentialVerified,
            Point::CredentialRemoved,
            Point::Recorded,
        ],
        false,
    );
}

#[test]
fn a_crash_at_each_step_of_a_copy_across_volumes_resumes() {
    crash_then_resume(
        &[
            Point::Begun,
            Point::BeforeRename,
            Point::CopyingFile,
            Point::Copied,
            Point::Verified,
            Point::Committed,
            Point::RemovingFile,
            Point::Removed,
            Point::Recorded,
        ],
        true,
    );
}

#[test]
fn a_move_across_volumes_copies_compares_then_removes() {
    let home = Home::new();
    home.install_previous();
    let report = ready(home.run_with(None, true).unwrap());
    assert_moved(&home, &report, FolderResult::Copied);
    assert_eq!(
        result_for(&report, FolderKind::WebView),
        FolderResult::Copied
    );
}

#[test]
fn a_copy_that_differs_is_caught() {
    let root = tempfile::tempdir().unwrap();
    let (from, to) = (root.path().join("from"), root.path().join("to"));
    fill(&from);
    let plan = Home::new().plan();
    let mover = Mover::new(&plan, None);
    mover.copy_tree(&from, &to, true).unwrap();
    assert_eq!(verify_tree(&from, &to, true).unwrap(), Ok(()));

    // One byte past the first comparison buffer.
    let blob = to.join("blobs").join("ab").join("cd");
    let mut bytes = fs::read(&blob).unwrap();
    bytes[150_000] = 8;
    fs::write(&blob, bytes).unwrap();
    assert!(verify_tree(&from, &to, true).unwrap().is_err());

    fs::remove_file(&blob).unwrap();
    assert!(verify_tree(&from, &to, true).unwrap().is_err());
}

#[test]
fn a_rename_across_volumes_turns_into_a_copy() {
    assert!(crosses_volumes(&io::Error::from(
        io::ErrorKind::CrossesDevices
    )));
    #[cfg(unix)]
    assert!(crosses_volumes(&io::Error::from_raw_os_error(18)));
    #[cfg(windows)]
    assert!(crosses_volumes(&io::Error::from_raw_os_error(17)));
    assert!(!crosses_volumes(&io::Error::from(
        io::ErrorKind::PermissionDenied
    )));
    assert!(!crosses_volumes(&io::Error::from(io::ErrorKind::NotFound)));
}

#[test]
fn credentials_move_to_the_current_service() {
    let home = Home::new();
    home.install_previous();
    // A per-key item a build older than the bundle left behind moves too, so
    // the server's re-home can fold it in.
    let legacy_key = crate::secret_rehome::static_secret_keys()[0].clone();
    home.keychain
        .put("tidebreak", &legacy_key, "a per-key value");

    let report = ready(home.run());
    assert_eq!(report.credentials, Some(CredentialResult::Moved));
    assert_eq!(
        home.keychain.get(CURRENT_SERVICE, BUNDLE_KEY),
        Some(bundle())
    );
    assert_eq!(
        home.keychain.get(CURRENT_SERVICE, &legacy_key).as_deref(),
        Some("a per-key value")
    );
    assert_eq!(home.keychain.get("tidebreak", BUNDLE_KEY), None);
    assert_eq!(home.keychain.get("tidebreak", &legacy_key), None);
}

#[test]
fn a_refused_credential_stays_where_it_was() {
    let home = Home::new();
    home.install_previous();
    home.keychain.refuse("tidebreak");

    let report = ready(home.run());
    // The data still moves; only the credential stays behind.
    assert_eq!(result_for(&report, FolderKind::Data), FolderResult::Renamed);
    assert!(matches!(
        report.credentials,
        Some(CredentialResult::Kept(_))
    ));
    assert_eq!(home.keychain.get("tidebreak", BUNDLE_KEY), Some(bundle()));
    assert_eq!(home.keychain.get(CURRENT_SERVICE, BUNDLE_KEY), None);
    // One refusal is the answer: the move does not ask again for each key.
    assert_eq!(home.keychain.reads_of("tidebreak"), 1);
    let record = Record::unannounced(&home.current(FolderKind::Data)).unwrap();
    assert!(matches!(
        record.credentials,
        Some(CredentialResult::Kept(_))
    ));
}

#[test]
fn a_credential_already_in_the_current_service_is_never_overwritten() {
    let home = Home::new();
    home.install_previous();
    home.keychain
        .put(CURRENT_SERVICE, BUNDLE_KEY, "signed in again");

    let report = ready(home.run());
    assert_eq!(report.credentials, Some(CredentialResult::Nothing));
    assert_eq!(
        home.keychain.get(CURRENT_SERVICE, BUNDLE_KEY).as_deref(),
        Some("signed in again")
    );
    assert_eq!(home.keychain.get("tidebreak", BUNDLE_KEY), Some(bundle()));
}

#[test]
fn the_record_announces_the_move_once() {
    let home = Home::new();
    home.install_previous();
    ready(home.run());
    let data = home.current(FolderKind::Data);
    assert!(Record::unannounced(&data).is_some());
    Record::mark_announced(&data).unwrap();
    assert!(Record::unannounced(&data).is_none());
    assert!(Record::read(&data).unwrap().notice_shown);
}

#[test]
fn an_unreadable_journal_starts_the_move_over() {
    let home = Home::new();
    home.install_previous();
    let journal = home.plan().journal_path();
    fs::create_dir_all(journal.parent().unwrap()).unwrap();
    fs::write(&journal, b"{ not json").unwrap();
    let report = ready(home.run());
    assert_moved(&home, &report, FolderResult::Renamed);
}

#[test]
fn each_platform_folder_moves_once() {
    let root = Path::new("/home/person");
    let kinds = |folders: PlatformFolders| -> Vec<FolderKind> {
        Plan::new(PRODUCTION, &folders, None)
            .folders
            .iter()
            .map(|folder| folder.kind)
            .collect()
    };
    let support = root.join("Library/Application Support");
    assert_eq!(
        kinds(PlatformFolders {
            data: support.clone(),
            local_data: Some(support.clone()),
            config: Some(support),
            webkit: Some(root.join("Library/WebKit")),
        }),
        [FolderKind::Data, FolderKind::WebView],
        "macOS"
    );
    let roaming = root.join("AppData/Roaming");
    assert_eq!(
        kinds(PlatformFolders {
            data: roaming.clone(),
            local_data: Some(root.join("AppData/Local")),
            config: Some(roaming),
            webkit: None,
        }),
        [FolderKind::Data, FolderKind::LocalData],
        "Windows"
    );
    let share = root.join(".local/share");
    assert_eq!(
        kinds(PlatformFolders {
            data: share.clone(),
            local_data: Some(share),
            config: Some(root.join(".config")),
            webkit: None,
        }),
        [FolderKind::Data, FolderKind::Settings],
        "Linux"
    );

    let plan = Plan::new(
        PRODUCTION,
        &PlatformFolders {
            data: root.join("data"),
            local_data: None,
            config: None,
            webkit: None,
        },
        Some(CURRENT_SERVICE),
    );
    assert_eq!(plan.data().from, root.join("data/io.brightwave.tidebreak"));
    assert_eq!(
        plan.data().to,
        root.join("data/io.github.naingthet.tidebreak")
    );
    assert_eq!(
        plan.credentials,
        Some(CredentialMove {
            from_service: "tidebreak".to_owned(),
            to_service: CURRENT_SERVICE.to_owned(),
        })
    );
}

#[test]
fn every_channel_has_a_previous_identity() {
    for (current, previous, service) in [
        (
            "io.github.naingthet.tidebreak",
            "io.brightwave.tidebreak",
            "tidebreak",
        ),
        (
            "io.github.naingthet.tidebreak.dev",
            "io.brightwave.tidebreak.dev",
            "tidebreak.dev",
        ),
        (
            "io.github.naingthet.tidebreak.staging",
            "io.brightwave.tidebreak.staging",
            "tidebreak.staging",
        ),
    ] {
        let change = identity_change(current).unwrap();
        assert_eq!(change.previous_identifier, previous);
        assert_eq!(change.previous_keychain_service, service);
    }
    assert_eq!(identity_change("io.brightwave.tidebreak"), None);
}

/// Run `git` in `cwd` and answer what it printed, failing the test if it
/// failed.
#[cfg(unix)]
fn git(cwd: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(["-c", "user.email=dev@example.com", "-c", "user.name=Dev"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// Worktrees made before 0.59 live in the data folder, and both their rows
/// and git's own records name them by absolute paths under the old folder.
/// The link the move leaves keeps every one of those paths working.
#[cfg(unix)]
#[test]
fn a_worktree_inside_the_old_data_folder_keeps_working_after_the_move() {
    let home = Home::new();
    home.install_previous();
    let repo = home.root.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    fs::write(repo.join("README.md"), b"hello\n").unwrap();
    git(&repo, &["add", "README.md"]);
    git(&repo, &["commit", "-m", "init"]);
    // The absolute path a workspace row holds for its worktree.
    let stored = home
        .previous(FolderKind::Data)
        .join("code")
        .join("worktrees")
        .join("repo")
        .join("ws-1");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-b",
            "ws-1",
            stored.to_str().unwrap(),
            "main",
        ],
    );

    let report = ready(home.run());
    assert_eq!(result_for(&report, FolderKind::Data), FolderResult::Renamed);
    let moved = home
        .current(FolderKind::Data)
        .join("code")
        .join("worktrees")
        .join("repo")
        .join("ws-1");
    assert!(moved.join("README.md").is_file(), "the worktree moved");
    assert_eq!(
        fs::canonicalize(&stored).unwrap(),
        fs::canonicalize(&moved).unwrap(),
        "the stored path still resolves, to where the worktree is now"
    );
    // Git's own record of the worktree survives a prune, and the worktree
    // still works as a checkout at the stored path.
    git(&repo, &["worktree", "prune"]);
    let listed = git(&repo, &["worktree", "list", "--porcelain"]);
    assert!(listed.contains("ws-1"), "{listed}");
    git(&stored, &["status", "--short"]);

    // The next launch has nothing to do, and leaves the link alone.
    assert_eq!(ready(home.run()), Report::default());
    assert!(links_to(
        &home.previous(FolderKind::Data),
        &home.current(FolderKind::Data)
    ));
}

/// A folder after the data folder that could not move is tried again on the
/// next launch, while its destination is still empty, and the retry does
/// not bring the notice back.
#[test]
fn a_folder_that_failed_to_move_moves_on_a_later_launch() {
    let home = Home::new();
    home.install_previous();
    let plan = home.plan();
    let open = home.keychain.opener();
    let mut mover = Mover::new(&plan, Some(&open));
    mover.fail_kind = Some(FolderKind::WebView);
    let report = ready(mover.run().unwrap());
    assert_eq!(result_for(&report, FolderKind::Data), FolderResult::Renamed);
    assert!(matches!(
        result_for(&report, FolderKind::WebView),
        FolderResult::Failed(_)
    ));
    assert!(home.previous(FolderKind::WebView).is_dir(), "it stayed");
    assert!(
        plan.journal_path().exists(),
        "the journal waits for the retry"
    );
    Record::mark_announced(&home.current(FolderKind::Data)).unwrap();

    let report = ready(home.run());
    assert_eq!(
        result_for(&report, FolderKind::WebView),
        FolderResult::Renamed
    );
    assert!(home
        .current(FolderKind::WebView)
        .join("WebsiteData")
        .join("LocalStorage")
        .join("tauri_localhost_0.localstorage")
        .is_file());
    assert!(!plan.journal_path().exists(), "nothing is left to try");
    assert!(Record::unannounced(&home.current(FolderKind::Data)).is_none());
    let record = Record::read(&home.current(FolderKind::Data)).unwrap();
    assert!(record
        .folders
        .iter()
        .any(|folder| folder.kind == FolderKind::WebView && folder.result.moved()));
}

/// A credential move that failed is tried once more on a later launch. A
/// refusal and a keychain that was briefly unavailable read alike, so a
/// second failure is the answer, and a third launch asks nothing.
#[test]
fn a_credential_move_that_failed_is_tried_once_more() {
    let home = Home::new();
    home.install_previous();
    home.keychain.refuse("tidebreak");
    let report = ready(home.run());
    assert!(matches!(
        report.credentials,
        Some(CredentialResult::Kept(_))
    ));
    assert!(home.plan().journal_path().exists());
    home.keychain.allow("tidebreak");
    let report = ready(home.run());
    assert_eq!(report.credentials, Some(CredentialResult::Moved));
    assert_eq!(
        home.keychain.get(CURRENT_SERVICE, BUNDLE_KEY),
        Some(bundle())
    );
    assert_eq!(home.keychain.get("tidebreak", BUNDLE_KEY), None);
    assert!(!home.plan().journal_path().exists());

    let home = Home::new();
    home.install_previous();
    home.keychain.refuse("tidebreak");
    ready(home.run());
    let report = ready(home.run());
    assert!(matches!(
        report.credentials,
        Some(CredentialResult::Kept(_))
    ));
    assert!(!home.plan().journal_path().exists());
    assert_eq!(home.keychain.reads_of("tidebreak"), 2);
    ready(home.run());
    assert_eq!(home.keychain.reads_of("tidebreak"), 2, "no third prompt");
    assert_eq!(home.keychain.get("tidebreak", BUNDLE_KEY), Some(bundle()));
}

/// The lock that keeps two moves apart is never removed: a process waiting
/// on a removed file would lock it while a third locked a new one.
#[test]
fn the_lock_file_stays_once_a_move_has_run() {
    let home = Home::new();
    home.install_previous();
    ready(home.run());
    assert!(home.plan().mover_lock_path().is_file());
    ready(home.run());
    assert!(home.plan().mover_lock_path().is_file());
}
