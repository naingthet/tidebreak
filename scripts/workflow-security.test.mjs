import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  process.env.TIDEBREAK_POLICY_ROOT ??
    fileURLToPath(new URL("..", import.meta.url)),
);
const repositoryFile = (...parts) => join(repositoryRoot, ...parts);
const workflowDirectory = repositoryFile(".github", "workflows");
const workflows = Object.fromEntries(
  readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => [name, readFileSync(join(workflowDirectory, name), "utf8")]),
);
const compilerCacheAction = readFileSync(
  repositoryFile(".github", "actions", "setup-sccache", "action.yml"),
  "utf8",
);
const releaseDrafterConfig = readFileSync(
  repositoryFile(".github", "release-drafter.yml"),
  "utf8",
);
const codeOwners = readFileSync(
  repositoryFile(".github", "CODEOWNERS"),
  "utf8",
);
const tauriConfig = JSON.parse(
  readFileSync(
    repositoryFile("crates", "tidebreak-desktop", "tauri.conf.json"),
    "utf8",
  ),
);
const desktopCargo = readFileSync(
  repositoryFile("crates", "tidebreak-desktop", "Cargo.toml"),
  "utf8",
);
const desktopHost = readFileSync(
  repositoryFile("crates", "tidebreak-desktop", "src", "lib.rs"),
  "utf8",
);
const desktopUpdater = readFileSync(
  repositoryFile("crates", "tidebreak-desktop", "src", "updater.rs"),
  "utf8",
);
const desktopBroker = readFileSync(
  repositoryFile("crates", "tidebreak-desktop", "src", "broker.rs"),
  "utf8",
);
const desktopVoice = readFileSync(
  repositoryFile(
    "crates",
    "tidebreak-desktop",
    "src",
    "voice_transcription.rs",
  ),
  "utf8",
);
const desktopWhisperInstall = readFileSync(
  repositoryFile(
    "crates",
    "tidebreak-desktop",
    "src",
    "whisper_install.rs",
  ),
  "utf8",
);
const dockerIgnore = readFileSync(
  repositoryFile("deploy", "self-host", "Dockerfile.dockerignore"),
  "utf8",
);
const selfHostDockerfile = readFileSync(
  repositoryFile("deploy", "self-host", "Dockerfile"),
  "utf8",
);
const denyConfig = readFileSync(repositoryFile("deny.toml"), "utf8");
const docsPackage = JSON.parse(
  readFileSync(repositoryFile("docs-site", "package.json"), "utf8"),
);
const tauriCliPackagePath = repositoryFile(
  ".github",
  "tauri-cli",
  "package.json",
);
const tauriCliLockPath = repositoryFile(
  ".github",
  "tauri-cli",
  "pnpm-lock.yaml",
);
const tauriCliPackage = existsSync(tauriCliPackagePath)
  ? JSON.parse(readFileSync(tauriCliPackagePath, "utf8"))
  : null;
const tauriCliLock = existsSync(tauriCliLockPath)
  ? readFileSync(tauriCliLockPath, "utf8")
  : null;
const packagedGhDiscoverySmoke = readFileSync(
  repositoryFile("scripts", "smoke-packaged-gh-discovery.sh"),
  "utf8",
);

