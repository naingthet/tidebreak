//! Move this install from the identity earlier builds ran under, before the
//! app opens anything under its own (decision 103).
//!
//! The move runs first thing in [`crate::run`]: before the embedded server
//! opens its database, before the webview creates its storage, and before
//! the window's saved state is written. Any of those would otherwise create
//! the new folders empty, and the move never merges into a folder that holds
//! something.
//!
//! When an older build is still running on the previous data folder, or the
//! move could not finish, the app opens no window and no server: a native
//! dialog says why and offers Try Again, so nothing starts under the new
//! identity while the person's data is elsewhere.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tidebreak_core::keychain::KeychainSecretProvider;
use tidebreak_core::SecretProvider;
use tidebreak_server::identity_move::{
    self, CredentialResult, Outcome, Plan, PlatformFolders, Record, Report,
};

use crate::channel::Channel;

/// What the move leaves the rest of the launch.
pub(crate) enum Prepared {
    /// Go on. The report says what moved, for the log once it is open.
    Ready(Report),
    /// Open nothing under the new identity, and say why.
    Blocked(Blocked),
}

/// Move whatever of the previous identity's is still to move. Blocking.
pub(crate) fn prepare(channel: Channel) -> Prepared {
    let Some(plan) = plan_for(channel) else {
        return Prepared::Ready(Report::default());
    };
    match identity_move::run(&plan, Some(&open_keychain)) {
        Outcome::Ready(report) => Prepared::Ready(report),
        outcome => Prepared::Blocked(Blocked { plan, outcome }),
    }
}

/// Everything the move carries for `channel` on this computer, or `None`
/// when the platform names no per-user data folder.
fn plan_for(channel: Channel) -> Option<Plan> {
    let change = identity_move::identity_change(channel.identifier())?;
    Some(Plan::new(
        change,
        &platform_folders()?,
        Some(channel.keychain_service()),
    ))
}

/// The per-user folders exactly as Tauri resolves them, which is through the
/// `dirs` crate, plus WebKit's storage folder on macOS.
fn platform_folders() -> Option<PlatformFolders> {
    Some(PlatformFolders {
        data: dirs::data_dir()?,
        local_data: dirs::data_local_dir(),
        config: dirs::config_dir(),
        webkit: if cfg!(target_os = "macos") {
            dirs::home_dir().map(|home| home.join("Library").join("WebKit"))
        } else {
            None
        },
    })
}

fn open_keychain(service: &str) -> Arc<dyn SecretProvider> {
    Arc::new(KeychainSecretProvider::with_service(service))
}

/// Why the app cannot start yet, and the move to try again.
pub(crate) struct Blocked {
    plan: Plan,
    outcome: Outcome,
}

impl Blocked {
    /// The dialog's title and message.
    fn words(&self) -> (String, String) {
        blocked_words(&self.outcome)
    }
}

fn blocked_words(outcome: &Outcome) -> (String, String) {
    match outcome {
        Outcome::InUse { previous } => (
            "Quit the other Tidebreak first".to_owned(),
            format!(
                "Tidebreak is moving your conversations and settings to a new folder, and \
                 another copy of Tidebreak is still using them. Quit the other Tidebreak, then \
                 click Try Again.\n\nYour data is safe where it is: {}",
                previous.display()
            ),
        ),
        Outcome::Failed {
            previous,
            current,
            error,
        } => (
            "Tidebreak could not move your data".to_owned(),
            format!(
                "Tidebreak is moving your conversations and settings to a new folder, and the \
                 move did not finish: {error}.\n\nNothing is lost: your data is still in {}. \
                 Click Try Again, or quit and move that folder to {} yourself.",
                previous.display(),
                current.display()
            ),
        ),
        Outcome::Ready(_) => (String::new(), String::new()),
    }
}

/// Run a stand-in for the app while it cannot start: no window, no server,
/// no window-state plugin, which would write its file into the new data
/// folder on exit. A native dialog says what to do. Try Again moves the data
/// if it can now, and then opens Tidebreak again as a fresh process, so the
/// webview's storage is in place before a webview exists.
pub(crate) fn run_blocked(mut context: tauri::Context<tauri::Wry>, blocked: Blocked) {
    for window in context.config_mut().app.windows.iter_mut() {
        window.create = false;
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            ask(app.handle().clone(), blocked);
            Ok(())
        })
        .build(context)
        .expect("error while building Tidebreak");
    app.run(|_, _| {});
}

fn ask(app: AppHandle, blocked: Blocked) {
    let (title, message) = blocked.words();
    let dialog = app.dialog().clone();
    dialog
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Try Again".to_owned(),
            "Quit".to_owned(),
        ))
        .show(move |try_again| {
            if !try_again {
                app.exit(0);
                return;
            }
            match identity_move::run(&blocked.plan, Some(&open_keychain)) {
                Outcome::Ready(_) => restart(&app),
                outcome => ask(
                    app,
                    Blocked {
                        plan: blocked.plan,
                        outcome,
                    },
                ),
            }
        });
}

/// Open Tidebreak again as a new process, now that its data is in place.
fn restart(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        crate::updater::relaunch_once_exited();
        app.exit(0);
    }
    #[cfg(not(target_os = "macos"))]
    app.restart();
}

