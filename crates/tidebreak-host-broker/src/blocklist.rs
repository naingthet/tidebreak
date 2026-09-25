//! Applications that computer use cannot access, regardless of consent.
//!
//! The broker enforces this list, and the native helper mirrors it. Tidebreak's
//! own app family and OS security surfaces stay under human control. Other
//! development apps use explicit app grants, including terminals and editors
//! that can run local commands. Decision 94 defines the consent boundary.

/// Bundle ids blocked exactly and at a dotted boundary.
pub const BLOCKED_CONTROL_BUNDLES: &[&str] = &[
    // Reserve Tidebreak's app family for the controlling host. A separate
    // development target needs its own bundle id and isolated profile. The
    // family from before the app identity changed (decision 103) stays
    // reserved too: an older build may still be installed, and it is
    // Tidebreak all the same.
    "io.github.naingthet.tidebreak",
    "io.brightwave.tidebreak",
    // OS security and credential surfaces.
    "com.apple.loginwindow",
    "com.apple.SecurityAgent",
    "com.apple.CoreAuthUI",
    "com.apple.coreauthd",
    "com.apple.systempreferences",
    "com.apple.keychainaccess",
];

// Common development apps and command launchers need consent that explains
// local command execution. This list changes disclosure, never authorization:
// every app can expose commands, so app grants remain the authority.
const DEVELOPMENT_CONTROL_BUNDLES: &[&str] = &[
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "io.alacritty",
    "com.github.wez.wezterm",
    "com.mitchellh.ghostty",
    "com.microsoft.VSCode",
    "com.microsoft.VSCodeInsiders",
    "com.visualstudio.code.oss",
    // Cursor's stable ToDesktop-issued bundle id (not a com.cursor.* id).
    "com.todesktop.230313mzl4w4u92",
    "com.exafunction.windsurf",
    "com.apple.dt.Xcode",
    "com.jetbrains.",
    "com.sublimetext.",
    "com.panic.Nova",
    "com.google.android.studio",
    "dev.zed.Zed",
    "org.gnu.Emacs",
    "org.vim.MacVim",
    "com.runningwithcrayons.Alfred",
    "com.raycast.macos",
];

/// Whether an app is unavailable for every computer-use operation and grant.
/// Dotted boundaries protect app helpers without matching lookalike suffixes.
pub fn is_blocked_control_bundle(bundle_id: &str) -> bool {
    bundle_matches(BLOCKED_CONTROL_BUNDLES, bundle_id)
}

/// Whether app-control consent should call out local command execution.
/// A false result does not certify that the app cannot execute commands.
pub fn is_development_control_bundle(bundle_id: &str) -> bool {
    bundle_matches(DEVELOPMENT_CONTROL_BUNDLES, bundle_id)
}

fn bundle_matches(entries: &[&str], bundle_id: &str) -> bool {
    entries.iter().any(|entry| {
        let base = entry.strip_suffix('.').unwrap_or(entry);
        bundle_id == base
            || (bundle_id.len() > base.len()
                && bundle_id.starts_with(base)
                && bundle_id.as_bytes()[base.len()] == b'.')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controlling_host_and_security_surfaces_remain_blocked() {
        for blocked in [
            "io.github.naingthet.tidebreak",
            "io.github.naingthet.tidebreak.dev",
            "io.github.naingthet.tidebreak.staging",
            "io.github.naingthet.tidebreak.cu-helper",
            "io.brightwave.tidebreak",
            "io.brightwave.tidebreak.staging",
            "io.brightwave.tidebreak.helper",
            "com.apple.loginwindow",
            "com.apple.SecurityAgent",
            "com.apple.SecurityAgent.helper",
            "com.apple.CoreAuthUI",
            "com.apple.coreauthd",
            "com.apple.systempreferences",
            "com.apple.keychainaccess",
        ] {
            assert!(is_blocked_control_bundle(blocked), "{blocked}");
        }
    }

    #[test]
    fn development_apps_are_available_and_identified_for_stronger_consent() {
        for entry in DEVELOPMENT_CONTROL_BUNDLES {
            let bundle_id = entry.strip_suffix('.').unwrap_or(entry);
            assert!(!is_blocked_control_bundle(bundle_id), "{bundle_id}");
            assert!(is_development_control_bundle(bundle_id), "{bundle_id}");
        }
        for bundle_id in [
            "com.apple.Terminal.helper",
            "dev.warp.Warp-Stable",
            "com.jetbrains.intellij",
            "com.jetbrains.CLion",
            "com.sublimetext.4",
        ] {
            assert!(!is_blocked_control_bundle(bundle_id), "{bundle_id}");
            assert!(is_development_control_bundle(bundle_id), "{bundle_id}");
        }
    }

    /// Tidebreak's own bundle identifier, and the one builds before decision
    /// 103 ran under. The lookalikes below are derived from them, so they
    /// follow the identity wherever it moves.
    const OWN_BUNDLE: &str = "io.github.naingthet.tidebreak";
    const PREVIOUS_BUNDLE: &str = "io.brightwave.tidebreak";

    #[test]
    fn separate_products_and_isolated_development_targets_are_available() {
        let sibling_product = OWN_BUNDLE.replace(".tidebreak", ".another-product");
        let previous_sibling_product = PREVIOUS_BUNDLE.replace(".tidebreak", ".another-product");
        for bundle_id in [
            sibling_product.as_str(),
            previous_sibling_product.as_str(),
            "dev.tidebreak.fixture",
            "dev.tidebreak.desktop-test",
            "com.apple.Notes",
            "com.microsoft.Word",
        ] {
            assert!(!is_blocked_control_bundle(bundle_id), "{bundle_id}");
        }
    }

    #[test]
    fn bundle_matching_does_not_classify_lookalike_names() {
        let lookalike_vendor = OWN_BUNDLE.replacen(".tidebreak", "x.tidebreak", 1);
        let previous_lookalike_vendor = PREVIOUS_BUNDLE.replacen(".tidebreak", "x.tidebreak", 1);
        let lookalike_suffix = format!("{OWN_BUNDLE}ish");
        for bundle_id in [
            "xcom.apple.SecurityAgent",
            "com.apple.SecurityAgentish",
            lookalike_vendor.as_str(),
            previous_lookalike_vendor.as_str(),
            lookalike_suffix.as_str(),
            "com.apple.Terminalized",
            "com.jetbrainsx.intellij",
            "",
        ] {
            assert!(!is_blocked_control_bundle(bundle_id), "{bundle_id}");
            assert!(!is_development_control_bundle(bundle_id), "{bundle_id}");
        }
    }
}