function workflowJob(source, name) {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow job: ${name}`);
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  const end =
    next === -1 ? source.length : start + marker.length + next;
  return source.slice(start, end);
}

// The Conventional Commit title check is a required context. It may live in
// ci.yml or beside the label job in release-draft.yml; wherever it lives, its
// host workflow must re-run it when the title or labels change, and it must
// judge the canonical repository's labels from the trusted base-branch policy.
function semanticTitleCheck() {
  for (const file of ["ci.yml", "release-draft.yml"]) {
    const source = workflows[file];
    const at = source.indexOf("    name: semantic PR title\n");
    if (at === -1) continue;
    const keys = [...source.slice(0, at).matchAll(/^  ([a-zA-Z0-9_-]+):\n/gm)];
    assert.ok(keys.length > 0, `no job key precedes the title check in ${file}`);
    return { file, source, job: workflowJob(source, keys.at(-1)[1]) };
  }
  assert.fail("no workflow defines the semantic PR title job");
}

test("the maintainer owns repository changes", () => {
  assert.equal(codeOwners.trim(), "* @naingthet");
});

const DESKTOP_SIGNING_JOBS = [
  {
    file: "release.yml",
    name: "build_macos",
    validate: "Validate production signing configuration",
  },
  {
    file: "release.yml",
    name: "build_windows",
    validate: "Validate updater signing configuration",
  },
  {
    file: "release.yml",
    name: "build_linux",
    validate: "Verify and collect Linux artifacts",
  },
];

function desktopSigningJobs() {
  return DESKTOP_SIGNING_JOBS.map((spec) => ({
    ...spec,
    job: workflowJob(workflows[spec.file], spec.name),
  }));
}

function cargoDownloadCache(job) {
  return job.match(
    /- name: Cache Cargo downloads[\s\S]*?(?=\n\s+- (?:name:|uses:))/,
  )?.[0];
}

function firstSigningMaterialIndex(job, validate) {
  const markers = [
    `- name: ${validate}`,
    "- name: Prepare App Store Connect key",
    "- name: Import Developer ID certificate",
  ];
  const positions = markers
    .map((marker) => job.indexOf(marker))
    .filter((index) => index !== -1);
  return positions.length === 0 ? -1 : Math.min(...positions);
}

function assertCachesRestoreBeforeSigningMaterial(job, name, validate) {
  const secretsAt = firstSigningMaterialIndex(job, validate);
  assert.notEqual(secretsAt, -1, `${name} must load signing material`);
  const restores = job.matchAll(/^\s+- name: (.*Restore.*cache.*)$/gim);
  for (const restore of restores) {
    assert.ok(
      restore.index < secretsAt,
      `${name} must restore ${restore[1]} before loading secrets`,
    );
  }
}

function stripRustCommentsAndStrings(source) {
  const masked = [...source];
  const erase = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (masked[index] !== "\n") masked[index] = " ";
    }
  };
  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      erase(index, end === -1 ? source.length : end);
      index = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      erase(index, end === -1 ? source.length : end + 2);
      index = end === -1 ? source.length : end + 1;
    } else if (source[index] === '"' || source[index] === "'") {
      const quote = source[index];
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") end += 2;
        else if (source[end++] === quote) break;
      }
      erase(index, end);
      index = end - 1;
    }
  }
  return masked.join("");
}

function rustDelimitedBody(source, marker) {
  const stripped = stripRustCommentsAndStrings(source);
  const match = stripped.match(marker);
  assert.ok(match, `missing Rust body for ${marker}`);
  const start = match.index + match[0].length;
  const open = stripped.indexOf("{", start);
  assert.notEqual(open, -1, `missing opening brace for ${marker}`);
  let depth = 1;
  for (let index = open + 1; index < stripped.length; index += 1) {
    if (stripped[index] === "{") depth += 1;
    if (stripped[index] === "}" && --depth === 0) {
      return stripped.slice(open + 1, index);
    }
  }
  throw new Error(`unbalanced Rust body for ${marker}`);
}

function rustFunctionBody(source, name) {
  return rustDelimitedBody(source, new RegExp(`\\b(?:async\\s+)?fn\\s+${name}\\b`));
}

function hasOrderedUniqueTokens(body, tokens) {
  let previous = -1;
  return tokens.every((token) => {
    const position = body.indexOf(token);
    if (position === -1 || position <= previous || body.indexOf(token, position + token.length) !== -1) {
      return false;
    }
    previous = position;
    return true;
  });
}

function updaterTransitionIsSafe(updater, broker) {
  const restart = rustFunctionBody(updater, "take_staged_and_restart");
  const reversibleMarker = /\b(?:async\s+)?fn\s+install_behind_broker_barrier\b/;
  if (!reversibleMarker.test(stripRustCommentsAndStrings(updater))) {
    return false;
  }
  const barrier = rustFunctionBody(updater, "install_behind_broker_barrier");
  const quiesce = "quiesce().await?";
  const installCall = "match install()";
  const resume = "resume().await";
  const shutdown = "shutdown().await";
  const barrierOrdered =
    hasOrderedUniqueTokens(barrier, [quiesce, installCall, shutdown, resume]) &&
    (barrier.match(/\binstall\(\)/g) ?? []).length === 1;
  const bindings = /install_behind_broker_barrier\(\s*\|\| host_access\.quiesce_for_update\(\),\s*\|\| staged\.update\.install\(&staged\.bytes\),\s*\|\| host_access\.resume_after_failed_update\(\),\s*\|\| host_access\.shutdown\(\),\s*\)/s;
  const admit = rustFunctionBody(broker, "admit");
  const quiesceArm = rustDelimitedBody(broker, /BrokerCommand::Quiesce\s*\{\s*reply\s*\}\s*=>/);
  const resumeArm = rustDelimitedBody(
    broker,
    /BrokerCommand::ResumeAfterFailedUpdate\s*\{\s*reply\s*\}\s*=>/,
  );
  const session = rustFunctionBody(broker, "ensure_session");
  return (
    barrierOrdered &&
    bindings.test(restart) &&
    !admit.includes("drop(admission)") &&
    hasOrderedUniqueTokens(admit, [
      "BrokerAdmission::Running",
      "self.commands.try_send(command)",
    ]) &&
    hasOrderedUniqueTokens(quiesceArm, ["self.ensure_session().await", "reply.send("]) &&
    hasOrderedUniqueTokens(resumeArm, ["self.allow_session_start = false", "reply.send("]) &&
    hasOrderedUniqueTokens(session, [
      "if !self.allow_session_start",
      "return Err(BrokerClientError::UpdateRecovery)",
    ])
  );
}

test("third-party workflow actions use immutable commit SHAs", () => {
  for (const [name, source] of Object.entries(workflows)) {
    for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
      const reference = match[1];
      if (reference.startsWith("./")) {
        continue;
      }
      assert.match(
        reference,
        /^[^@\s]+@[0-9a-f]{40}$/,
        `${name} has a mutable action reference: ${reference}`,
      );
    }
  }
});

test("release-drafter retains a stable draft tag after formatting", () => {
  assert.match(releaseDrafterConfig, /name-template: "v\$RESOLVED_VERSION"/);
  assert.match(releaseDrafterConfig, /tag-template: "v\$RESOLVED_VERSION"/);
  assert.match(releaseDrafterConfig, /^tag-prefix: "v"$/m);
  assert.match(releaseDrafterConfig, /\$NEW_CONTRIBUTORS/);
  assert.match(releaseDrafterConfig, /\*\*Full Changelog\*\*:/);

  const draftJob = workflowJob(workflows["release-draft.yml"], "draft");
  const requireBaselineAt = draftJob.indexOf(
    "node scripts/require-release-baseline.mjs",
  );
  const releaseDrafterAt = draftJob.indexOf("id: release_drafter");
  assert.notEqual(requireBaselineAt, -1);
  assert.notEqual(releaseDrafterAt, -1);
  assert.ok(
    requireBaselineAt < releaseDrafterAt,
    "the published baseline must be confirmed before Release Drafter runs",
  );
  assert.match(draftJob, /git ls-remote --tags origin 'v\*'/);
  assert.match(
    draftJob,
    /RELEASE_TAG: v\$\{\{ steps\.release_drafter\.outputs\.resolved_version \}\}/,
  );
  assert.match(
    draftJob,
    /\{tag_name: \$tag, body: \$body\}/,
  );
  assert.match(draftJob, /node scripts\/reconcile-release-drafts\.mjs/);
  assert.match(draftJob, /Keep exactly one native release draft/);
  assert.match(draftJob, /max_attempts=5/);
  assert.match(draftJob, /\[\[ "\$action" != retry \]\]/);
  assert.match(draftJob, /\.delete_ids\[\]/);
  assert.match(draftJob, /jq -r \.action/);
});

test("publishing a release dispatches the server image build", () => {
  // A release this workflow publishes raises no `release` event, because the
  // PATCH that publishes it runs on GITHUB_TOKEN. Relying on the declared
  // `release` trigger alone shipped a release with no server image and no
  // failed run to notice. The dispatch is the working path; assert it stays.
  const finalizeJob = workflowJob(workflows["release.yml"], "finalize_release");
  assert.match(finalizeJob, /actions: write/);
  const dispatchAt = finalizeJob.indexOf(
    "gh workflow run publish-server-image.yml",
  );
  assert.notEqual(
    dispatchAt,
    -1,
    "finalize_release must dispatch the server image build",
  );
  assert.match(
    finalizeJob.slice(dispatchAt, dispatchAt + 200),
    /--field "release_tag=\$RELEASE_TAG"/,
  );

  // Dispatch only on the draft-to-published transition. Re-running the release
  // workflow against an already-published release must not rebuild an image,
  // because a version tag that exists on GHCR fails the publish.
  const dispatchStep = finalizeJob.slice(
    finalizeJob.lastIndexOf("- name:", dispatchAt),
    dispatchAt,
  );
  assert.match(
    dispatchStep,
    /if: \$\{\{ needs\.validate\.outputs\.draft == 'true' \}\}/,
  );

  // The release is public by the time these run, so a disabled workflow warns
  // instead of failing the run and skipping the draft refresh.
  assert.match(finalizeJob, /if ! gh workflow run publish-server-image\.yml/);
  assert.match(finalizeJob, /if ! gh workflow run release-draft\.yml/);

  // The declared trigger stays for a release published by hand in the UI.
  assert.match(
    workflows["publish-server-image.yml"],
    /^on:\n {2}release:\n {4}types: \[published\]$/m,
  );
});

test("workflow container images are pinned by digest", () => {
  for (const [name, source] of Object.entries(workflows)) {
    for (const match of source.matchAll(/^\s*image:\s*([^\s#]+)/gm)) {
      assert.match(
        match[1],
        /^[^@\s]+@sha256:[0-9a-f]{64}$/,
        `${name} has a mutable container image: ${match[1]}`,
      );
    }
  }

  assert.match(
    workflows["ci.yml"],
    /ghcr\.io\/gitleaks\/gitleaks@sha256:[0-9a-f]{64}/,
  );
  assert.doesNotMatch(workflows["ci.yml"], /gitleaks\/gitleaks:latest/);
});

test("PR lanes are scope-gated, never label-gated", () => {
  const ci = workflows["ci.yml"];
  const changes = workflowJob(ci, "changes");
  const docsSite = workflowJob(ci, "docs-site");
  const fmt = workflowJob(ci, "fmt");
  const postgres = workflowJob(ci, "postgres");
  const testPartitions = workflowJob(ci, "test");
  const testAggregate = workflowJob(ci, "test-aggregate");

  assert.match(
    ci,
    /^on:\n  push:\n    branches: \[main\]\n  pull_request:/m,
  );
  const ciTrigger =
    /^  pull_request:\n\s+types:\s*\[([^\]]*)\]/m.exec(ci);
  assert.ok(ciTrigger, "ci.yml must list its pull request event types");
  assert.deepEqual(
    ciTrigger[1].split(",").map((event) => event.trim()),
    ["opened", "reopened", "synchronize", "ready_for_review"],
  );
  assert.doesNotMatch(ci, /^  merge_group:/m);
  assert.doesNotMatch(workflowJob(ci, "changes"), /MERGE_GROUP_|merge_group\)/);
  const title = semanticTitleCheck();
  assert.equal(title.file, "release-draft.yml");
  const titleTrigger =
    /^  pull_request(?:_target)?:\n\s+types:\s*\[([^\]]*)\]/m.exec(title.source);
  assert.ok(
    titleTrigger,
    `${title.file} must list the pull request events that re-check the title`,
  );
  const titleEvents = titleTrigger[1].split(",").map((event) => event.trim());
  for (const event of [
    "opened",
    "reopened",
    "synchronize",
    "edited",
    "labeled",
    "unlabeled",
    "ready_for_review",
  ]) {
    assert.ok(
      titleEvents.includes(event),
      `${title.file} must re-check the title on ${event}`,
    );
  }
  assert.match(title.job, /node scripts\/check-pr-title\.mjs "\$PR_TITLE"/);
  assert.match(title.job, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.doesNotMatch(ci, /^  build:$/m);
  assert.match(
    ci,
    /cp "\$trusted" "\$GITHUB_WORKSPACE\/scripts\/\.trusted-workflow-security\.test\.mjs"/,
  );
  assert.doesNotMatch(
    ci,
    /sed -i/,
    "the trusted policy runs as checked in; do not rewrite it",
  );
  assert.match(title.job, /CANONICAL_REPOSITORY: naingthet\/tidebreak/);
  assert.match(
    title.job,
    /repos\/\$CANONICAL_REPOSITORY\/pulls\/\$PR_NUMBER/,
  );
  const releaseDraft = workflows["release-draft.yml"];
  assert.match(
    releaseDraft,
    /CANONICAL_REPOSITORY: naingthet\/tidebreak/,
  );
  assert.match(
    workflowJob(releaseDraft, "label"),
    /repos\/\$CANONICAL_REPOSITORY\/issues\/\$PR_NUMBER/,
  );
  assert.match(
    ci,
    /node --test scripts\/\.trusted-workflow-security\.test\.mjs/,
  );
  assert.match(ci, /node --test scripts\/\*\.test\.mjs/);
  assert.doesNotMatch(
    ci,
    /cp "\$trusted" "\$GITHUB_WORKSPACE\/scripts\/workflow-security\.test\.mjs"/,
  );
  // A pull request's green checks must prove the same commits stay green on
  // main: no platform-neutral lane may hide behind an opt-in label. Windows
  // `cargo check` is rust-scoped like clippy.
  assert.doesNotMatch(ci, /full-ci/);
  assert.doesNotMatch(fmt, /github\.event_name/);
  assert.match(postgres, /TIDEBREAK_REQUIRE_POSTGRES_TEST: "true"/);
  // The narrower `workspace` scope must imply the `rust` one. Without this the
  // crate-coverage lanes could be gated on a scope that never ran for them.
  assert.match(
    changes,
    /if \[\[ "\$workspace" == true && "\$rust" != true \]\]; then/,
  );
  assert.doesNotMatch(ci, /^  rust:$/m);
  assert.doesNotMatch(ci, /name: fmt · clippy · build · test/);

  for (const [job, scope] of [
    [workflowJob(ci, "lint"), "rust"],
    [workflowJob(ci, "desktop"), "rust"],
    [workflowJob(ci, "windows-check"), "rust"],
    [workflowJob(ci, "macos-desktop"), "rust"],
    [workflowJob(ci, "macos-sandbox"), "workspace"],
    [testPartitions, "workspace"],
    [postgres, "workspace"],
    [workflowJob(ci, "ui"), "ui"],
    [workflowJob(ci, "storybook-a11y"), "ui"],
    [docsSite, "docs_site"],
  ]) {
    assert.match(
      job,
      new RegExp(
        `if: \\$\\{\\{ needs\\.changes\\.outputs\\.${scope} == 'true' \\}\\}`,
      ),
    );
  }

  for (const job of [
    workflowJob(ci, "lint"),
    workflowJob(ci, "desktop"),
    testPartitions,
    postgres,
  ]) {
    assert.match(
      job,
      /shared-key: cargo-registry-v3-\$\{\{ hashFiles\('Cargo\.lock'\) \}\}/,
    );
    assert.match(job, /add-rust-environment-hash-key: "false"/);
    assert.match(job, /cache-targets: false/);
  }
  // The registry cache has one writer, and only on main. A lane may narrow
  // that further (one matrix leg, say) but never widen it.
  assert.match(
    testPartitions,
    /save-if: \$\{\{ github\.ref == 'refs\/heads\/main'(?: && [^|}]*)? \}\}/,
  );
  assert.match(testPartitions, /cache-on-failure: true/);
  assert.match(
    testPartitions,
    /strategy:\n\s+fail-fast: false\n\s+matrix:\n\s+part: \[1, 2, 3\]/,
  );
  assert.match(
    testPartitions,
    /cargo nextest run --workspace --exclude tidebreak-desktop\n\s+--locked --retries 2 --partition count:\$\{\{ matrix\.part \}\}\/3 --no-default-features/,
  );
  assert.match(testAggregate, /name: test\n/);
  assert.match(testAggregate, /needs: \[changes, test\]/);
  assert.match(testAggregate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(testAggregate, /CHANGE_SCOPE_RESULT: \$\{\{ needs\.changes\.result \}\}/);
  assert.match(testAggregate, /PARTITION_RESULT: \$\{\{ needs\.test\.result \}\}/);
  assert.match(testAggregate, /WORKSPACE_SCOPE: \$\{\{ needs\.changes\.outputs\.workspace \}\}/);
  assert.match(testAggregate, /"\$PARTITION_RESULT" != success/);
  assert.doesNotMatch(ci, /^  parsers:$/m);
  assert.doesNotMatch(ci, /outputs\.parsers|echo "parsers=/);
  assert.match(changes, /\*\.md\|docs\/\*\|assets\/\*\|\.githooks\/\*/);

  // The documentation site has a pre-merge execution lane. A docs-only
  // Dependabot update must not fall through to unrelated Rust jobs, and an
  // edit to the Pages workflow runs the same lane.
  assert.match(
    changes,
    /docs-site\/\*\|\.github\/workflows\/docs\.yml\) docs_site=true/,
  );
  assert.match(changes, /echo "docs_site=true"/);
  assert.match(docsSite, /pnpm install --frozen-lockfile/);
  assert.match(docsSite, /run: pnpm types:check/);
  assert.match(docsSite, /run: pnpm lint/);
  assert.match(docsSite, /run: pnpm build/);

  const desktop = workflowJob(ci, "desktop");
  // The lane may run the desktop tests under cargo test or, once its
  // credential tests fold into the same build, under one nextest invocation.
  assert.match(
    desktop,
    /cargo (?:test|nextest run) (?:--locked )?-p tidebreak-desktop/,
  );
  for (const [name, step] of [
    ["lint", "Install system deps (Tauri)"],
    ["desktop", "Install system deps (Tauri)"],
    ["test", "Install headless system deps"],
  ]) {
    const job = workflowJob(ci, name);
    const escapedStep = step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const deps = job.match(
      new RegExp(
        `- name: ${escapedStep}[\\s\\S]*?(?=\\n\\s+- (?:name:|uses:))`,
      ),
    )?.[0];
    assert.ok(deps, `missing ${name} apt step`);
    assert.match(deps, /timeout-minutes: 8/);
    assert.match(deps, /scripts\/install-linux-apt-packages\.sh/);
    assert.doesNotMatch(deps, /sudo apt-get update/);
  }
  assert.match(
    desktopCargo,
    /tidebreak-server = \{ path = "\.\.\/tidebreak-server(?:-api)?" \}/,
  );
  assert.doesNotMatch(desktopCargo, /document-parsers/);
});

// A main push that a newer commit has already replaced must not keep an
// expensive lane busy, and must not report `cancelled` when it stops: GitHub
// rolls a cancelled check up as a red X on a commit whose own checks all
// passed, so main's commit list reads as broken when it is not. A guard step
// reads main's tip and skips the run, which reports success.
//
// The shape only holds if every step the guard exists to avoid is gated on it.
// One ungated expensive step and a superseded run does its work anyway.
function skipsSupersededPush(job) {
  const guard =
    /^ {6}- name: [^\n]*\n {8}id: tip\n {8}if: \$\{\{ github\.event_name == 'push' \}\}\n/m.exec(
      job,
    );
  if (!guard) return false;
  if (!/repos\/\$GITHUB_REPOSITORY\/commits\/main/.test(job)) return false;
  if (!/superseded=true/.test(job)) return false;
  const rest = job.slice(guard.index + guard[0].length);
  const steps = rest.split(/\n(?= {6}- )/).slice(1);
  return (
    steps.length > 0 &&
    steps.every((step) =>
      /\n {8}if: \$\{\{ steps\.tip\.outputs\.superseded != 'true'/.test(step),
    )
  );
}

test("Windows cargo check is rust-scoped and skips superseded main pushes", () => {
  const ci = workflows["ci.yml"];
  const windowsCheck = workflowJob(ci, "windows-check");
  const changes = workflowJob(ci, "changes");
  assert.match(windowsCheck, /name: Windows cargo check/);
  assert.match(windowsCheck, /Check the Windows installer crates/);
  // Standard hosted runners are free for a public repository.
  assert.match(windowsCheck, /runs-on: windows-latest\n/);
  assert.match(windowsCheck, /Stage sidecar placeholders for cargo check/);
  assert.doesNotMatch(windowsCheck, /prepare-sidecar\.mjs/);
  for (const crate of [
    "tidebreak-core",
    "tidebreak-code-execution",
    "tidebreak-cli",
    "tidebreak-host-broker",
    "tidebreak-server",
    "tidebreak-desktop",
  ]) {
    assert.match(windowsCheck, new RegExp(`-p ${crate}`));
  }
  assert.match(windowsCheck, /cargo check --target x86_64-pc-windows-msvc/);
  assert.doesNotMatch(windowsCheck, /cargo test/);
  assert.doesNotMatch(ci, /windows-ci/);
  assert.doesNotMatch(ci, /^  windows-native:$/m);
  assert.doesNotMatch(changes, /echo "windows=/);
  assert.doesNotMatch(changes, /windows_native/);
  assert.ok(
    skipsSupersededPush(windowsCheck),
    "a superseded main push must skip the Windows lane, not cancel it",
  );
  assert.doesNotMatch(
    windowsCheck,
    /cancel-in-progress/,
    "cancelling this lane reddens a commit whose own checks all passed",
  );
  assert.doesNotMatch(windowsCheck, /id-token: write/);
  assert.match(windowsCheck, /RUSTC_WRAPPER: sccache/);
  assert.match(windowsCheck, /uses: \.\/\.github\/actions\/setup-sccache\n/);
});

test("PostgreSQL tests share one Cargo invocation per feature graph", () => {
  const postgres = workflowJob(workflows["ci.yml"], "postgres");
  assert.equal(postgres.match(/cargo test/g)?.length, 2);
  for (const target of [
    "postgres_turn_state",
    "postgres_document_blob",
    "postgres_code_owner",
    "postgres_release_upgrade",
  ]) {
    assert.match(postgres, new RegExp(`--test ${target}`));
  }
  assert.match(
    postgres,
    /cargo test -p tidebreak-server --features postgres\n\s+--test postgres_store_ownership --locked\n\s+--test postgres_deployment_secrets/,
  );
});

test("UI tests and production build each gate the UI lane", () => {
  const ci = workflows["ci.yml"];
  const ui = workflowJob(ci, "ui");

  assert.match(ui, /if:.*needs\.changes\.outputs\.ui == 'true'/);
  assert.match(ui, /timeout-minutes: 20/);
  assert.match(ui, /corepack install --global pnpm@10\.18\.3/);
  assert.doesNotMatch(ui, /uses: pnpm\/action-setup/);
  assert.match(ui, /run: pnpm install --frozen-lockfile/);
  // Sequential steps, one command each: a backgrounded `a & b & wait` swallows
  // the children's exit codes, so a failing test or build reported success
  // (#1376). Each step's status must reach the job directly.
  assert.match(ui, /run: pnpm exec biome format src/);
  assert.match(ui, /run: pnpm lint/);
  assert.match(ui, /run: pnpm test/);
  assert.match(ui, /run: pnpm build/);
  // Only the Storybook build indexes and bundles the stories.
  assert.match(ui, /run: pnpm storybook:build/);
  assert.doesNotMatch(ui, /& wait/);
  assert.doesNotMatch(ci, /matrix\.task/);

  // The accessibility lane checks the stories it built from this commit.
  const a11y = workflowJob(ci, "storybook-a11y");
  const a11ySteps = [
    "run: pnpm install --frozen-lockfile",
    "run: pnpm storybook:build",
    "run: pnpm exec playwright-core install --only-shell chromium",
    "run: pnpm storybook:a11y",
  ].map((step) => a11y.indexOf(step));
  assert.ok(
    a11ySteps.every((at, index) => at !== -1 && (index === 0 || at > a11ySteps[index - 1])),
    "the accessibility lane must install, build Storybook, install Chromium, then check",
  );
  assert.doesNotMatch(a11y, /continue-on-error|\|\| true/);
});

test("the end-to-end lane drives the self-host build and keeps failed traces", () => {
  const ci = workflows["ci.yml"];
  const changes = workflowJob(ci, "changes");
  const build = workflowJob(ci, "self-host-build");
  const e2e = workflowJob(ci, "end-to-end");

  // The flows run for the server, the renderer, and their own files.
  assert.match(changes, /e2e\/\*\|scripts\/e2e\.sh\) e2e=true ;;/);
  assert.match(changes, /echo "e2e=true"/);
  assert.match(
    changes,
    /if \[\[ "\$workspace" == true \|\| "\$ui" == true \]\]; then\n\s+e2e=true/,
  );
  assert.match(e2e, /^ {4}name: end-to-end$/m);

  // A skipped check reads as success, so a failed build must fail this lane
  // rather than skip it: the lane runs under always() whenever its scope is
  // on, and its first step requires the build, the way `test` requires its
  // partitions.
  assert.match(
    e2e,
    /^ {4}if: \$\{\{ always\(\) && needs\.changes\.outputs\.e2e == 'true' \}\}$/m,
  );
  const firstStep = e2e.split(/^ {4}steps:\n/m)[1]?.split(/\n(?= {6}- )/)[0];
  assert.ok(firstStep, "the lane must have steps");
  assert.match(firstStep, /- name: Require the debug server build/);
  assert.match(
    firstStep,
    /BUILD_RESULT: \$\{\{ needs\.self-host-build\.result \}\}/,
  );
  assert.match(
    firstStep,
    /if \[\[ "\$BUILD_RESULT" != success \]\]; then[\s\S]*exit 1/,
  );
  assert.doesNotMatch(firstStep, /^ {8}if:/m);

  // One debug compile serves both lanes.
  assert.match(e2e, /needs: \[changes, self-host-build\]/);
  assert.match(build, /needs\.changes\.outputs\.e2e == 'true'/);
  assert.match(build, /path: target\/debug\/tidebreak/);
  assert.match(e2e, /TIDEBREAK_E2E_BINARY: \$\{\{ runner\.temp \}\}\/e2e-server\/tidebreak/);
  assert.doesNotMatch(e2e, /cargo build/);

  const upload = e2e.match(/- name: Upload Playwright traces[\s\S]*$/)?.[0];
  assert.ok(upload, "the lane must upload traces from failed flows");
  assert.match(upload, /if: \$\{\{ failure\(\) \}\}/);
  assert.match(upload, /path: e2e\/test-results/);
  // A job timeout cancels the job, and `failure()` is false then. The flows
  // step times out first, so a hung run fails the step and still uploads.
  const jobTimeout = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(e2e)?.[1]);
  const flows = e2e.match(/- name: Run the flows[\s\S]*?(?=\n {6}- )/)?.[0];
  const flowsTimeout = Number(/timeout-minutes: (\d+)/.exec(flows ?? "")?.[1]);
  assert.ok(
    flowsTimeout > 0 && flowsTimeout < jobTimeout,
    "the flows step must time out before the job does",
  );
  assert.doesNotMatch(e2e, /continue-on-error|\|\| true|secrets\./);
});

test("macOS CI lints and tests the desktop with the Linux desktop selection", () => {
  const ci = workflows["ci.yml"];
  const macos = workflowJob(ci, "macos-desktop");
  assert.match(macos, /runs-on: macos-latest/);
  assert.match(macos, /TIDEBREAK_DEV_SIGNING_IDENTITY: ""/);
  assert.match(
    macos,
    /run: cargo clippy -p tidebreak-desktop --all-targets --locked -- -D warnings/,
  );
  // One selection for both platforms, so a test the Linux lane gains cannot
  // silently skip macOS.
  const selection = (job) =>
    job.match(/cargo nextest run --locked -p tidebreak-desktop[\s\S]*?'\n/)?.[0];
  assert.ok(selection(macos), "the macOS lane must run the desktop tests under nextest");
  assert.equal(selection(macos), selection(workflowJob(ci, "desktop")));
  assert.doesNotMatch(macos, /continue-on-error|--ignored|\|\| true/);
});

test("the release policy lane rejects paths that differ only in case", () => {
  const policy = workflowJob(workflows["ci.yml"], "release-policy");
  assert.match(policy, /run: node scripts\/check-path-case\.mjs/);
});

test("macOS CI exercises Seatbelt and the egress broker without signing setup", () => {
  const sandbox = workflowJob(workflows["ci.yml"], "macos-sandbox");
  assert.match(sandbox, /runs-on: macos-latest/);
  assert.match(sandbox, /needs: changes/);
  assert.match(sandbox, /TIDEBREAK_DEV_SIGNING_IDENTITY: ""/);
  assert.match(sandbox, /test -x \/usr\/bin\/sandbox-exec/);
  assert.match(sandbox, /\/usr\/bin\/sandbox-exec -p/);
  assert.match(sandbox, /\/usr\/bin\/python3 -c/);
  // Admit v6 (main) and v7.0.0 (Dependabot #3448). This file is copied from
  // the base branch, so a pin bump cannot land until both comments match.
  assert.match(sandbox, /uses: actions\/setup-python@[a-f0-9]{40} # v(6|7\.0\.0)/);
  assert.match(sandbox, /python-version: "3\.12\.10"/);
  assert.match(sandbox, /python3 -I -c .*pip.*is_relative_to.*sys\.prefix/);
  for (const suite of ["local", "network", "sbpl"]) {
    assert.ok(
      sandbox.includes(`run: cargo test -p tidebreak-code-execution --locked --lib ${suite}::tests`),
      `macOS CI must run the ${suite} suite`,
    );
  }
  assert.doesNotMatch(sandbox, /continue-on-error|--ignored|\|\| true/);
});

test("compiler caches use the GitHub Actions cache, read-only for pull requests", () => {
  const ci = workflows["ci.yml"];
  const ciJobs = [
    "lint",
    "desktop",
    "windows-check",
    "macos-sandbox",
    "macos-desktop",
    "test",
    "postgres",
    "self-host-build",
  ];

  assert.match(compilerCacheAction, /read\) cache_mode=READ_ONLY/);
  assert.match(compilerCacheAction, /write\) cache_mode=READ_WRITE/);
  assert.match(compilerCacheAction, /SCCACHE_GHA_ENABLED=true/);
  assert.match(compilerCacheAction, /SCCACHE_GHA_RW_MODE=\$cache_mode/);
  assert.match(
    compilerCacheAction,
    /uses: mozilla-actions\/sccache-action@[0-9a-f]{40}/,
  );
  assert.doesNotMatch(
    compilerCacheAction,
    /SCCACHE_BUCKET|SCCACHE_S3_|configure-aws-credentials|role-to-assume|arn:aws/,
  );
  const steps = compilerCacheAction.split(/^    - name: /m).slice(1);
  const install = steps.find((entry) => entry.startsWith("Install sccache\n"));
  assert.ok(install, "every run must install sccache");
  assert.doesNotMatch(install, /^      if:/m);
  assert.ok(
    compilerCacheAction.indexOf("- name: Configure compiler cache environment") <
      compilerCacheAction.indexOf("- name: Install sccache"),
    "the cache settings must exist before the sccache server starts",
  );
  assert.equal(
    existsSync(repositoryFile(".github", "actions", "setup-sccache-s3")),
    false,
  );

  const accessMode =
    "access: ${{ github.event_name == 'pull_request' && 'read' || 'write' }}";
  for (const name of ciJobs) {
    const job = workflowJob(ci, name);
    assert.match(job, /permissions:\n      contents: read\n/);
    assert.doesNotMatch(job, /id-token: write/, `${name} needs no OIDC token`);
    assert.match(job, /uses: \.\/\.github\/actions\/setup-sccache\n/);
    assert.ok(job.includes(accessMode), `${name} must keep pull requests read-only`);
  }

  for (const [file, name] of [
    ["release.yml", "prepare_macos"],
    ["release.yml", "prepare_windows"],
    ["release.yml", "prepare_windows_desktop"],
    ["release.yml", "build_linux"],
  ]) {
    const job = workflowJob(workflows[file], name);
    assert.match(job, /permissions:\n      contents: read\n/);
    assert.doesNotMatch(job, /id-token: write/, `${name} needs no OIDC token`);
    assert.match(job, /uses: \.\/\.github\/actions\/setup-sccache\n/);
    assert.match(job, /access: write/);
  }

  assert.equal(workflows["cache-cleanup.yml"], undefined);
  for (const name of ["ci.yml", "release.yml"]) {
    assert.doesNotMatch(workflows[name], /SCCACHE_GHA_|SCCACHE_BUCKET/);
  }
});

test("production secrets remain isolated to the release workflow", () => {
  const secretConsumers = Object.entries(workflows)
    .filter(([, source]) => source.includes("secrets."))
    .map(([name]) => name);
  const allowedSecretConsumers = new Set([
    "build-mobile.yml",
    "publish-whisper-helper.yml",
    "release.yml",
  ]);
  for (const name of secretConsumers) {
    assert.ok(
      allowedSecretConsumers.has(name),
      `unexpected secret consumer: ${name}`,
    );
  }

  // Release drafting runs on the workflow's own GITHUB_TOKEN and reads no
  // secret, so a pull_request_target run of the label job has nothing to leak.
  const releaseDraftSource = workflows["release-draft.yml"];
  assert.doesNotMatch(
    releaseDraftSource,
    /secrets\.|create-github-app-token|RELEASE_APP_/,
    "release-draft.yml must stay on GITHUB_TOKEN",
  );
  const draftJob = workflowJob(releaseDraftSource, "draft");
  assert.match(draftJob, /permissions:\n      contents: write\n      pull-requests: read\n/);
  assert.match(draftJob, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.ok(secretConsumers.includes("release.yml"));

  const release = workflows["release.yml"];
  assert.doesNotMatch(release, /^  release:/m);
  assert.match(release, /^  workflow_dispatch:\n/m);
  assert.doesNotMatch(release, /^\s*pull_request(?:_target)?:/m);
  assert.match(release, /^permissions:\n  contents: read$/m);

  // The whisper helper publish is allowed the Tauri updater signing key,
  // and only because it can never run from a pull request: it is
  // manual-dispatch only, uses the desktop-production environment, and its
  // signed artifacts are verified by the desktop against the committed
  // updater public key before they can run. If the workflow doesn't exist
  // yet, these assertions are vacuously true.
  const whisper = workflows["publish-whisper-helper.yml"];
  if (whisper) {
    assert.match(whisper, /^on:\n  workflow_dispatch:\n/m);
    assert.doesNotMatch(whisper, /^\s*pull_request(?:_target)?:/m);
    assert.match(whisper, /^permissions:\n  contents: read$/m);
    assert.match(whisper, /cancel-in-progress: false/);
    assert.match(whisper, /environment:\n\s+name: desktop-production/);
    assert.deepEqual(
      [...new Set(whisper.match(/secrets\.[A-Z0-9_]+/g))].sort(),
      ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"]
        .map((name) => `secrets.${name}`),
    );
    const whisperPublish = workflowJob(whisper, "publish");
    assert.match(whisperPublish, /tauri signer sign "\$file"/);
    assert.doesNotMatch(whisperPublish, /cargo tauri signer sign/);
    // Each helper version is a prerelease on this repository, built from
    // main, so it never becomes the latest release the updater reads.
    assert.match(
      workflowJob(whisper, "version"),
      /if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/,
    );
    assert.match(whisperPublish, /permissions:\n      contents: write\n/);
    assert.match(
      whisperPublish,
      /HELPER_TAG: whisper-helper-v\$\{\{ needs\.version\.outputs\.version \}\}/,
    );
    assert.match(
      whisperPublish,
      /gh release create "\$HELPER_TAG" dist\/\* \\\n[\s\S]*?--prerelease\n/,
    );
    assert.doesNotMatch(whisperPublish, /--latest\b/);
    // The desktop trusts only the updater key, so a helper signed with any
    // other key must stop here rather than publish.
    assert.match(
      whisperPublish,
      /node scripts\/verify-updater-signatures\.mjs\n\s+--config crates\/tidebreak-desktop\/tauri\.conf\.json\n\s+dist\n/,
    );
    const helperVerifyAt = whisperPublish.indexOf("node scripts/verify-updater-signatures.mjs");
    assert.ok(
      whisperPublish.indexOf("tauri signer sign") < helperVerifyAt &&
        helperVerifyAt < whisperPublish.indexOf('gh release create "$HELPER_TAG"'),
      "helper signatures must verify after signing and before publication",
    );
  }

  // The mobile deploy needs a paid Expo account, so it runs only when someone
  // dispatches it, never from a pull request or a push, and it skips cleanly
  // when the repository has no Expo token.
  const mobile = workflows["build-mobile.yml"];
  assert.ok(mobile, "build-mobile.yml must stay available for manual builds");
  assert.match(mobile, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(
    mobile,
    /^ {2}(?:pull_request(?:_target)?|push|schedule):/m,
    "the mobile deploy must run only on workflow_dispatch",
  );
  assert.deepEqual(
    [...new Set(mobile.match(/secrets\.[A-Z0-9_]+/g))],
    ["secrets.EXPO_TOKEN"],
  );
  assert.match(mobile, /^permissions:\n  contents: read$/m);
  const expoGate = workflowJob(mobile, "expo");
  assert.match(expoGate, /echo "available=false" >> "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(expoGate, /exit 1/, "a missing token must skip, not fail");
  const mobileDeploy = workflowJob(mobile, "deploy");
  assert.match(mobileDeploy, /needs: expo\n/);
  assert.match(
    mobileDeploy,
    /if: \$\{\{ needs\.expo\.outputs\.available == 'true' \}\}/,
  );
  for (const name of ["Publish OTA", "Build binary and auto-submit"]) {
    const step = mobile.match(
      new RegExp(`- name: ${name}\\n[\\s\\S]*?(?=\\n\\s+- name:|$)`),
    )?.[0];
    assert.ok(step, `missing deploy step: ${name}`);
    assert.match(step, /!inputs\.dry_run/, `${name} must honour a dry run`);
  }
});

test("desktop voice delegates whisper.cpp to the verified helper", () => {
  assert.match(desktopHost, /^mod whisper_install;$/m);
  assert.match(
    desktopVoice,
    /crate::whisper_install::ensure_helper\(&self\.data_dir\)/,
  );
  assert.match(desktopVoice, /tokio::process::Command::new\(helper\)/);
  assert.doesNotMatch(desktopVoice, /\bWhisperContext\b|whisper_rs/);
  assert.doesNotMatch(desktopCargo, /^whisper-rs\s*=/m);
  assert.match(desktopCargo, /^minisign-verify\.workspace = true$/m);
  assert.match(
    desktopWhisperInstall,
    /sha256_hex_of_file\(&binary\).*marker\.binary_sha256/s,
  );
  // The desktop downloads the helper from the release the publish workflow
  // creates, and trusts the key that signs app updates.
  assert.match(
    desktopWhisperInstall,
    /"https:\/\/github\.com\/naingthet\/tidebreak\/releases\/download\/whisper-helper-v\{HELPER_VERSION\}\/tidebreak-whisper-\{triple\}\{extension\}"/,
  );
  assert.ok(
    desktopWhisperInstall.includes(
      `const HELPER_PUBKEY: &str = "${tauriConfig.plugins.updater.pubkey}";`,
    ),
    "the helper must trust the updater's public key",
  );

  const releaseWindows = workflowJob(workflows["release.yml"], "build_windows");
  assert.doesNotMatch(releaseWindows, /Use clang-cl for Windows ARM native code/);
  assert.doesNotMatch(releaseWindows, /CMAKE_GENERATOR=Ninja/);

  const helperBuild = workflowJob(
    workflows["publish-whisper-helper.yml"],
    "build",
  );
  assert.match(helperBuild, /Use clang-cl for Windows ARM native code/);
  assert.match(helperBuild, /CMAKE_GENERATOR=Ninja/);
});

test("dependency policy covers advisories, licenses, sources, and the locked graph", () => {
  const advisories = workflowJob(workflows["ci.yml"], "advisories");
  assert.match(denyConfig, /^\[advisories\]$/m);
  assert.match(denyConfig, /^\[licenses\]$/m);
  assert.match(denyConfig, /^\[sources\]$/m);
  assert.match(
    advisories,
    /cargo deny --all-features --locked check advisories licenses sources/,
  );
});

test(
  "every workspace crate opts out of crates.io publication in its own manifest",
  // Mutation fixtures copy policy files, not the Cargo workspace.
  { skip: !existsSync(repositoryFile("Cargo.toml")) },
  () => {
    const metadata = JSON.parse(
      execFileSync(
        "cargo",
        ["metadata", "--format-version", "1", "--no-deps"],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
    );
    const workspaceMembers = new Set(metadata.workspace_members);
    const missing = metadata.packages
      .filter((pkg) => workspaceMembers.has(pkg.id))
      .filter((pkg) => {
        const manifest = readFileSync(pkg.manifest_path, "utf8");
        const packageStart = manifest.indexOf("[package]");
        if (packageStart === -1) return true;
        const sectionEnd = manifest.indexOf("\n[", packageStart + 1);
        const packageSection = manifest.slice(
          packageStart + "[package]".length,
          sectionEnd === -1 ? undefined : sectionEnd,
        );
        return !/^publish\s*=\s*false\s*$/m.test(packageSection);
      })
      .map((pkg) => pkg.manifest_path);

    assert.deepEqual(
      missing,
      [],
      "every workspace crate must set publish = false in its own [package] section",
    );
  },
);

test("the self-host Docker context is allowlisted and denies hidden credentials", () => {
  assert.match(dockerIgnore, /^\*\*$/m);
  assert.doesNotMatch(dockerIgnore, /^!crates\/\*\*$/m);
  assert.doesNotMatch(dockerIgnore, /^!skills\/\*\*$/m);
  assert.doesNotMatch(dockerIgnore, /^!plugins\/\*\*$/m);

  for (const required of [
    "!Cargo.toml",
    "!Cargo.lock",
    "!rust-toolchain.toml",
    "!crates/*/Cargo.toml",
    "!crates/*/build.rs",
    "!crates/*/src/**",
    "!crates/tidebreak-code-execution/baseline_python_deps.txt",
    "!crates/tidebreak-sandbox-agent/documents-requirements.txt",
    "!skills/*/SKILL.md",
    "!plugins/*/PLUGIN.md",
    "!crates/*/src/**/*.rs",
    // Crates named by `[patch.crates-io]` resolve by path; a missing manifest
    // fails the build before it compiles a line (v0.87.1's image did).
    "!vendor/*/Cargo.toml",
    "!vendor/*/src/**",
    "!vendor/*/src/**/*.rs",
  ]) {
    assert.ok(dockerIgnore.includes(`${required}\n`), `missing allow rule ${required}`);
  }

  for (const denied of [
    "**/.npmrc",
    "**/.netrc",
    "**/.pypirc",
    "**/.cargo/credentials",
    "**/.cargo/credentials.toml",
    "**/id_*",
    "**/credentials",
    "**/credentials.*",
    "**/.*",
    "**/.*/**",
  ]) {
    assert.ok(dockerIgnore.includes(`${denied}\n`), `missing deny rule ${denied}`);
  }
  assert.match(
    readFileSync(repositoryFile("scripts", "stage-self-host-build-context.sh"), "utf8"),
    /git -C "\$root" archive --format=tar "\$revision" \| tar -x -C "\$destination"/,
  );
});

test("the self-host runtime installs packages from an immutable Debian snapshot", () => {
  assert.match(
    selfHostDockerfile,
    /snapshot\.debian\.org\/archive\/debian\/[0-9]{8}T[0-9]{6}Z/,
  );
  assert.match(
    selfHostDockerfile,
    /snapshot\.debian\.org\/archive\/debian-security\/[0-9]{8}T[0-9]{6}Z/,
  );
  assert.match(selfHostDockerfile, /ca-certificates=[^\s\\]+/);
  assert.match(selfHostDockerfile, /curl=[^\s\\]+/);
  assert.doesNotMatch(
    selfHostDockerfile,
    /apt-get install -y --no-install-recommends ca-certificates curl/,
  );
});

test("the published server image states the release it carries", () => {
  // The workspace manifest stays at 0.0.0, so the release tag reaches the
  // binary only through this build argument. Without it `--version` answers
  // "0.0.0-unreleased" and the smoke test below catches the mismatch.
  assert.match(selfHostDockerfile, /^ARG TIDEBREAK_VERSION="0\.0\.0-unreleased"$/m);

  const buildJob = workflowJob(workflows["publish-server-image.yml"], "build");
  assert.match(buildJob, /--build-arg "TIDEBREAK_VERSION=\$VERSION"/);

  // Asserting the reported string, not just a zero exit. The smoke test that
  // shipped ran `--version` against a binary with no such flag; it would have
  // failed on any build, and did on the first one that compiled.
  assert.match(buildJob, /\[\[ "\$reported" = "tidebreak \$VERSION" \]\]/);
});

test(
  "BuildKit admits only exact source inputs from allowed source paths",
  { skip: process.env.TIDEBREAK_SKIP_DOCKER_CONTEXT_PROBE === "1" },
  () => {
    const context = mkdtempSync(join(tmpdir(), "tidebreak-docker-context-"));
    const output = mkdtempSync(join(tmpdir(), "tidebreak-docker-output-"));
    const write = (path, contents = "probe\n") => {
      const target = join(context, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    };

    const included = [
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
      "crates/demo/Cargo.toml",
      "crates/demo/build.rs",
      "crates/demo/src/lib.rs",
      // A source module named like a credential file must survive the deny
      // block: tidebreak-server has src/web_search/credentials.rs for real.
      "crates/demo/src/web/credentials.rs",
      "crates/tidebreak-code-execution/baseline_python_deps.txt",
      "crates/tidebreak-sandbox-agent/documents-requirements.txt",
      "skills/demo/SKILL.md",
      "plugins/demo/PLUGIN.md",
      // A vendored crate the workspace patches in by path: its manifest and
      // sources, like any workspace member.
      "vendor/demo/Cargo.toml",
      "vendor/demo/build.rs",
      "vendor/demo/src/lib.rs",
      "vendor/demo/src/web/credentials.rs",
      // The renderer the image builds: manifests, the page, and sources.
      "crates/tidebreak-desktop/ui/package.json",
      "crates/tidebreak-desktop/ui/pnpm-lock.yaml",
      "crates/tidebreak-desktop/ui/index.html",
      "crates/tidebreak-desktop/ui/public/favicon.svg",
      "crates/tidebreak-desktop/ui/src/main.tsx",
    ];
    const excluded = [
      // Never a dependency tree, a stale bundle, or the hidden config
      // beside the renderer sources.
      "crates/tidebreak-desktop/ui/node_modules/vite/index.js",
      "crates/tidebreak-desktop/ui/dist/index.html",
      "crates/tidebreak-desktop/ui/.npmrc",
      "crates/tidebreak-desktop/ui/.storybook/main.ts",
      "crates/demo/.npmrc",
      "crates/demo/src/.netrc",
      "crates/demo/src/deep/.pypirc",
      "crates/demo/src/id_rsa",
      "crates/demo/src/deep/id_ed25519",
      "crates/demo/src/.cargo/credentials",
      "crates/demo/src/.cargo/credentials.toml",
      "crates/demo/src/deep/.harmless-hidden-file",
      "skills/demo/.draft",
      "plugins/demo/credentials.json",
      "crates/demo/src/credentials.json",
      // Hidden files beside a vendored crate stay denied, as under crates/.
      "vendor/demo/.cargo/credentials",
      "vendor/demo/src/.netrc",
      "outside/secret.txt",
    ];

    try {
      for (const path of [...included, ...excluded]) {
        write(path);
      }
      writeFileSync(
        join(context, "Dockerfile"),
        "FROM scratch\nCOPY . /context\n",
      );
      writeFileSync(join(context, "Dockerfile.dockerignore"), dockerIgnore);

      execFileSync(
        "docker",
        [
          "buildx",
          "build",
          "--file",
          join(context, "Dockerfile"),
          "--output",
          `type=local,dest=${output}`,
          context,
        ],
        { stdio: "pipe" },
      );

      for (const path of included) {
        assert.ok(existsSync(join(output, "context", path)), `missing ${path}`);
      }
      for (const path of excluded) {
        assert.ok(
          !existsSync(join(output, "context", path)),
          `credential probe escaped the context: ${path}`,
        );
      }
    } finally {
      rmSync(context, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

test(
  "the self-host build context excludes arbitrary untracked source files",
  { skip: process.env.TIDEBREAK_SKIP_DOCKER_CONTEXT_PROBE === "1" },
  () => {
    const context = mkdtempSync(join(tmpdir(), "tidebreak-self-host-context-"));
    const output = mkdtempSync(join(tmpdir(), "tidebreak-self-host-output-"));
    const probe = repositoryFile("crates", "cloud-token.txt");
    try {
      writeFileSync(probe, "untracked probe\n");
      execFileSync("bash", [repositoryFile("scripts", "stage-self-host-build-context.sh"), context]);
      writeFileSync(join(context, "Probe.Dockerfile"), "FROM scratch\nCOPY . /context\n");
      execFileSync(
        "docker",
        ["buildx", "build", "--file", join(context, "Probe.Dockerfile"), "--output", `type=local,dest=${output}`, context],
        { stdio: "pipe" },
      );
      assert.ok(existsSync(join(output, "context", "Cargo.toml")));
      assert.ok(!existsSync(join(output, "context", "crates", "cloud-token.txt")));
    } finally {
      rmSync(probe, { force: true });
      rmSync(context, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  },
);

function sandboxPublishControls(publish) {
  const resolve = workflowJob(publish, "resolve");
  const build = workflowJob(publish, "build");
  const dockerIgnorePath = repositoryFile(
    "crates",
    "tidebreak-sandbox-agent",
    "Dockerfile.dockerignore",
  );
  return {
    resolve,
    build,
    dockerIgnorePath,
    hasDefaultBranchEnv:
      /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/.test(
        resolve,
      ),
    hasDefaultBranchRefGate:
      /SOURCE_REF" == "refs\/heads\/\$DEFAULT_BRANCH" &&\n\s+"\$SOURCE_REF_NAME" == "\$DEFAULT_BRANCH"/.test(
        resolve,
      ),
    hasAncestorGate:
      /git merge-base --is-ancestor "\$(?:GITHUB_SHA|SOURCE_SHA)" "origin\/\$DEFAULT_BRANCH"/.test(
        resolve,
      ),
    hasPersistCredentialsFalse: /persist-credentials:\s*false/.test(build),
    hasDockerIgnore: existsSync(dockerIgnorePath),
  };
}

function sandboxPublishTrigger(publish) {
  return {
    tagPush: /^on:\n  push:\n    tags: \["v\*"\]\n    branches: \[main\]\n  schedule:/m.test(
      publish,
    ),
    publishedRelease:
      /^on:\n  release:\n    types: \[published\]\n  push:\n    branches: \[main\]\n  schedule:/m.test(
        publish,
      ),
  };
}

function assertSandboxPublishReleaseEvent(publish) {
  const resolve = workflowJob(publish, "resolve");
  assert.match(
    publish,
    /^on:\n  release:\n    types: \[published\]\n  push:\n    branches: \[main\]\n  schedule:/m,
  );
  assert.match(resolve, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(resolve, /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(resolve, /github\.event\.release|RELEASE_TAG/);
  assert.match(resolve, /prerelease/);
  assert.doesNotMatch(publish, /^\s*tags: \["v\*"\]/m);
}

function assertSandboxPublishMainOnly(controls) {
  assert.ok(
    controls.hasDefaultBranchEnv,
    "resolve must identify the repository default branch",
  );
  assert.ok(
    controls.hasDefaultBranchRefGate,
    "dispatch and schedule must require the default-branch workflow",
  );
  assert.match(
    controls.resolve,
    /workflow_dispatch\|schedule|schedule\|workflow_dispatch/,
  );
  assert.ok(
    controls.hasAncestorGate,
    "tag and dispatch must refuse SHAs not contained in the default branch",
  );
  assert.ok(
    controls.hasPersistCredentialsFalse,
    "build checkout must not persist GITHUB_TOKEN into .git/config",
  );
  assert.ok(
    controls.hasDockerIgnore,
    "sandbox image build must ship a Dockerfile.dockerignore",
  );
  const dockerIgnore = readFileSync(controls.dockerIgnorePath, "utf8");
  assert.match(dockerIgnore, /^\.git$/m);
  assert.match(dockerIgnore, /^\.git\/\*\*$/m);
}

test("sandbox image publishing is tag-driven, immutable, and secret-free", () => {
  const publish = workflows["publish-sandbox-image.yml"];
  assert.ok(publish);

  // A published GitHub Release runs this file from the default branch.
  // A `v*` tag push would run the tagged commit's YAML instead, so it is
  // not a trigger.
  assert.ok(sandboxPublishTrigger(publish).publishedRelease);
  assert.ok(!sandboxPublishTrigger(publish).tagPush);
  assertSandboxPublishReleaseEvent(publish);
  assert.match(publish, /cron: "43 4 \* \* 4"/);
  assert.match(publish, /^  workflow_dispatch:/m);
  assert.doesNotMatch(publish, /^\s*pull_request(?:_target)?:/m);

  // Dispatch/schedule must run the default-branch workflow. Every publish,
  // tag included, refuses a SHA that is not an ancestor of that branch.
  // The build checkout must not persist GITHUB_TOKEN, and `.git` stays out
  // of the Docker context.
  assertSandboxPublishMainOnly(sandboxPublishControls(publish));

  // A main push publishes only when the image inputs changed; the scope lives
  // in the resolve job (an `on.push.paths` filter would also gate the tag
  // trigger).
  const resolve = workflowJob(publish, "resolve");
  assert.match(
    resolve,
    /crates\/tidebreak-sandbox-agent\/\*\|scripts\/exec-documents\/\*\|\.github\/workflows\/publish-sandbox-image\.yml/,
  );

  // Non-release rebuilds mint tags that can never collide with a release tag
  // (they never start with `v`) and are unique per run; both schemes are
  // validated before anything builds.
  assert.match(resolve, /main-\$\(date -u \+%Y%m%d\)-\$\{GITHUB_SHA:0:7\}-r\$\{GITHUB_RUN_NUMBER\}/);
  assert.match(resolve, /\^main-\[0-9\]\{8\}-\[0-9a-f\]\{7\}-r\[0-9\]\+\$/);
  assert.match(resolve, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+/);

  // The default token with packages:write is the whole credential surface —
  // publishing must not grow a dependency on repository secrets (that set
  // stays isolated to release.yml by the production-secrets test above).
  // Only the jobs that push (build) or assemble the version tag (manifest)
  // may hold packages:write; the scanner is packages:read.
  assert.match(publish, /^permissions:\n  contents: read$/m);
  assert.equal(publish.match(/packages: write/g)?.length, 2);
  assert.match(
    workflowJob(publish, "build"),
    /^    permissions:\n      contents: read\n      packages: write$/m,
  );
  assert.match(
    workflowJob(publish, "manifest"),
    /^    permissions:\n      contents: read\n      packages: write$/m,
  );
  assert.doesNotMatch(publish, /secrets\./);

  // Version tags are immutable: both the per-arch build job and the manifest
  // job refuse a tag that already exists instead of repointing it.
  const overwriteGuards = publish.match(
    /Refusing to overwrite existing image tag/g,
  );
  assert.equal(overwriteGuards?.length, 2);
  assert.match(publish, /docker manifest inspect "\$repository:\$IMAGE_TAG"/);

  // Published refs stay under this owner's Tidebreak GHCR namespace, and the
  // digest the local backend pins is surfaced by the run itself.
  assert.match(
    publish,
    /ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/tidebreak-sandbox-agent$/m,
  );
  assert.match(
    publish,
    /ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/tidebreak-sandbox-agent-documents$/m,
  );
  assert.match(publish, /PUBLISHED_IMAGE_DIGEST/);

  // The pin job rewrites source files by path. A moved file makes the job
  // die with FileNotFoundError before it proposes anything (PR #3172 moved
  // the digest pin and nothing noticed for five weeks), so every path the
  // job names must exist and carry the constant it looks for.
  const pinTargets = new Map([
    [
      /^\s*path = "([^"]+)"$/m,
      /const PUBLISHED_IMAGE_DIGEST: Option<&str> =/,
    ],
    [
      /"(crates\/tidebreak-code-execution\/src\/sandbox_image\.rs)": \{/,
      /const DOCUMENTS_IMAGE: &str = "/,
    ],
    [
      /"(crates\/tidebreak-code-execution\/src\/daytona\.rs)": \{/,
      /const DOCUMENTS_SNAPSHOT: &str = "/,
    ],
  ]);
  for (const [locator, marker] of pinTargets) {
    const found = publish.match(locator);
    assert.ok(found, `pin job names a target for ${locator}`);
    const target = join(repositoryRoot, found[1]);
    assert.ok(existsSync(target), `pin target exists: ${found[1]}`);
    assert.match(
      readFileSync(target, "utf8"),
      marker,
      `pin target ${found[1]} carries its pinned constant`,
    );
  }
});

test("sandbox images are scanned in a read-only job before the version tag is published, and the pin loop never touches main", () => {
  const publish = workflows["publish-sandbox-image.yml"];
  const build = workflowJob(publish, "build");
  const scan = workflowJob(publish, "scan");
  const manifest = workflowJob(publish, "manifest");
  const pin = workflowJob(publish, "pin");

  // The scanner is a checksum-pinned binary release, not a third-party
  // action, and it is the only job that runs trivy. It cannot publish:
  // packages:read, no checkout (so no persisted git credentials), and the
  // version-tag job waits for it.
  assert.doesNotMatch(build, /trivy/i);
  assert.doesNotMatch(manifest, /trivy/i);
  assert.match(scan, /trivy_\$\{TRIVY_VERSION\}_\$\{asset\}\.tar\.gz/);
  assert.match(scan, /sha256sum --check/);
  assert.match(publish, /^  TRIVY_VERSION: \d+\.\d+\.\d+$/m);
  assert.match(scan, /^    permissions:\n      contents: read\n      packages: read$/m);
  assert.doesNotMatch(scan, /packages: write/);
  assert.doesNotMatch(scan, /actions\/checkout/);
  assert.doesNotMatch(scan, /secrets\./);
  assert.match(manifest, /needs: \[resolve, build, scan\]/);

  // Policy: the run summary carries the full all-severities report, but the
  // publish fails only on fixable CRITICAL vulnerabilities or any secret. A
  // broader gate would drown in LibreOffice CVE noise and be ignored.
  assert.match(
    scan,
    /trivy image --timeout 15m --scanners vuln,secret \\\n\s+--format table --output "\$report" "\$image"/,
  );
  assert.match(
    scan,
    /trivy image --timeout 15m --scanners vuln \\\n\s+--severity CRITICAL --ignore-unfixed --exit-code 1 "\$image"/,
  );
  assert.match(
    scan,
    /trivy image --timeout 15m --scanners secret --exit-code 1 "\$image"/,
  );

  // The pin job proposes a PR from its automation branch with the workflow's
  // own token; it must never push to main, and the write scopes stay confined
  // to that job.
  assert.match(pin, /PIN_BRANCH: automation\/sandbox-image-pin/);
  assert.match(pin, /git push --force origin "HEAD:refs\/heads\/\$PIN_BRANCH"/);
  assert.doesNotMatch(pin, /git push[^\n]*(?:origin main|HEAD:main|refs\/heads\/main)/);
  assert.match(pin, /^    permissions:\n      contents: write\n      pull-requests: write\n      packages: read$/m);
  assert.equal(publish.match(/contents: write/g)?.length, 1);
});

test("release builds freeze a draft tag from the trusted main workflow", () => {
  const release = workflows["release.yml"];
  const validateJob = workflowJob(release, "validate");
  assert.doesNotMatch(release, /^  release:/m);
  assert.match(release, /^  workflow_dispatch:\n/m);
  assert.match(validateJob, /github\.ref == 'refs\/heads\/main'/);
  assert.match(validateJob, /permissions:\n      contents: write/);
  assert.match(validateJob, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(
    release,
    /^      release_tag:\n(?:        .*\n)+?        required: false$/m,
  );
  assert.match(
    validateJob,
    /Expected exactly one draft GitHub Release when release_tag is omitted/,
  );
  assert.match(validateJob, /\.draft == true and \.prerelease == false/);
  assert.match(validateJob, /node scripts\/check-release-tag\.mjs "\$RELEASE_TAG"/);
  assert.match(
    validateJob,
    /repos\/\$GITHUB_REPOSITORY\/releases\?per_page=100/,
  );
  assert.match(validateJob, /select\(\.tag_name == \$tag\)/);
  assert.match(validateJob, /refs\/tags\/\$RELEASE_TAG/);
  assert.match(validateJob, /repos\/\$GITHUB_REPOSITORY\/git\/refs/);
  assert.match(validateJob, /git merge-base --is-ancestor "\$RELEASE_SHA" origin\/main/);
  assert.match(validateJob, /release-snapshot\.json/);
  assert.match(validateJob, /Mark the in-flight draft as a prerelease/);
  assert.match(
    validateJob,
    /\{draft: true, prerelease: true\}/,
  );
  assert.match(
    validateJob,
    /jq -e '\.draft == true and \.prerelease == true' <<<"\$release_json" >\/dev\/null \|\| \{\n[\s\S]*?Failed to keep release \$RELEASE_ID as a draft after marking it in-flight[\s\S]*?exit 1/,
  );
  assert.match(validateJob, /RELEASE_TAG: \$\{\{ steps\.release\.outputs\.tag \}\}/);
  assert.match(validateJob, /\{tag_name: \$tag, target_commitish: \$target\}/);
  assert.match(
    validateJob,
    /'\.tag_name == \$tag and \.target_commitish == \$target'[\s\S]*?GitHub changed the frozen identity[\s\S]*?exit 1/,
  );
  assert.doesNotMatch(
    release,
    /(?:-f|--raw-field)\s+(?:draft|prerelease)=(?:true|false)/,
  );
  assert.match(release, /ref: \$\{\{ needs\.validate\.outputs\.sha \}\}/);
});

test("documentation publishes to GitHub Pages from main", () => {
  const docs = workflows["docs.yml"];
  assert.ok(docs, "docs.yml must publish the documentation");
  assert.match(
    docs,
    /^on:\n  push:\n    branches: \[main\]\n    paths:\n      - "docs-site\/\*\*"\n      - "\.github\/workflows\/docs\.yml"\n  workflow_dispatch:\n/m,
  );
  assert.doesNotMatch(docs, /^\s*pull_request(?:_target)?:/m);
  assert.match(docs, /^permissions:\n  contents: read$/m);
  assert.match(docs, /cancel-in-progress: false/);
  assert.doesNotMatch(docs, /secrets\./);

  const build = workflowJob(docs, "build");
  const deploy = workflowJob(docs, "deploy");
  assert.match(build, /if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/);
  assert.match(build, /permissions:\n      contents: read\n/);
  assert.doesNotMatch(build, /id-token|pages: write/);
  // Pages serves the repository under /tidebreak/, and the docs one level down.
  assert.match(build, /BASE_PATH: \/tidebreak\/docs\n/);
  assert.match(build, /persist-credentials: false/);
  assert.match(build, /pnpm --dir docs-site install --frozen-lockfile/);
  for (const command of ["build", "lint", "types:check"]) {
    assert.ok(
      build.includes(`pnpm --dir docs-site ${command}\n`),
      `the docs build must run ${command}`,
    );
  }
  assert.match(build, /grep -Fq '\/tidebreak\/docs\/_next\/' docs-site\/out\/index\.html/);
  assert.match(
    build,
    /grep -Fq 'https:\/\/naingthet\.github\.io\/tidebreak\/docs\/' docs-site\/out\/index\.html/,
  );
  assert.match(build, /cp -R docs-site\/out\/\. _site\/docs\//);
  assert.match(
    build,
    /uses: actions\/upload-pages-artifact@[0-9a-f]{40} # v5\.0\.0\n\s+with:\n\s+path: _site\n/,
  );
  assert.match(deploy, /needs: build\n/);
  assert.match(deploy, /permissions:\n      id-token: write\n      pages: write\n/);
  assert.match(deploy, /environment:\n      name: github-pages\n/);
  assert.match(deploy, /uses: actions\/deploy-pages@[0-9a-f]{40} # v5\.0\.1/);
  assert.doesNotMatch(deploy, /actions\/checkout/);

  // The site is a static export that honours BASE_PATH, and the release no
  // longer builds or deploys it.
  const nextConfig = readFileSync(
    repositoryFile("docs-site", "next.config.mjs"),
    "utf8",
  );
  assert.match(nextConfig, /output: 'export'/);
  assert.match(nextConfig, /basePath: process\.env\.BASE_PATH/);
  assert.equal(Object.hasOwn(docsPackage.scripts ?? {}, "package:vercel"), false);
  assert.equal(workflows["release.yml"].includes("docs-site"), false);
});

test("release compilation uses no cache warmer workflows", () => {
  for (const name of ["cache-macos.yml", "cache-windows.yml", "cache-linux.yml"]) {
    assert.equal(workflows[name], undefined);
  }

  const release = workflows["release.yml"];
  assert.doesNotMatch(release, /cache_warm_only/);
  assert.doesNotMatch(release, /^  warm-macos-cache:/m);

  const prepareMacos = workflowJob(release, "prepare_macos");
  const prepareWindowsSidecars = workflowJob(release, "prepare_windows");
  const prepareWindowsDesktop = workflowJob(
    release,
    "prepare_windows_desktop",
  );
  const buildWindows = workflowJob(release, "build_windows");
  const buildLinux = workflowJob(release, "build_linux");
  assert.doesNotMatch(prepareMacos, /restore-keys:/);
  assert.doesNotMatch(prepareWindowsSidecars, /restore-keys:/);
  assert.doesNotMatch(prepareWindowsDesktop, /restore-keys:/);
  assert.doesNotMatch(prepareWindowsSidecars, /windows-release-target-v1-/);
  assert.doesNotMatch(prepareWindowsDesktop, /windows-release-target-v1-/);
  assert.doesNotMatch(buildLinux, /actions\/cache\/restore@/);
  assert.doesNotMatch(buildLinux, /linux-release-target-v1-/);
  for (const job of [prepareWindowsSidecars, prepareWindowsDesktop, buildWindows]) {
    assert.match(
      job,
      /target: x86_64-pc-windows-msvc\n\s+runner: windows-latest\n/,
    );
  }
  assert.match(
    buildWindows,
    /needs: \[validate, notices, prepare_windows, prepare_windows_desktop\]/,
  );
  assert.match(prepareWindowsSidecars, /prepare-sidecar\.mjs --release/);
  assert.match(
    prepareWindowsDesktop,
    /beforeBuildCommand: \{ script: "pnpm build", cwd: "ui" \}/,
  );
  assert.match(prepareWindowsDesktop, /Stage inert sidecars for desktop compilation/);
  assert.match(buildWindows, /tidebreak-prepared-windows-sidecars-/);
  assert.match(buildWindows, /tidebreak-prepared-windows-desktop-/);
  assert.match(buildWindows, /Prepared Windows sidecar archive contains an unexpected file set/);
  assert.match(buildWindows, /Prepared Windows desktop archive contains an unexpected file set/);
  assert.match(prepareWindowsDesktop, /corepack install --global pnpm@10\.18\.3/);
  assert.doesNotMatch(prepareWindowsDesktop, /uses: pnpm\/action-setup/);

  for (const workflow of [release]) {
    const downloadCaches = [
      ...workflow.matchAll(
        /- name: Cache Cargo downloads[\s\S]*?(?=\n\s+- (?:name:|uses:))/g,
      ),
    ].map((match) => match[0]);
    assert.ok(downloadCaches.length > 0);
    for (const step of downloadCaches) {
      assert.match(
        step,
        /shared-key: (?:macos-release-cargo-registry-v2|windows-release-cargo-registry-v1|linux-release-cargo-registry-v1)-\$\{\{ hashFiles\('Cargo\.lock'\) \}\}/,
      );
      assert.match(step, /add-rust-environment-hash-key: "false"/);
      assert.match(step, /cache-targets: false/);
    }
  }
});


// ---------------------------------------------------------------------------
// Release-pipeline invariant tests.
//
// These tests assert security invariants (credential isolation, ordering,
// cache hygiene) rather than exact step names or shell snippets, so a
// workflow refactor that renames a step or rewords a script does not break
// them — as long as the invariant holds.
// ---------------------------------------------------------------------------

// Helper: every `- name:` label in a job, in order.
function stepNames(job) {
  return [...job.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1]);
}

test("credential-free compile jobs never load production secrets", () => {
  const release = workflows["release.yml"];
  for (const jobName of [
    "prepare_macos",
    "combine_macos",
    "prepare_windows",
    "prepare_windows_desktop",
  ]) {
    const job = workflowJob(release, jobName);
    assert.doesNotMatch(job, /^    environment:/m);
    assert.doesNotMatch(job, /secrets\./);
    assert.doesNotMatch(job, /APPLE_|TAURI_SIGNING|AWS_|DOWNLOADS_/);
  }
  // The credential-free compile must save its cache before reporting a
  // failed compile, so partial work is reusable.
  for (const jobName of [
    "prepare_macos",
    "prepare_windows",
    "prepare_windows_desktop",
  ]) {
    const job = workflowJob(release, jobName);
    const names = stepNames(job);
    const saveIdx = names.findIndex((n) => /Save.*cache/i.test(n));
    const failIdx = names.findIndex((n) => /Require.*successful.*compilation/i.test(n));
    assert.ok(saveIdx !== -1, `${jobName} must have a cache-save step`);
    assert.ok(failIdx !== -1, `${jobName} must have a compile-failure step`);
    assert.ok(saveIdx < failIdx, `${jobName} must save cache before reporting failure`);
  }
});

test("credentialed packaging jobs restore caches before loading secrets", () => {
  const release = workflows["release.yml"];
  for (const { name, validate } of [
    { name: "build_macos", validate: "Validate production signing configuration" },
    { name: "build_windows", validate: "Validate updater signing configuration" },
  ]) {
    const job = workflowJob(release, name);
    assertCachesRestoreBeforeSigningMaterial(job, name, validate);
    // Credentialed jobs must never save a cache.
    assert.doesNotMatch(job, /actions\/cache\/save/);
  }
});

test("credentialed packaging policy rejects cache restores after signing material", () => {
  const release = workflows["release.yml"];
  const name = "build_macos";
  const validate = "Validate production signing configuration";
  const job = `${workflowJob(release, name)}\n    - name: Restore unsigned Rust build cache\n      run: echo unsafe\n`;
  assert.throws(
    () => assertCachesRestoreBeforeSigningMaterial(job, name, validate),
    /must restore Restore unsigned Rust build cache before loading secrets/,
  );
});

test("the updater private key is isolated from compilation", () => {
  const release = workflows["release.yml"];
  for (const jobName of [
    "prepare_macos",
    "prepare_windows",
    "prepare_windows_desktop",
  ]) {
    assert.doesNotMatch(
      workflowJob(release, jobName),
      /TAURI_SIGNING_PRIVATE_KEY/,
    );
  }
  // The bundle/sign step in the macOS production job must not reference it.
  const buildMac = workflowJob(release, "build_macos");
  const names = stepNames(buildMac);
  const bundleIdx = names.findIndex((n) => /bundle|sign/i.test(n) && !/notar/i.test(n));
  const signIdx = names.findIndex((n) => /signing configuration/i.test(n));
  if (bundleIdx !== -1 && signIdx !== -1) {
    const step = buildMac.match(
      new RegExp(`- name: ${names[bundleIdx]}[\\s\\S]*?(?=\\n\\s+- name:)`),
    )?.[0];
    if (step) {
      assert.doesNotMatch(step, /TAURI_SIGNING_PRIVATE_KEY/);
    }
  }
  assert.match(release, /tauri signer sign "\$updater_path"/);
  assert.doesNotMatch(release, /cargo tauri signer sign/);
  assert.doesNotMatch(release, /createUpdaterArtifacts/);
});

test("signing jobs run installers before loading signing material", () => {
  for (const { file, name, job, validate } of desktopSigningJobs()) {
    const label = `${name} (${file})`;
    const secretsAt = firstSigningMaterialIndex(job, validate);
    assert.notEqual(secretsAt, -1, `${label} must still load signing material`);
    const pnpmAt = job.search(
      /pnpm\/action-setup@[0-9a-f]{40}|- name: Enable pinned pnpm/,
    );
    const nodeAt = job.search(/actions\/setup-node@[0-9a-f]{40}/);
    assert.ok(pnpmAt !== -1, `${label} must set up pnpm`);
    assert.ok(nodeAt !== -1, `${label} must set up Node`);
    assert.ok(pnpmAt < secretsAt, `${label} must set up pnpm before signing material`);
    assert.ok(nodeAt < secretsAt, `${label} must set up Node before signing material`);
    // The actual install command (not just the setup) must also come before
    // signing material — a moved install step is a supply-chain risk.
    const installAt = job.search(
      /pnpm(?: --dir \.github\/tauri-cli)? install --frozen-lockfile --ignore-scripts/,
    );
    assert.ok(installAt !== -1, `${label} must have a frozen-lockfile install step`);
    assert.ok(installAt < secretsAt, `${label} must install dependencies before signing material`);
    // pnpm must be pinned to an exact version, not floating.
    assert.match(
      job,
      /version: 10\.18\.3\n|corepack install --global pnpm@10\.18\.3/,
      `${label} must pin pnpm 10.18.3`,
    );
    // Installs must be frozen-lockfile with lifecycle scripts disabled.
    assert.match(
      job,
      /pnpm(?: --dir \.github\/tauri-cli)? install --frozen-lockfile --ignore-scripts/,
      `${label} must install with --frozen-lockfile --ignore-scripts`,
    );
    if (/Install pinned Tauri bundler/.test(job)) {
      assert.doesNotMatch(job, /mozilla-actions\/sccache-action/);
      assert.doesNotMatch(job, /Swatinem\/rust-cache/);
    } else {
      const rustCache = cargoDownloadCache(job);
      assert.ok(rustCache, `${label} missing Cargo download cache`);
      assert.match(rustCache, /save-if: false/);
    }
  }
});

test("prepared binaries are checksum-verified before signing material loads", () => {
  const release = workflows["release.yml"];
  for (const { name, validate } of [
    { name: "build_macos", validate: "Validate production signing configuration" },
    { name: "build_windows", validate: "Validate updater signing configuration" },
  ]) {
    const job = workflowJob(release, name);
    if (!/Download prepared/.test(job)) return;
    const secretsAt = firstSigningMaterialIndex(job, validate);
    const verifyIdx = job.search(/sha256.*--check|shasum.*--check/);
    assert.ok(verifyIdx !== -1, `${name} must verify prepared input checksums`);
    assert.ok(verifyIdx < secretsAt, `${name} must verify checksums before loading secrets`);
  }
});

test("restored product binaries are discarded before the packaging build", () => {
  const release = workflows["release.yml"];
  const expectedProducts = new Map([
    [
      "build_macos",
      [
        /release\/tidebreak-desktop/,
        /release\/tidebreak-host-broker/,
        /release\/tidebreak\b/,
        /binaries\/tidebreak-host-broker/,
        /binaries\/tidebreak\b/,
      ],
    ],
    [
      "prepare_windows",
      [
        /release\/tidebreak-host-broker/,
        /release\/tidebreak\b/,
        /binaries\/tidebreak-host-broker/,
        /binaries\/tidebreak\b/,
      ],
    ],
    [
      "prepare_windows_desktop",
      [/release\/tidebreak-desktop/, /release\/tidebreak_desktop_lib/],
    ],
    [
      "build_linux",
      [
        /release\/tidebreak-desktop/,
        /release\/tidebreak-host-broker/,
        /release\/tidebreak(?:\s|$)/m,
        /binaries\/tidebreak-host-broker/,
        /binaries\/tidebreak-\$\{\{ matrix\.target \}\}(?:\s|$)/m,
      ],
    ],
  ]);
  for (const name of [
    "build_macos",
    "prepare_windows",
    "prepare_windows_desktop",
    "build_windows",
    "build_linux",
  ]) {
    const job = workflowJob(release, name);
    const names = stepNames(job);
    const restoreIdx = names.findIndex((n) => /Restore.*cache/i.test(n));
    const discardIdx = names.findIndex((n) => /Discard.*product/i.test(n));
    const buildIdx = names.findIndex((n) =>
      /Build.*Tauri|Bundle.*Tauri|Compile.*production credentials/i.test(n),
    );
    if (restoreIdx === -1) {
      assert.equal(discardIdx, -1, `${name}: discard without a cache restore is stale`);
      continue;
    }
    assert.notEqual(discardIdx, -1, `${name}: restored products must be discarded`);
    assert.ok(restoreIdx < discardIdx, `${name}: cache restore must come before discard`);
    assert.ok(discardIdx < buildIdx, `${name}: discard must come before the build`);
    // The discard step must remove every final product binary the cache can
    // restore. The Linux CLI patterns are exact because `\b` also matches
    // before the hyphen in `tidebreak-desktop` and `tidebreak-host-broker`.
    const discardStep = job.match(
      new RegExp(`- name: ${names[discardIdx].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?(?=\\n\\s+- name:)`),
    )?.[0];
    assert.ok(discardStep, `${name}: discard step content not found`);
    const products = expectedProducts.get(name) ?? [];
    for (const product of products) {
      assert.match(discardStep, product, `${name}: discard must remove ${product}`);
    }
  }
});

test("release version changes invalidate restored Rust artifacts", () => {
  for (const crateName of ["tidebreak-cli", "tidebreak-core", "tidebreak-server"]) {
    const buildScript = readFileSync(
      repositoryFile("crates", crateName, "build.rs"),
      "utf8",
    );
    assert.match(buildScript, /cargo::rerun-if-env-changed=TIDEBREAK_VERSION/);
  }
});

test("cache archives never include bundles, signatures, or keychains", () => {
  const release = workflows["release.yml"];
  // Only match `path:` blocks inside cache steps. The path list must not
  // cross a step boundary (a line starting with `      - name:` or
  // `      - uses:`), so filter out matches that span multiple steps.
  for (const source of [release]) {
    const cacheSteps = [...source.matchAll(
      /path: \|\n([\s\S]*?)\n\s+key: [$a-zA-Z]/g,
    )]
      .map((m) => m[1])
      .filter((paths) => !/^\s+- (?:name|uses):/m.test(paths));
    for (const paths of cacheSteps) {
      assert.doesNotMatch(paths, /pdfium/i);
      assert.doesNotMatch(paths, /bundle|\.app\b|dmg|signature|keychain/i);
    }
  }
});

test("macOS notarization happens after bundling and before artifact verification", () => {
  const release = workflows["release.yml"];
  const names = stepNames(release);
  const bundleIdx = names.findIndex((n) => /bundle.*sign/i.test(n));
  const notarizeIdx = names.findIndex((n) => /notar/i.test(n) && /dmg|staple/i.test(n));
  const verifyIdx = names.findIndex((n) => /verify.*collect.*artifact/i.test(n));
  assert.ok(bundleIdx !== -1, "release must have a bundle/sign step");
  assert.ok(notarizeIdx !== -1, "release must have a notarization step");
  assert.ok(verifyIdx !== -1, "release must have an artifact verification step");
  assert.ok(bundleIdx < notarizeIdx, "bundling must come before notarization");
  assert.ok(notarizeIdx < verifyIdx, "notarization must come before artifact verification");
  // The notarization step must submit to notarytool and staple both DMG and app.
  // Find the step that actually contains `notarytool submit` — it may be
  // named differently across workflow revisions.
  const notarytoolIdx = release.indexOf("notarytool submit");
  assert.ok(notarytoolIdx !== -1, "release must submit to notarytool");
  const stepStart = release.lastIndexOf("- name:", notarytoolIdx);
  const stepEnd = release.indexOf("\n      - name:", notarytoolIdx);
  const notarizeStep = release.slice(stepStart, stepEnd !== -1 ? stepEnd : undefined);
  assert.match(notarizeStep, /notarytool submit/);
  assert.match(notarizeStep, /stapler staple/);
  assert.match(notarizeStep, /stapler validate/);
  // The App Store Connect key ordering (after bundling) is asserted only
  // when the workflow uses the single-submission pattern where the key step
  // is separate from the bundle and the notary submission is a standalone
  // step. The legacy pattern (Tauri notarizes during `tauri bundle`) loads
  // the key before bundling, which is correct for that pattern.
  const keyIdx = names.findIndex((n) => /Prepare App Store Connect key/i.test(n));
  if (keyIdx !== -1 && bundleIdx !== -1 && notarizeIdx !== -1) {
    const singleSubmission = /dmg.*app|app.*dmg/i.test(names[notarizeIdx]);
    if (singleSubmission) {
      assert.ok(bundleIdx < keyIdx, "the notary key must load after bundling in the single-submission pattern");
      assert.ok(keyIdx <= notarizeIdx, "the notary key must load before notarization");
    }
  }
});

test("Linux packaging writes no shared cache before loading updater material", () => {
  const release = workflows["release.yml"];
  assert.doesNotMatch(release, /^  prepare_linux:/m);
  const buildJob = workflowJob(release, "build_linux");
  // A credential-free third-party notices gate may sit in front of the
  // packaging build; nothing else may.
  assert.match(buildJob, /needs: \[validate(?:, notices)?\]/);
  assert.match(buildJob, /ubuntu-22\.04/);
  assert.match(buildJob, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(buildJob, /target: x86_64-unknown-linux-gnu/);
  assert.match(buildJob, /runner: ubuntu-22\.04/);
  assert.match(buildJob, /target: aarch64-unknown-linux-gnu/);
  assert.match(buildJob, /runner: ubuntu-22\.04-arm/);
  assert.match(buildJob, /libwebkit2gtk-4\.1-dev/);
  assert.match(buildJob, /xdg-utils/);
  assert.match(buildJob, /scripts\/install-linux-apt-packages\.sh/);
  // The credentialed packaging job must never save a cache.
  assert.doesNotMatch(buildJob, /actions\/cache\/save/);
  // Cargo download cache must be restore-only.
  const rustCache = cargoDownloadCache(buildJob);
  assert.ok(rustCache);
  assert.match(rustCache, /save-if: false/);
  // Packages must be built before updater signing material is loaded.
  const names = stepNames(buildJob);
  const buildIdx = names.findIndex((n) => /Build.*Tauri.*Linux/i.test(n));
  const signIdx = names.findIndex((n) => /Verify.*collect.*Linux.*artifact/i.test(n));
  if (buildIdx !== -1 && signIdx !== -1) {
    assert.ok(buildIdx < signIdx, "Linux packages must be built before updater signing");
  }
  assert.match(buildJob, /--bundles appimage,deb/);
  assert.match(buildJob, /\.AppImage/);
  assert.match(buildJob, /\.deb/);
  assert.match(buildJob, /tauri signer sign/);
});

test("a published release is verified again, never rebuilt or overwritten", () => {
  const release = workflows["release.yml"];
  for (const name of ["inspect_hosted", "publish", "build_docs", "publish_docs"]) {
    assert.doesNotMatch(
      release,
      new RegExp(`^  ${name}:\\n`, "m"),
      `${name} must stay removed`,
    );
  }
  for (const jobName of [
    "prepare_macos",
    "combine_macos",
    "build_macos",
    "prepare_windows",
    "prepare_windows_desktop",
    "build_windows",
    "build_linux",
    "source_sbom",
  ]) {
    assert.match(
      workflowJob(release, jobName),
      /needs\.validate\.outputs\.draft == 'true'/,
      `${jobName} must build only a draft`,
    );
  }

  const attachJob = workflowJob(release, "attach_downloads");
  const download = attachJob.match(
    /- name: Download existing immutable GitHub assets[\s\S]*?(?=\n\s+- name:)/,
  )?.[0];
  assert.ok(download, "a published release must be downloaded and verified");
  assert.match(download, /if: \$\{\{ needs\.validate\.outputs\.draft != 'true' \}\}/);
  assert.match(download, /gh release download "\$RELEASE_TAG"/);
  for (const step of [
    "Prevent latest-version regression",
    "Create release manifests and checksums",
    "Prepare downloads from the verified build",
    "Prepare provenance attestation subjects",
  ]) {
    const body = attachJob.match(
      new RegExp(`- name: ${step}\\n[\\s\\S]*?(?=\\n\\s+- name:)`),
    )?.[0];
    assert.ok(body, `attach_downloads must ${step.toLowerCase()}`);
    assert.match(
      body,
      /if: \$\{\{ needs\.validate\.outputs\.draft == 'true' \}\}/,
      `${step} must touch only a draft`,
    );
  }
  const upload = attachJob.match(
    /- name: Attach or verify the GitHub Release downloads[\s\S]*$/,
  )?.[0];
  assert.ok(upload);
  assert.match(upload, /if \[\[ "\$RELEASE_DRAFT" = true \]\]; then[\s\S]*gh release upload/);
});

test("source SBOM generation is isolated from production credentials", () => {
  const release = workflows["release.yml"];
  const sbomJob = workflowJob(release, "source_sbom");
  const attachJob = workflowJob(release, "attach_downloads");

  assert.match(sbomJob, /needs: validate\n/);
  assert.match(sbomJob, /permissions:\n      contents: read/);
  assert.doesNotMatch(sbomJob, /id-token:/);
  assert.doesNotMatch(sbomJob, /attestations:/);
  assert.doesNotMatch(sbomJob, /artifact-metadata:/);
  assert.doesNotMatch(sbomJob, /\n    environment:/);
  assert.doesNotMatch(sbomJob, /AWS_|DOWNLOADS_|RELEASE_BASE_URL|vars\.|secrets\./);
  assert.match(sbomJob, /ref: \$\{\{ needs\.validate\.outputs\.sha \}\}/);
  assert.match(sbomJob, /run: mkdir -p source-sbom/);
  // Admit 0.24.0 (main) and 0.24.2 (Dependabot). This file is copied from
  // the base branch, so a pin bump cannot land until both versions match.
  assert.match(
    sbomJob,
    /uses: anchore\/sbom-action@[0-9a-f]{40} # v0\.24\.(0|2)/,
  );
  assert.match(sbomJob, /syft-version: v1\.51\.0/);
  assert.match(sbomJob, /format: spdx-json/);
  assert.match(sbomJob, /upload-artifact: false/);
  assert.match(sbomJob, /upload-release-assets: false/);
  assert.match(
    sbomJob,
    /uses: actions\/upload-artifact@[0-9a-f]{40} # v7/,
  );
  assert.match(sbomJob, /name: tidebreak-source-sbom-\$\{\{ needs\.validate\.outputs\.version \}\}/);
  assert.doesNotMatch(attachJob, /anchore\/sbom-action/);

  assert.match(attachJob, /needs: \[validate, build_macos, build_windows, build_linux, source_sbom\]/);
  assert.match(attachJob, /needs\.source_sbom\.result == 'success'/);
  assert.match(
    attachJob,
    /uses: actions\/download-artifact@[0-9a-f]{40} # v8/,
  );
  assert.match(attachJob, /name: tidebreak-source-sbom-\$\{\{ needs\.validate\.outputs\.version \}\}/);
  assert.match(attachJob, /sha256sum --check --strict "\$sbom\.sha256"/);
});

test("public releases attest provenance without treating the source SBOM as an installer SBOM", () => {
  const attachJob = workflowJob(workflows["release.yml"], "attach_downloads");

  assert.match(attachJob, /attestations: write/);
  assert.match(attachJob, /id-token: write/);
  assert.match(attachJob, /github\.event\.repository\.visibility == 'public'/);

  const attestations = attachJob.match(
    /uses: actions\/attest@[0-9a-f]{40} # v4\.2\.2/g,
  );
  assert.equal(attestations?.length, 1);
  assert.match(attachJob, /subject-checksums: \$\{\{ runner\.temp \}\}\/immutable-release-files\.sha256/);
  assert.match(
    attachJob,
    /\(cd dist && find \. -type f -print0 \| sort -z \| xargs -0 sha256sum\)/,
  );
  assert.doesNotMatch(attachJob, /sbom-path:/);
  assert.doesNotMatch(attachJob, /release-artifacts\.sha256/);

  // The attestation covers the exact bytes before any of them are attached.
  const provenanceIndex = attachJob.indexOf("- name: Attest immutable release provenance");
  const uploadIndex = attachJob.indexOf("- name: Attach or verify the GitHub Release downloads");
  assert.ok(provenanceIndex !== -1 && uploadIndex !== -1);
  assert.ok(provenanceIndex < uploadIndex);
});

test("GitHub release assets are attached before immutable publication", () => {
  const release = workflows["release.yml"];
  const attachJob = workflowJob(release, "attach_downloads");
  const finalizeJob = workflowJob(release, "finalize_release");

  assert.match(attachJob, /needs: \[validate, build_macos, build_windows, build_linux, source_sbom\]/);
  assert.match(attachJob, /contents: write/);
  assert.doesNotMatch(attachJob, /^    environment:/m);
  assert.doesNotMatch(attachJob, /secrets\./);
  assert.doesNotMatch(attachJob, /APPLE_|TAURI_SIGNING|AWS_|DOWNLOADS_S3/);

  // GitHub Releases is the only download host: the manifests and the updater
  // feed are generated from the verified builds and point at the tag's own
  // release downloads.
  assert.match(
    attachJob,
    /RELEASE_BASE_URL: https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/releases\/download\n/,
  );
  assert.match(attachJob, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(
    attachJob,
    /node scripts\/create-release-manifests\.mjs[\s\S]*?--base-url "\$RELEASE_BASE_URL"/,
  );
  assert.match(attachJob, /for name in manifest\.json latest\.json; do/);
  assert.match(attachJob, /node scripts\/prepare-published-release\.mjs/);
  assert.match(
    attachJob,
    /cmp "\$RUNNER_TEMP\/expected-latest\.json" downloads\/latest\.json/,
  );
  assert.match(attachJob, /The release manifest names a file the release does not carry/);
  const createAt = attachJob.indexOf("- name: Create release manifests and checksums");
  const prepareAt = attachJob.indexOf("- name: Prepare downloads from the verified build");
  const verifyAt = attachJob.indexOf("- name: Verify the complete GitHub asset set");
  const uploadAt = attachJob.indexOf("- name: Attach or verify the GitHub Release downloads");
  assert.ok(
    createAt !== -1 && createAt < prepareAt && prepareAt < verifyAt && verifyAt < uploadAt,
    "manifests are created, gathered, and verified before any upload",
  );
  // Every updater signature must verify against the public key installed
  // apps trust before anything is attached; a release signed with another
  // key would publish updates that every installed app rejects.
  assert.match(
    attachJob,
    /node scripts\/verify-updater-signatures\.mjs \\\n\s+--config crates\/tidebreak-desktop\/tauri\.conf\.json \\\n\s+downloads\n/,
  );
  const signaturesAt = attachJob.indexOf("node scripts/verify-updater-signatures.mjs");
  assert.ok(
    verifyAt < signaturesAt && signaturesAt < uploadAt,
    "updater signatures must verify before any upload",
  );

  assert.match(attachJob, /name: tidebreak-macos-universal-/);
  assert.match(attachJob, /name: tidebreak-windows-x86_64-/);
  assert.match(attachJob, /name: tidebreak-windows-aarch64-/);
  assert.match(attachJob, /name: tidebreak-linux-x86_64-/);
  assert.match(attachJob, /name: tidebreak-linux-aarch64-/);
  assert.match(attachJob, /name: tidebreak-source-sbom-/);
  assert.match(attachJob, /gh release download "\$RELEASE_TAG"/);
  assert.match(attachJob, /sha256sum --check --strict/);
  assert.match(attachJob, /Tidebreak-macos-universal\.dmg/);
  assert.match(attachJob, /Tidebreak-macos-apple-silicon\.dmg/);
  assert.match(attachJob, /for suffix in dmg app\.zip app\.tar\.gz app\.tar\.gz\.sig; do/);
  assert.match(attachJob, /versioned="Tidebreak_\$\{TIDEBREAK_VERSION\}_\$\{arch\}"/);
  for (const suffix of [
    "-setup.exe",
    "-setup.exe.sig",
    ".AppImage",
    ".AppImage.sig",
    ".deb",
    ".deb.sig",
  ]) {
    assert.ok(
      attachJob.includes(`"$versioned${suffix}"`),
      `attach_downloads must require the versioned ${suffix} package`,
    );
  }
  assert.match(attachJob, /gh release upload "\$RELEASE_TAG"/);
  assert.match(attachJob, /if \[\[ "\$RELEASE_DRAFT" = true \]\]/);
  assert.match(attachJob, /releases\/\$RELEASE_ID\/assets/);
  assert.match(attachJob, /expected-release-assets/);
  assert.match(attachJob, /actual-release-assets/);
  assert.match(attachJob, /diff -u/);

  assert.match(finalizeJob, /needs: \[validate, build_macos, attach_downloads\]/);
  assert.match(finalizeJob, /contents: write/);
  assert.match(finalizeJob, /commits\/\$RELEASE_TAG/);
  assert.match(finalizeJob, /Release tag \$RELEASE_TAG moved after validation/);
  assert.match(finalizeJob, /draft: false/);
  assert.match(finalizeJob, /make_latest: "true"/);
  assert.match(finalizeJob, /published_at=\$published_at/);

  const readme = readFileSync(repositoryFile("README.md"), "utf8");
  const macDownloadLink = readme.match(
    /releases\/latest\/download\/(Tidebreak-macos-[\w-]+\.dmg)/,
  )?.[1];
  assert.ok(macDownloadLink, "the README must publish a macOS download link");
  assert.ok(
    attachJob.includes(`downloads/${macDownloadLink}`),
    `attach_downloads must upload ${macDownloadLink}`,
  );

  // The version-free Windows and Linux downloads are verified as one set.
  const crossPlatform = attachJob.match(/cross_platform=\(\n([\s\S]*?)\n\s+\)/)?.[1];
  assert.ok(crossPlatform, "attach_downloads must name the cross-platform downloads");
  for (const [platform, pattern] of [
    ["Windows", /releases\/latest\/download\/(Tidebreak-windows-[\w-]+\.exe)/],
    ["Linux AppImage", /releases\/latest\/download\/(Tidebreak-linux-[\w-]+\.AppImage)/],
    ["Linux Debian", /releases\/latest\/download\/(Tidebreak-linux-[\w-]+\.deb)/],
  ]) {
    const downloadLink = readme.match(pattern)?.[1];
    assert.ok(downloadLink, `the README must publish a ${platform} download link`);
    assert.ok(
      crossPlatform.split("\n").map((line) => line.trim()).includes(downloadLink),
      `attach_downloads must verify ${downloadLink}`,
    );
  }
});

function assertPerArchMacosCompile(job, label) {
  assert.match(job, /tauri-apps\/tauri-action@/, `${label} must compile with Tauri`);
  assert.match(job, /target: aarch64-apple-darwin/, `${label} must compile aarch64`);
  assert.match(job, /target: x86_64-apple-darwin/, `${label} must compile x86_64`);
  assert.match(
    job,
    /--target \$\{\{ matrix\.target \}\}/,
    `${label} must compile the matrix target`,
  );
  assert.match(
    job,
    /rustup target add "?\$\{\{ matrix\.target \}\}"?/,
    `${label} must install the matrix target`,
  );
}

// A per-arch compile is only universal once the workflow lipo-joins the app
// binary and both sidecars under the synthetic triple the bundler expects.
function assertPerArchSlicesAreJoined(source, label) {
  assert.match(source, /lipo -create/, `${label} must lipo-join per-arch slices`);
  for (const product of [
    /target\/universal-apple-darwin\/release\/tidebreak-desktop/,
    /binaries\/tidebreak-host-broker-universal-apple-darwin/,
    /binaries\/tidebreak-universal-apple-darwin/,
  ]) {
    assert.match(source, product, `${label} must produce ${product}`);
  }
}

test("universal macOS release packages contain both slices", () => {
  const release = workflows["release.yml"];
  const releasePrepare = workflowJob(release, "prepare_macos");
  const releaseCombine = workflowJob(release, "combine_macos");
  const releaseBuild = workflowJob(release, "build_macos");
  const sidecarPreparation = readFileSync(
    repositoryFile("crates/tidebreak-desktop/scripts/prepare-sidecar.mjs"),
    "utf8",
  );

  assert.match(sidecarPreparation, /triple === "universal-apple-darwin"/);
  assert.match(
    sidecarPreparation,
    /\["aarch64-apple-darwin", "x86_64-apple-darwin"\]/,
  );
  assert.match(
    sidecarPreparation,
    /"lipo",\s*\["-create", \.\.\.stagedSidecars, "-output", destination\]/,
  );

  // A separately packaged computer-use helper may join the app and two
  // sidecars. Its exact input paths and output remain part of this policy.
  assertPerArchMacosCompile(releasePrepare, "prepare_macos");
  const includesComputerUseHelper = releaseCombine.includes(
    'cu_helper="crates/tidebreak-desktop/binaries/tidebreak-cu-helper-universal-apple-darwin"',
  );
  assert.equal(
    releaseCombine.split("lipo -create").length - 1,
    includesComputerUseHelper ? 4 : 3,
    "combine_macos must join the app, both sidecars, and any declared computer-use helper",
  );
  if (includesComputerUseHelper) {
    const combineShell = releaseCombine.replace(/[ \t]*\\\n[ \t]*/g, " ");
    assert.match(
      combineShell,
      /lipo -create "\$arm_root\/crates\/tidebreak-desktop\/binaries\/tidebreak-cu-helper-aarch64-apple-darwin" "\$x86_root\/crates\/tidebreak-desktop\/binaries\/tidebreak-cu-helper-x86_64-apple-darwin" -output "\$PREPARED_ROOT\/\$cu_helper"/,
    );
    assert.match(releaseCombine, /for file in [^\n]*"\$cu_helper"[^\n]*; do/);
  }
  assertPerArchSlicesAreJoined(releaseCombine, "combine_macos");
  assert.match(releaseCombine, /tidebreak-prepared-macos-aarch64-apple-darwin-/);
  assert.match(releaseCombine, /tidebreak-prepared-macos-x86_64-apple-darwin-/);
  assert.match(releaseCombine, /tidebreak-prepared-macos-universal-/);
  assert.match(releaseCombine, /shasum -a 256 --check/);
  assert.match(releasePrepare, /macos-release-target-v5-\$\{\{ matrix\.target \}\}/);
  assert.doesNotMatch(releasePrepare, /macos-release-target-v5-universal/);
  assert.match(releaseBuild, /--target universal-apple-darwin/);
  assert.match(releaseBuild, /needs: \[validate, notices, combine_macos\]/);
  assert.match(releaseBuild, /tauri bundle/);
  assert.doesNotMatch(releaseBuild, /tauri-apps\/tauri-action@/);
  assert.doesNotMatch(releaseBuild, /rustup target add/);

  for (const job of [releaseBuild]) {
    assert.match(job, /timeout-minutes: 90/);
    assert.match(job, /lipo -archs "\$app_path\/Contents\/MacOS\/\$executable"/);
    assert.match(job, /\$binary_arches" = \*arm64\*/);
    assert.match(job, /\$binary_arches" = \*x86_64\*/);
    assert.match(job, /sidecar="\$app_path\/Contents\/MacOS\/tidebreak-host-broker"/);
    assert.match(job, /sidecar_arches="\$\(lipo -archs "\$sidecar"\)"/);
    assert.match(job, /cli_sidecar="\$app_path\/Contents\/MacOS\/tidebreak"/);
    assert.match(job, /cli_arches="\$\(lipo -archs "\$cli_sidecar"\)"/);
  }
});

// The computer-use helper's signing identifier, derived from the app identity.
const CU_HELPER_IDENTIFIER = "io.brightwave.tidebreak.cu-helper";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("macOS computer-use helper survives packaging and is signed before bundling", () => {
  const release = workflows["release.yml"];
  const combine = workflowJob(release, "combine_macos");
  const shell = (job) => job.replace(/[ \t]*\\\n[ \t]*/g, " ");
  const targetHelper = "crates/tidebreak-desktop/binaries/tidebreak-cu-helper-$RELEASE_TARGET";
  const resource = "crates/tidebreak-desktop/resources/host-broker/tidebreak-cu-helper";

  for (const [source, prepareName, buildName, bundleName] of [
    [release, "prepare_macos", "build_macos", "Bundle and sign the prepared Tauri app"],
  ]) {
    const prepare = workflowJob(source, prepareName);
    const build = workflowJob(source, buildName);
    assert.ok(prepare.includes(`cu_helper="${targetHelper}"`));
    assert.match(prepare, /for file in [^\n]*"\$cu_helper"[^\n]*; do/);
    assert.match(shell(prepare), /install -m 755 "\$cu_helper" "\$PREPARED_ROOT\/\$cu_helper"/);
    assert.match(
      shell(prepare),
      /shasum -a 256 [^\n]*"\$cu_helper" > SHA256SUMS/,
      `${prepareName} must checksum the computer-use helper`,
    );
    assert.ok(build.includes(`"./${targetHelper}"`));
    assert.ok(build.includes(`cu_helper="${targetHelper}"`));
    assert.ok(build.includes(`cu_resource="${resource}"`));
    assert.match(build, /install -m 755 "\$PREPARED_ROOT\/\$cu_helper" "\$cu_resource"/);

    const signing = build.match(/      - name: Sign the computer-use helper resource\n[\s\S]*?(?=\n      - name:)/)?.[0];
    assert.ok(signing, `${buildName} must sign the helper before bundling`);
    assert.match(signing, /codesign --force --options runtime --timestamp/);
    assert.ok(signing.includes(`--identifier ${CU_HELPER_IDENTIFIER}`));
    assert.match(signing, /--sign "\$APPLE_SIGNING_IDENTITY"/);
    assert.match(signing, /--keychain "\$APPLE_SIGNING_KEYCHAIN"/);
    assert.match(signing, /codesign --verify --strict --verbose=2 "\$cu_resource"/);
    // Without Apple signing the helper is signed ad-hoc, with the same
    // identifier, so the app's own ad-hoc signature still covers it.
    assert.match(signing, /if \[\[ "\$SIGNING_MODE" = developer-id \]\]; then/);
    assert.match(
      signing,
      new RegExp(
        `--timestamp=none \\\\\\n\\s+--identifier ${escapeRegExp(CU_HELPER_IDENTIFIER)} \\\\\\n\\s+--sign - \\\\\\n`,
      ),
    );
    assert.ok(build.indexOf(signing) > build.indexOf("- name: Import Developer ID certificate"));
    assert.ok(build.indexOf(signing) < build.indexOf(`- name: ${bundleName}`));

    const verifyAt = build.search(/- name: Verify and collect signed artifacts/);
    assert.notEqual(verifyAt, -1, `${buildName} must verify its packaged helper`);
    const verify = build.slice(verifyAt);
    assert.match(verify, /cu_helper="\$app_path\/Contents\/Resources\/host-broker\/tidebreak-cu-helper"/);
    assert.match(verify, /\[\[ -x "\$cu_helper" \]\]/);
    assert.match(verify, /helper_arches="\$\(lipo -archs "\$cu_helper"\)"/);
    assert.match(verify, /\[\[ "\$helper_arches" = \*arm64\* && "\$helper_arches" = \*x86_64\* \]\]/);
    assert.match(verify, /codesign --verify --strict --verbose=2 "\$cu_helper"/);
    assert.ok(verify.includes(`[[ "$helper_identifier" = ${CU_HELPER_IDENTIFIER} ]]`));
    assert.match(verify, /\[\[ -n "\$app_team" && "\$app_team" != "not set" && "\$helper_team" = "\$app_team" \]\]/);
    assert.match(verify, /grep -qx 'Signature=adhoc' <<<"\$helper_signature"/);
    assert.match(verify, /grep -qx 'Signature=adhoc' <<<"\$app_signature"/);
  }

  assert.ok(combine.includes('"./crates/tidebreak-desktop/binaries/tidebreak-cu-helper-$target"'));
  assert.match(
    shell(combine),
    /lipo -create "\$arm_root\/crates\/tidebreak-desktop\/binaries\/tidebreak-cu-helper-aarch64-apple-darwin" "\$x86_root\/crates\/tidebreak-desktop\/binaries\/tidebreak-cu-helper-x86_64-apple-darwin" -output "\$PREPARED_ROOT\/\$cu_helper"/,
  );
  assert.match(combine, /for file in [^\n]*"\$cu_helper"[^\n]*; do/);
  assert.match(shell(combine), /shasum -a 256 [^\n]*"\$cu_helper" > SHA256SUMS/);
});

test("the release checks third-party notices through the shared workflow", () => {
  const noticesWorkflow = workflows["third-party-notices.yml"];
  const notices = workflowJob(noticesWorkflow, "check");
  assert.equal(
    noticesWorkflow.split("node scripts/generate-third-party-notices.mjs --check")
      .length - 1,
    1,
    "the reusable workflow must check the notices exactly once",
  );
  assert.match(noticesWorkflow, /^on:\n  workflow_call:\n/m);
  assert.match(noticesWorkflow, /^permissions:\n  contents: read$/m);
  assert.match(notices, /runs-on: ubuntu-latest/);
  assert.match(notices, /cargo fetch --locked\n/);
  assert.match(
    notices,
    /cargo fetch --locked --manifest-path crates\/tidebreak-whisper\/Cargo\.toml/,
  );
  assert.match(
    notices,
    /hashFiles\('Cargo\.lock', 'crates\/tidebreak-whisper\/Cargo\.lock'\)/,
  );

  for (const {
    file,
    validate,
    platformJobs,
  } of [
    {
      file: "release.yml",
      validate: "validate",
      platformJobs: [
        "prepare_macos",
        "build_macos",
        "prepare_windows",
        "prepare_windows_desktop",
        "build_windows",
        "build_linux",
      ],
    },
  ]) {
    const source = workflows[file];
    const caller = workflowJob(source, "notices");
    assert.match(caller, new RegExp(`needs: ${validate}`));
    assert.match(
      caller,
      /uses: \.\/\.github\/workflows\/third-party-notices\.yml/,
    );
    assert.match(
      caller,
      new RegExp(`sha: \\$\\{\\{ needs\\.${validate}\\.outputs\\.sha \\}\\}`),
    );
    for (const jobName of platformJobs) {
      assert.match(
        workflowJob(source, jobName),
        /needs: \[[^\]]*notices[^\]]*\]/,
        `${jobName} must depend on the shared notices check`,
      );
    }
  }
});

test("the release smoke-tests packaged GitHub CLI discovery before upload", () => {
  const releaseBuild = workflowJob(workflows["release.yml"], "build_macos");
  const verifyAt = releaseBuild.indexOf("Verify and collect signed artifacts");
  const smokeAt = releaseBuild.indexOf(
    "Smoke-test packaged GitHub CLI discovery",
  );
  const uploadAt = releaseBuild.indexOf("Upload verified macOS artifacts");
  assert.ok(
    verifyAt !== -1 && verifyAt < smokeAt && smokeAt < uploadAt,
    "the packaged-app smoke check must run after verification and before upload",
  );
  assert.match(
    releaseBuild.slice(smokeAt, uploadAt),
    /scripts\/smoke-packaged-gh-discovery\.sh "\$\{app_paths\[0\]\}"/,
  );

  assert.match(packagedGhDiscoverySmoke, /finder_path="\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/);
  assert.match(packagedGhDiscoverySmoke, /\/usr\/bin\/env -i/);
  assert.match(packagedGhDiscoverySmoke, /CFFIXED_USER_HOME="\$profile_home"/);
  assert.match(packagedGhDiscoverySmoke, /ZDOTDIR="\$shell_config"/);
  assert.match(
    packagedGhDiscoverySmoke,
    /export PATH="\$GH_SMOKE_LOGIN_BIN:\$PATH"/,
  );
  assert.match(
    packagedGhDiscoverySmoke,
    /fake_log="\$smoke_root\/gh-config\/invocations\.log"/,
  );
  assert.match(
    packagedGhDiscoverySmoke,
    />> "\$GH_CONFIG_DIR\/invocations\.log"/,
  );
  assert.doesNotMatch(packagedGhDiscoverySmoke, /GH_SMOKE_LOG=/);
  assert.match(packagedGhDiscoverySmoke, /listen_path="\$profile_data\/listen\.json"/);
  assert.match(packagedGhDiscoverySmoke, /\/code\/delivery\/repositories/);
  assert.match(packagedGhDiscoverySmoke, /\.capability\.found == true/);
  assert.match(packagedGhDiscoverySmoke, /auth status --json hosts/);
  assert.match(packagedGhDiscoverySmoke, /trap cleanup EXIT/);
  assert.match(packagedGhDiscoverySmoke, /rm -rf -- "\$smoke_root"/);
});

test("the packaged updater trusts the production signing key and endpoint", () => {
  const updater = tauriConfig.plugins?.updater;
  assert.ok(updater, "plugins.updater must exist when updater artifacts are built");
  assert.match(
    Buffer.from(updater.pubkey, "base64").toString("utf8"),
    /minisign public key/,
  );
  // Tidebreak's home is github.com/naingthet/tidebreak, and the packaged
  // updater follows that repository's release feed.
  assert.deepEqual(updater.endpoints, [
    "https://github.com/naingthet/tidebreak/releases/latest/download/latest.json",
  ]);
});

test("no staging channel is built or hosted", () => {
  for (const name of ["staging.yml", "staging-publish.yml", "staging-prune.yml"]) {
    assert.equal(workflows[name], undefined, `${name} must stay removed`);
  }
  assert.equal(
    existsSync(
      repositoryFile("crates", "tidebreak-desktop", "tauri.staging.conf.json"),
    ),
    false,
    "the staging overlay must stay removed",
  );
  for (const [name, source] of Object.entries(workflows)) {
    assert.doesNotMatch(
      source,
      /desktop-staging|tauri\.staging\.conf\.json|channel: staging/,
      `${name} must not build or publish a staging channel`,
    );
  }
});

test("updater transition policy rejects unsafe ordering mutations", () => {
  // The shutdown-before-install boundary #1907 replaced. Kept as a fixture to
  // prove the policy no longer admits it now that the barrier is mandatory.
  const legacy = `
    async fn take_staged_and_restart() {
      app.state::<HostAccess>().shutdown().await;
      staged.update.install(&staged.bytes);
    }
  `;
  // This mirrors #1907: the generic helper owns the transition order, while
  // the Tauri call site supplies the concrete host and staged-update actions.
  const reversibleUpdater = `
    async fn take_staged_and_restart() {
      install_behind_broker_barrier(
        || host_access.quiesce_for_update(),
        || staged.update.install(&staged.bytes),
        || host_access.resume_after_failed_update(),
        || host_access.shutdown(),
      ).await;
    }
    async fn install_behind_broker_barrier(quiesce: Q, install: I, resume: R, shutdown: S) {
      quiesce().await?;
      match install() {
        Ok(()) => { shutdown().await; }
        Err(_) => { resume().await; }
      }
    }
  `;
  const reversibleBroker = `
    async fn admit(&self, command: BrokerCommand) {
      let admission = self.admission.lock().await;
      if *admission != BrokerAdmission::Running { return Err(()); }
      self.commands.try_send(command)?;
    }
    async fn run(&mut self) {
      match command {
        BrokerCommand::Quiesce { reply } => {
          self.ensure_session().await?;
          reply.send(());
        }
        BrokerCommand::ResumeAfterFailedUpdate { reply } => {
          self.allow_session_start = false;
          reply.send(());
        }
      }
    }
    async fn ensure_session(&mut self) {
      if !self.allow_session_start {
        return Err(BrokerClientError::UpdateRecovery);
      }
    }
  `;
  assert.ok(updaterTransitionIsSafe(reversibleUpdater, reversibleBroker));

  const unsafeCases = [
    [
      "legacy shutdown-before-install boundary without the broker barrier",
      legacy,
      "",
    ],
    [
      "legacy install before shutdown",
      `async fn take_staged_and_restart() { staged.update.install(&staged.bytes); app.state::<HostAccess>().shutdown().await; }`,
      "",
    ],
    [
      "legacy comment decoy",
      `async fn take_staged_and_restart() { staged.update.install(&staged.bytes); // app.state::<HostAccess>().shutdown().await\n }`,
      "",
    ],
    [
      "install before the broker barrier",
      reversibleUpdater.replace(
        "quiesce().await?;",
        "install(); quiesce().await?;",
      ),
      reversibleBroker,
    ],
    [
      "admission unlock before enqueue",
      reversibleUpdater,
      reversibleBroker.replace(
        "self.commands.try_send(command)?;",
        "drop(admission); self.commands.try_send(command)?;",
      ),
    ],
    [
      "quiesce acknowledgement before session pinning",
      reversibleUpdater,
      reversibleBroker.replace(
        "self.ensure_session().await?;\n          reply.send(());",
        "reply.send(());\n          self.ensure_session().await?;",
      ),
    ],
    [
      "resume acknowledgement before recovery gate",
      reversibleUpdater,
      reversibleBroker.replace(
        "self.allow_session_start = false;\n          reply.send(());",
        "reply.send(());\n          self.allow_session_start = false;",
      ),
    ],
    [
      "missing recovery gate",
      reversibleUpdater,
      reversibleBroker.replace(
        "if !self.allow_session_start {\n        return Err(BrokerClientError::UpdateRecovery);\n      }",
        "",
      ),
    ],
  ];
  for (const [name, updater, broker] of unsafeCases) {
    assert.equal(updaterTransitionIsSafe(updater, broker), false, name);
  }
});