/// What the app says once after it moved the data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataMoveNotice {
    /// Where the data folder is now.
    data_dir: String,
    /// The saved credentials stayed in the previous keychain entry, so the
    /// person signs in again.
    credentials_kept: bool,
    /// macOS asks again for Accessibility, Screen Recording, and keychain
    /// access, because they belong to the identity that changed.
    macos: bool,
}

fn notice_for(data_dir: PathBuf, record: &Record) -> DataMoveNotice {
    DataMoveNotice {
        data_dir: data_dir.display().to_string(),
        credentials_kept: matches!(record.credentials, Some(CredentialResult::Kept(_))),
        macos: cfg!(target_os = "macos"),
    }
}

/// The notice that Tidebreak moved its data, until the person dismisses it.
#[tauri::command]
pub(crate) fn data_move_notice(app: AppHandle) -> Option<DataMoveNotice> {
    let data = crate::data_dir(&app).ok()?;
    let record = Record::unannounced(&data)?;
    Some(notice_for(data, &record))
}

/// Never show that notice again.
#[tauri::command]
pub(crate) fn dismiss_data_move_notice(app: AppHandle) -> Result<(), String> {
    let data = crate::data_dir(&app)?;
    Record::mark_announced(&data)
        .map_err(|error| format!("Tidebreak could not save that you read the notice: {error}"))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use tidebreak_server::identity_move::FolderKind;

    use super::*;

    /// The move has to finish before anything under the new identity opens:
    /// the builder creates the window, and with it the webview's storage.
    #[test]
    fn the_move_runs_before_the_app_is_built() {
        let source = include_str!("lib.rs");
        let run = &source[source.find("pub fn run()").expect("lib.rs has run()")..];
        let moved = run
            .find("identity_move::prepare(")
            .expect("run() moves the previous identity's data");
        let built = run
            .find("tauri::Builder::default()")
            .expect("run() builds the app");
        assert!(moved < built, "the move must come before the app is built");
    }

    /// The webview's storage is one of the folders the move carries, wherever
    /// this platform keeps it outside the data folder. Paths only: nothing on
    /// this computer is read.
    #[test]
    fn the_webview_storage_moves_with_the_data() {
        let plan = plan_for(Channel::Production).expect("this computer has a data folder");
        let kinds: Vec<FolderKind> = plan.folders.iter().map(|folder| folder.kind).collect();
        assert_eq!(kinds[0], FolderKind::Data);
        let webview = if cfg!(target_os = "macos") {
            Some(FolderKind::WebView)
        } else if cfg!(windows) {
            Some(FolderKind::LocalData)
        } else {
            // WebKitGTK keeps it in the data folder, which moves first.
            None
        };
        if let Some(kind) = webview {
            let folder = plan
                .folders
                .iter()
                .find(|folder| folder.kind == kind)
                .expect("the webview's folder moves");
            assert!(folder.from.ends_with("io.brightwave.tidebreak"));
            assert!(folder.to.ends_with("io.github.naingthet.tidebreak"));
        }
        if cfg!(target_os = "macos") {
            let webkit = &plan.folders[1].from;
            assert!(webkit.ends_with(Path::new("Library/WebKit/io.brightwave.tidebreak")));
        }
        assert_eq!(
            plan.credentials.map(|credentials| credentials.to_service),
            Some("io.github.naingthet.tidebreak".to_owned())
        );
    }

    #[test]
    fn the_dialog_says_what_to_quit_and_where_the_data_is() {
        let previous =
            PathBuf::from("/Users/alex/Library/Application Support/io.brightwave.tidebreak");
        let (title, message) = blocked_words(&Outcome::InUse {
            previous: previous.clone(),
        });
        assert_eq!(title, "Quit the other Tidebreak first");
        assert!(message.contains("Quit the other Tidebreak, then click Try Again."));
        assert!(message.contains(&previous.display().to_string()));

        let (title, message) = blocked_words(&Outcome::Failed {
            previous: previous.clone(),
            current: PathBuf::from(
                "/Users/alex/Library/Application Support/io.github.naingthet.tidebreak",
            ),
            error: "the disk is full".to_owned(),
        });
        assert_eq!(title, "Tidebreak could not move your data");
        assert!(message.contains("the disk is full"));
        assert!(message.contains("Nothing is lost"));
        assert!(message.contains(&previous.display().to_string()));
    }

    #[test]
    fn the_notice_asks_for_sign_in_only_when_credentials_stayed_behind() {
        let record = |credentials| Record {
            previous_identifier: "io.brightwave.tidebreak".to_owned(),
            identifier: "io.github.naingthet.tidebreak".to_owned(),
            moved_at: chrono::Utc::now(),
            folders: Vec::new(),
            credentials,
            notice_shown: false,
        };
        let data = PathBuf::from("/data");
        assert!(!notice_for(data.clone(), &record(Some(CredentialResult::Moved))).credentials_kept);
        assert!(!notice_for(data.clone(), &record(None)).credentials_kept);
        assert!(
            notice_for(
                data,
                &record(Some(CredentialResult::Kept("denied".to_owned())))
            )
            .credentials_kept
        );
    }
}