test("the packaged desktop activates the signed updater feed", () => {
  assert.match(desktopCargo, /tauri-plugin-updater = "=[^"]+"/);
  assert.match(
    desktopHost,
    /\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\)/,
  );
  assert.match(desktopHost, /\.manage\(updater::UpdateManager::default\(\)\)/);
  assert.match(desktopHost, /updater::spawn_update_loop\(handle\.clone\(\)\)/);
  assert.match(desktopHost, /updater::desktop_update_state/);
  assert.match(desktopHost, /updater::check_for_update/);
  assert.match(desktopHost, /updater::restart_for_update/);
  assert.match(desktopUpdater, /updater\.check\(\)\.await/);
  assert.match(desktopUpdater, /update\.download\(/);
  assert.doesNotMatch(desktopUpdater, /download_and_install/);
  assert.ok(
    updaterTransitionIsSafe(desktopUpdater, desktopBroker),
    "updates must install behind the reversible broker barrier",
  );
  assert.match(desktopUpdater, /app\.restart\(\)/);
  // Production updates stay off debug builds. Current main enables macOS
  // only; the upcoming packaging change may also enable Windows and Linux
  // in the same cfg! or a sibling one.
  assert.match(
    desktopUpdater,
    /cfg!\(all\([\s\S]*not\(debug_assertions\),[\s\S]*target_os = "macos"[\s\S]*\)\)/,
  );
  assert.match(
    desktopUpdater,
    /cfg!\(all\(not\(debug_assertions\), target_os = "macos"\)\)/,
  );
  assert.match(
    desktopUpdater,
    /cfg!\(all\([\s\S]*not\(debug_assertions\),[\s\S]*target_os = "windows"[\s\S]*target_os = "linux"[\s\S]*\)\)/,
  );
  if (
    /target_os = "windows"/.test(desktopUpdater) ||
    /target_os = "linux"/.test(desktopUpdater)
  ) {
    assert.match(desktopUpdater, /target_os = "windows"/);
    assert.match(desktopUpdater, /target_os = "linux"/);
  }
  assert.match(
    desktopUpdater,
    /const UPDATE_CHECK_STARTUP_DELAY: Duration = Duration::from_secs\(15\)/,
  );
  assert.match(
    desktopUpdater,
    /const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs\(60 \* 60\)/,
  );
});

test("Linux release dependencies use the workflow helper without moving application HEAD", () => {
  const buildJob = workflowJob(workflows["release.yml"], "build_linux");
  assert.match(
    buildJob,
    /uses: actions\/checkout@[^\n]+\n\s+with:\n\s+ref: \$\{\{ needs\.validate\.outputs\.sha \}\}/,
  );
  const step = buildJob.match(
    /- name: Install Linux packaging dependencies\n[\s\S]*?(?=\n      - (?:name:|uses:))/,
  )?.[0];
  assert.ok(step, "Linux dependency installation step must exist");
  assert.match(step, /timeout-minutes: 8/);
  assert.match(step, /RELEASE_SHA: \$\{\{ needs\.validate\.outputs\.sha \}\}/);
  assert.match(step, /RELEASE_WORKFLOW_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(
    step,
    /git fetch --no-tags --depth=1 origin "\$RELEASE_WORKFLOW_SHA"/,
  );
  assert.match(
    step,
    /installer="\$RUNNER_TEMP\/tidebreak-install-linux-apt-packages\.sh"/,
  );
  assert.match(
    step,
    /git show "\$RELEASE_WORKFLOW_SHA:scripts\/install-linux-apt-packages\.sh" > "\$installer"/,
  );
  assert.doesNotMatch(
    step,
    /\bgit\s+(?:checkout|switch|reset|restore|read-tree)\b/,
  );
  const install = step.indexOf('bash "$installer"');
  assert.ok(
    install > step.indexOf('git show "$RELEASE_WORKFLOW_SHA:'),
    "Extract the helper before running it",
  );
  const guards = [
    ...step.matchAll(
      /\[\[ "\$\(git rev-parse HEAD\)" == "\$RELEASE_SHA" \]\] \|\| \{\n\s+echo [^\n]+\n\s+exit 1\n\s+\}/g,
    ),
  ];
  assert.equal(
    guards.length,
    2,
    "Guard application HEAD before and after dependency installation",
  );
  assert.ok(guards[0].index < step.indexOf("git fetch"));
  assert.ok(guards[1].index > install);
  const packages = step
    .slice(install, guards[1].index)
    .split("\n")
    .slice(1)
    .map((line) => line.trim().replace(/\s*\\$/, ""))
    .filter(Boolean);
  assert.deepEqual(packages, [
    "build-essential",
    "cmake",
    "file",
    "libayatana-appindicator3-dev",
    "librsvg2-dev",
    "libssl-dev",
    "libwebkit2gtk-4.1-dev",
    "libxdo-dev",
    "patchelf",
    "xdg-utils",
  ]);
});

test("Windows and Linux packaging is paused behind the platforms input", () => {
  const release = workflows["release.yml"];

  // The pause is a dispatch input, so one release can build every platform
  // without a code change. The default is what every draft publishes with;
  // the jobs that read it fall back to the same value.
  const input = release.match(
    /^      platforms:\n(?:        .*\n)+?        options:\n(?:          - .*\n)+/m,
  )?.[0];
  assert.ok(input, "release.yml must declare the platforms input");
  assert.match(input, /type: choice/);
  const platformDefault = /default: (all|macos)\n/.exec(input)?.[1];
  assert.ok(platformDefault, "the platforms input must default to all or macos");
  assert.match(input, /- all\n/);
  assert.match(input, /- macos\n/);

  for (const jobName of [
    "prepare_windows",
    "prepare_windows_desktop",
    "build_windows",
    "build_linux",
  ]) {
    assert.match(
      workflowJob(release, jobName),
      /inputs\.platforms == 'all'/,
      `${jobName} must only run when the dispatch selected every platform`,
    );
  }

  // Downstream jobs accept a skipped Windows or Linux build only while the run
  // was dispatched without those platforms; a failed or missing build still
  // blocks publication when they were requested.
  for (const jobName of ["attach_downloads"]) {
    const job = workflowJob(release, jobName);
    for (const build of ["build_windows", "build_linux"]) {
      assert.match(
        job,
        new RegExp(
          `needs\\.${build}\\.result == 'success'\\n\\s+\\|\\| \\(inputs\\.platforms != 'all' && needs\\.${build}\\.result == 'skipped'\\)`,
        ),
        `${jobName} must accept a skipped ${build} only when the platforms input paused it`,
      );
    }
    assert.match(
      job,
      new RegExp(
        `RELEASE_PLATFORMS: \\$\\{\\{ inputs\\.platforms \\|\\| '${platformDefault}' \\}\\}`,
      ),
      `${jobName} must fall back to the input's default, ${platformDefault}`,
    );
  }

  // Manifests follow the selection everywhere they are created or checked.
  const attachJob = workflowJob(release, "attach_downloads");
  assert.match(attachJob, /create-release-manifests\.mjs[\s\S]*?--platforms "\$RELEASE_PLATFORMS"/);
  assert.match(attachJob, /prepare-published-release\.mjs[\s\S]*?--platforms "\$RELEASE_PLATFORMS"/);

  // Paused platforms download nothing, and the README's permanent links keep
  // serving the last builds that shipped.
  for (const label of ["x86_64 Windows", "ARM64 Windows", "x86_64 Linux", "ARM64 Linux"]) {
    assert.match(
      attachJob,
      new RegExp(
        `- name: Download the verified ${label} build\\n\\s+if: \\$\\{\\{ inputs\\.platforms == 'all' && `,
      ),
    );
  }
  const carryForward = attachJob.match(
    /- name: Carry forward the paused Windows and Linux downloads[\s\S]*?(?=\n\s+- name:)/,
  )?.[0];
  assert.ok(carryForward, "attach_downloads must carry paused downloads forward");
  assert.match(carryForward, /inputs\.platforms != 'all'/);
  assert.match(carryForward, /releases\/latest" --jq \.tag_name/);
  assert.match(carryForward, /"\$previous" != "\$RELEASE_TAG"/);
  // The first release in a repository has nothing to carry.
  assert.match(carryForward, /if \[\[ -z "\$previous" \]\]; then[\s\S]*?exit 0/);
  for (const name of [
    "Tidebreak-windows-x86_64-setup.exe",
    "Tidebreak-windows-aarch64-setup.exe",
    "Tidebreak-linux-x86_64.AppImage",
    "Tidebreak-linux-x86_64.deb",
    "Tidebreak-linux-aarch64.AppImage",
    "Tidebreak-linux-aarch64.deb",
  ]) {
    assert.ok(carryForward.includes(name), `carry-forward must cover ${name}`);
  }
  assert.match(carryForward, /--pattern "\$name\.sha256"/);
  // Versioned packages and updater signatures never travel with the carried
  // downloads, so the updater feed cannot offer a stale Windows or Linux build.
  assert.doesNotMatch(carryForward, /\.sig|Tidebreak_\$\{TIDEBREAK_VERSION\}/);
});

test("releases publish only to GitHub Releases, with no other hosting", () => {
  for (const [name, source] of Object.entries(workflows)) {
    assert.doesNotMatch(
      source,
      /aws-actions\/|arn:aws|\baws s3\b|cloudfront|DOWNLOADS_S3_BUCKET|AWS_RELEASE_ROLE_ARN/i,
      `${name} must not publish to AWS`,
    );
    assert.doesNotMatch(
      source,
      /\bdownloads\.[a-z]+\.io\b|tidebreak\.io\b/,
      `${name} must not publish to a hosted download domain`,
    );
    assert.doesNotMatch(source, /vercel/i, `${name} must not deploy to Vercel`);
    assert.doesNotMatch(
      source,
      /vars\.(?:CI_[A-Z_]*RUNNER|RELEASE_[A-Z0-9_]*RUNNER)/,
      `${name} must run on standard hosted runners`,
    );
  }
  assert.equal(existsSync(repositoryFile(".github", "vercel-cli")), false);

  const release = workflows["release.yml"];
  for (const name of ["inspect_hosted", "publish", "build_docs", "publish_docs"]) {
    assert.doesNotMatch(release, new RegExp(`^  ${name}:\\n`, "m"));
  }
  for (const jobName of ["build_macos", "build_windows", "build_linux"]) {
    assert.match(
      workflowJob(release, jobName),
      /environment:\n      name: desktop-production\n      url: https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/releases\/tag\/\$\{\{ needs\.validate\.outputs\.tag \}\}\n/,
    );
  }
});

test("Apple signing is optional, and an ad-hoc macOS release says so", () => {
  const release = workflows["release.yml"];
  const build = workflowJob(release, "build_macos");
  const finalize = workflowJob(release, "finalize_release");
  const step = (name) =>
    build.match(
      new RegExp(`      - name: ${name}\\n[\\s\\S]*?(?=\\n      - name:|$)`),
    )?.[0];

  // Tauri's bundler reads APPLE_SIGNING_IDENTITY from the environment even
  // when it is empty, which would override the ad-hoc identity, so no Apple
  // value may sit in the job-level environment.
  const jobEnv = build.match(/^    env:\n[\s\S]*?(?=^    steps:)/m)?.[0] ?? "";
  assert.doesNotMatch(jobEnv, /APPLE_/);
  assert.match(build, /outputs:\n      signing: \$\{\{ steps\.signing\.outputs\.mode \}\}/);

  const validate = step("Validate production signing configuration");
  assert.ok(validate, "build_macos must validate its signing configuration");
  assert.match(validate, /id: signing/);
  assert.match(validate, /Missing updater signing configuration/);
  assert.match(validate, /echo "mode=developer-id" >> "\$GITHUB_OUTPUT"/);
  assert.match(validate, /echo "mode=adhoc" >> "\$GITHUB_OUTPUT"/);
  assert.match(validate, /Incomplete Apple signing configuration/);

  for (const name of [
    "Import Developer ID certificate",
    "Prepare App Store Connect key",
    "Notarize the DMG, then staple the DMG and app",
  ]) {
    assert.match(
      step(name) ?? "",
      /\n        if: \$\{\{ steps\.signing\.outputs\.mode == 'developer-id' \}\}\n/,
      `${name} must run only with Apple signing`,
    );
  }
  assert.match(
    step("Add the macOS signing identity to the prepared configuration") ?? "",
    /process\.env\.SIGNING_MODE === "developer-id"\n\s+\? process\.env\.APPLE_SIGNING_IDENTITY\n\s+: "-"/,
  );
  const verify = step("Verify and collect signed artifacts") ?? "";
  assert.match(
    verify,
    /if \[\[ "\$SIGNING_MODE" = developer-id \]\]; then\n\s+xcrun stapler validate "\$app_path"\n\s+spctl --assess/,
  );

  assert.match(
    finalize,
    /MACOS_SIGNING: \$\{\{ needs\.build_macos\.outputs\.signing \}\}/,
  );
  assert.match(finalize, /if \[\[ "\$MACOS_SIGNING" = adhoc \]\]; then/);
  assert.match(finalize, /ad-hoc signed and not notarized by Apple/);
  assert.match(finalize, /Open Anyway/);
  assert.match(finalize, /allow keychain access/);
  assert.match(finalize, /The macOS build reported no signing mode/);
});
