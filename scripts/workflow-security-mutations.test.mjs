import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const policyTest = join(repositoryRoot, "scripts", "workflow-security.test.mjs");
const fixturePaths = [
  ".github/actions/setup-sccache/action.yml",
  ".github/workflows",
  ".github/CODEOWNERS",
  ".github/release-drafter.yml",
  ".github/tauri-cli/package.json",
  ".github/tauri-cli/pnpm-lock.yaml",
  "docs-site/package.json",
  "docs-site/next.config.mjs",
  "crates/tidebreak-cli/build.rs",
  "crates/tidebreak-core/build.rs",
  "crates/tidebreak-desktop/tauri.conf.json",
  "crates/tidebreak-desktop/Cargo.toml",
  "crates/tidebreak-desktop/src/lib.rs",
  "crates/tidebreak-desktop/src/updater.rs",
  "crates/tidebreak-desktop/src/broker.rs",
  "crates/tidebreak-desktop/src/voice_transcription.rs",
  "crates/tidebreak-desktop/src/whisper_install.rs",
  "crates/tidebreak-desktop/scripts/prepare-sidecar.mjs",
  "crates/tidebreak-server/build.rs",
  // The sandbox-image pin job rewrites these by path; the policy test
  // asserts they exist and carry their pinned constants.
  "crates/tidebreak-sandbox-runtime/src/docker.rs",
  "crates/tidebreak-code-execution/src/sandbox_image.rs",
  "crates/tidebreak-code-execution/src/daytona.rs",
  "deploy/self-host/Dockerfile",
  "deploy/self-host/Dockerfile.dockerignore",
  "crates/tidebreak-sandbox-agent/Dockerfile.dockerignore",
  "scripts/stage-self-host-build-context.sh",
  "scripts/smoke-packaged-gh-discovery.sh",
  "deny.toml",
  "README.md",
];

function policyFixture() {
  const root = mkdtempSync(join(tmpdir(), "tidebreak-policy-mutation-"));
  for (const path of fixturePaths) {
    const source = join(repositoryRoot, path);
    if (!existsSync(source)) {
      continue;
    }
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  return root;
}

function edit(root, path, mutate) {
  const target = join(root, path);
  const before = readFileSync(target, "utf8");
  const after = mutate(before);
  assert.notEqual(after, before, `mutation did not change ${path}`);
  writeFileSync(target, after);
}

function editWorkflowJob(source, name, mutateJob) {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow job: ${name}`);
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  const end = next === -1 ? source.length : start + marker.length + next;
  const job = source.slice(start, end);
  const mutated = mutateJob(job);
  assert.notEqual(mutated, job, `mutation did not change job ${name}`);
  return source.slice(0, start) + mutated + source.slice(end);
}

function signingInstallStep(job) {
  const step = job.match(
    /      - name: (?:Install UI dependencies|Install pinned Tauri bundler)\n[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(step, "missing signing-job dependency install");
  return step;
}

function mutateSigningRustCache(job, saveIf) {
  if (/Install pinned Tauri bundler/.test(job)) {
    const step = `      - name: Cache Cargo downloads
        uses: Swatinem/rust-cache@f0d9c3887740aee45f6153b24b3a6b815192ec16 # v2
        with:
          cache-targets: false
          save-if: ${saveIf}

`;
    return job.replace(
      "      - name: Validate production signing configuration\n",
      `${step}      - name: Validate production signing configuration\n`,
    );
  }
  return job.replace(
    /save-if: (?:false|\$\{\{ matrix\.arch == 'aarch64' \}\})/,
    `save-if: ${saveIf}`,
  );
}

function runPolicy(root) {
  const env = {
    ...process.env,
    TIDEBREAK_POLICY_ROOT: root,
    TIDEBREAK_SKIP_DOCKER_CONTEXT_PROBE: "1",
  };
  delete env.NODE_TEST_CONTEXT;
  // Running the file directly still executes node:test, while avoiding the
  // recursive test-runner guard when this mutation harness itself runs under
  // `node --test scripts/*.test.mjs`.
  return spawnSync(process.execPath, [policyTest], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
}

test("the mirrored workflow-security fixture passes before mutation", () => {
  const root = policyFixture();
  try {
    const result = runPolicy(root);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const mutations = [
  {
    name: "compiler cache pull-request write access",
    file: ".github/workflows/ci.yml",
    expected: "compiler caches use the GitHub Actions cache",
    mutate: (source) =>
      source.replace(
        "access: ${{ github.event_name == 'pull_request' && 'read' || 'write' }}",
        "access: write",
      ),
  },
  {
    name: "compiler cache read-only mode escalation",
    file: ".github/actions/setup-sccache/action.yml",
    expected: "compiler caches use the GitHub Actions cache",
    mutate: (source) =>
      source.replace("read) cache_mode=READ_ONLY", "read) cache_mode=READ_WRITE"),
  },
  {
    name: "compiler cache OIDC permission",
    file: ".github/workflows/ci.yml",
    expected: "compiler caches use the GitHub Actions cache",
    mutate: (source) =>
      editWorkflowJob(source, "lint", (job) =>
        job.replace(
          "    permissions:\n      contents: read\n",
          "    permissions:\n      contents: read\n      id-token: write\n",
        ),
      ),
  },
  {
    name: "compiler cache S3 backend",
    file: ".github/actions/setup-sccache/action.yml",
    expected: "compiler caches use the GitHub Actions cache",
    mutate: (source) =>
      source.replace(
        '          echo "SCCACHE_GHA_ENABLED=true"\n',
        '          echo "SCCACHE_BUCKET=example"\n',
      ),
  },
  {
    name: "self-host mutable runtime packages",
    file: "deploy/self-host/Dockerfile",
    expected: "self-host runtime installs packages from an immutable Debian snapshot",
    mutate: (source) =>
      source
        .replace(
          /RUN rm -f \/etc\/apt\/sources\.list\.d\/debian\.sources[\s\S]*?&& apt-get -o Acquire::Check-Valid-Until=false update \\\n/,
          "RUN apt-get update \\\n",
        )
        .replace(/ca-certificates=[^\s\\]+/, "ca-certificates")
        .replace(/curl=[^\s\\]+/, "curl"),
  },
  {
    name: "sandbox image default-branch publication guard",
    file: ".github/workflows/publish-sandbox-image.yml",
    expected: "sandbox image publishing",
    mutate: (source) =>
      source.replace(
        /git merge-base --is-ancestor "\$SOURCE_SHA" "origin\/\$DEFAULT_BRANCH" \|\| \{[\s\S]*?\n\s+\}\n/,
        "",
      ),
  },
  {
    name: "sandbox image release-event trigger",
    file: ".github/workflows/publish-sandbox-image.yml",
    expected: "sandbox image publishing",
    mutate: (source) =>
      source.replace(
        /on:\n  release:\n    types: \[published\]\n  push:\n    branches: \[main\]/,
        'on:\n  push:\n    tags: ["v*"]\n    branches: [main]',
      ),
  },
  {
    name: "documentation-site execution lane",
    file: ".github/workflows/ci.yml",
    expected: "PR lanes are scope-gated",
    mutate: (source) => source.replace(/\n  docs-site:\n[\s\S]*$/, ""),
  },
  {
    name: "locked cargo-deny graph",
    file: ".github/workflows/ci.yml",
    expected: "dependency policy covers",
    mutate: (source) => source.replace("--all-features --locked", "--all-features"),
  },
  {
    name: "Docker deny-all baseline",
    file: "deploy/self-host/Dockerfile.dockerignore",
    expected: "Docker context is allowlisted",
    mutate: (source) => source.replace("\n**\n", "\n"),
  },
  {
    name: "Docker arbitrary hidden-file denial",
    file: "deploy/self-host/Dockerfile.dockerignore",
    expected: "Docker context is allowlisted",
    mutate: (source) => source.replace("**/.*\n", ""),
  },
  {
    name: "Docker tracked-context staging",
    file: "scripts/stage-self-host-build-context.sh",
    expected: "self-host build context excludes",
    mutate: (source) => source.replace("git -C \"$root\" archive --format=tar \"$revision\"", "tar -cf - \"$root\""),
  },
  {
    name: "Docker private-key filename denial",
    file: "deploy/self-host/Dockerfile.dockerignore",
    expected: "Docker context is allowlisted",
    mutate: (source) => source.replace("**/id_*\n", ""),
  },
  {
    name: "source SBOM OIDC isolation",
    file: ".github/workflows/release.yml",
    expected: "source SBOM generation is isolated from production credentials",
    mutate: (source) =>
      editWorkflowJob(source, "source_sbom", (job) =>
        job.replace(
          "    permissions:\n      contents: read\n",
          "    permissions:\n      contents: read\n      id-token: write\n",
        ),
      ),
  },
  {
    name: "source SBOM production-environment isolation",
    file: ".github/workflows/release.yml",
    expected: "source SBOM generation is isolated from production credentials",
    mutate: (source) =>
      editWorkflowJob(source, "source_sbom", (job) =>
        job.replace(
          "    runs-on: ubuntu-latest\n",
          "    runs-on: ubuntu-latest\n    environment: desktop-production\n",
        ),
      ),
  },
  {
    name: "source SBOM deployment-variable isolation",
    file: ".github/workflows/release.yml",
    expected: "source SBOM generation is isolated from production credentials",
    mutate: (source) =>
      editWorkflowJob(source, "source_sbom", (job) =>
        job.replace(
          "    steps:\n",
          "    env:\n      AWS_RELEASE_ROLE_ARN: ${{ vars.AWS_RELEASE_ROLE_ARN }}\n    steps:\n",
        ),
      ),
  },
  {
    name: "source SBOM exact release checkout",
    file: ".github/workflows/release.yml",
    expected: "source SBOM generation is isolated from production credentials",
    mutate: (source) =>
      editWorkflowJob(source, "source_sbom", (job) =>
        job.replace(
          "          ref: ${{ needs.validate.outputs.sha }}\n",
          "          ref: ${{ github.sha }}\n",
        ),
      ),
  },
  {
    name: "docs deploy from a pull request",
    file: ".github/workflows/docs.yml",
    expected: "documentation publishes to GitHub Pages from main",
    mutate: (source) =>
      source.replace("  workflow_dispatch:\n", "  workflow_dispatch:\n  pull_request:\n"),
  },
  {
    name: "docs build outside the Pages path",
    file: ".github/workflows/docs.yml",
    expected: "documentation publishes to GitHub Pages from main",
    mutate: (source) =>
      source.replace("      BASE_PATH: /tidebreak/docs\n", "      BASE_PATH: /tidebreak\n"),
  },
  {
    name: "docs build job holds deploy rights",
    file: ".github/workflows/docs.yml",
    expected: "documentation publishes to GitHub Pages from main",
    mutate: (source) =>
      editWorkflowJob(source, "build", (job) =>
        job.replace(
          "    permissions:\n      contents: read\n",
          "    permissions:\n      contents: read\n      pages: write\n",
        ),
      ),
  },
  {
    name: "source SBOM pinned artifact transfer",
    file: ".github/workflows/release.yml",
    expected: "source SBOM generation is isolated from production credentials",
    mutate: (source) =>
      editWorkflowJob(source, "source_sbom", (job) =>
        job.replace(
          /uses: actions\/upload-artifact@[0-9a-f]{40} # v7/,
          "uses: actions/upload-artifact@v7",
        ),
      ),
  },
  {
    name: "source SBOM pinned artifact download",
    file: ".github/workflows/release.yml",
    expected: "source SBOM generation is isolated from production credentials",
    mutate: (source) =>
      editWorkflowJob(source, "attach_downloads", (job) =>
        job.replace(
          /uses: actions\/download-artifact@[0-9a-f]{40} # v8\n        with:\n          name: tidebreak-source-sbom-/,
          "uses: actions/download-artifact@v8\n        with:\n          name: tidebreak-source-sbom-",
        ),
      ),
  },
  {
    name: "source SBOM is not an installer attestation",
    file: ".github/workflows/release.yml",
    expected: "public releases attest provenance without treating the source SBOM as an installer SBOM",
    mutate: (source) =>
      editWorkflowJob(source, "attach_downloads", (job) =>
        job.replace(
          "          subject-checksums: ${{ runner.temp }}/immutable-release-files.sha256\n",
          "          subject-checksums: ${{ runner.temp }}/immutable-release-files.sha256\n          sbom-path: dist/Tidebreak_${{ needs.validate.outputs.version }}_source.spdx.json\n",
        ),
      ),
  },
  {
    name: "release feed outside this repository's downloads",
    file: ".github/workflows/release.yml",
    expected: "GitHub release assets are attached before immutable publication",
    mutate: (source) =>
      source.replace(
        "      RELEASE_BASE_URL: https://github.com/${{ github.repository }}/releases/download\n",
        "      RELEASE_BASE_URL: https://downloads.example.com/tidebreak\n",
      ),
  },
  {
    name: "release publication through AWS",
    file: ".github/workflows/release.yml",
    expected: "releases publish only to GitHub Releases",
    mutate: (source) =>
      editWorkflowJob(source, "attach_downloads", (job) =>
        job.replace(
          "      - name: Attach or verify the GitHub Release downloads\n",
          "      - name: Configure AWS credentials\n        uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6\n\n      - name: Attach or verify the GitHub Release downloads\n",
        ),
      ),
  },
  {
    name: "larger release runner",
    file: ".github/workflows/release.yml",
    expected: "releases publish only to GitHub Releases",
    mutate: (source) =>
      source.replace(
        "            runner: windows-latest\n",
        "            runner: ${{ vars.RELEASE_WINDOWS_X64_RUNNER || 'windows-latest' }}\n",
      ),
  },
  {
    name: "notarization without Apple signing",
    file: ".github/workflows/release.yml",
    expected: "Apple signing is optional",
    mutate: (source) =>
      editWorkflowJob(source, "build_macos", (job) =>
        job.replace(
          "      - name: Notarize the DMG, then staple the DMG and app\n        if: ${{ steps.signing.outputs.mode == 'developer-id' }}\n",
          "      - name: Notarize the DMG, then staple the DMG and app\n",
        ),
      ),
  },
  {
    name: "job-level Apple identity overrides ad-hoc signing",
    file: ".github/workflows/release.yml",
    expected: "Apple signing is optional",
    mutate: (source) =>
      editWorkflowJob(source, "build_macos", (job) =>
        job.replace(
          "    env:\n      TIDEBREAK_VERSION: ${{ needs.validate.outputs.version }}\n",
          "    env:\n      TIDEBREAK_VERSION: ${{ needs.validate.outputs.version }}\n      APPLE_SIGNING_IDENTITY: ${{ vars.APPLE_SIGNING_IDENTITY }}\n",
        ),
      ),
  },
  {
    name: "ad-hoc release without a release-note warning",
    file: ".github/workflows/release.yml",
    expected: "Apple signing is optional",
    mutate: (source) =>
      editWorkflowJob(source, "finalize_release", (job) =>
        job.replace("ad-hoc signed and not notarized by Apple", "signed"),
      ),
  },
  {
    name: "voice helper published as a full release",
    file: ".github/workflows/publish-whisper-helper.yml",
    expected: "production secrets remain isolated",
    mutate: (source) => source.replace("            --prerelease\n", "            --latest\n"),
  },
  {
    name: "mobile deploy on every push",
    file: ".github/workflows/build-mobile.yml",
    expected: "production secrets remain isolated",
    mutate: (source) =>
      source.replace("on:\n  workflow_dispatch:\n", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n"),
  },
  {
    name: "mobile deploy fails without an Expo token",
    file: ".github/workflows/build-mobile.yml",
    expected: "production secrets remain isolated",
    mutate: (source) =>
      source.replace(
        '            echo "available=false" >> "$GITHUB_OUTPUT"\n',
        '            exit 1\n',
      ),
  },
  {
    name: "release uploads unverified updater signatures",
    file: ".github/workflows/release.yml",
    expected: "GitHub release assets are attached before immutable publication",
    mutate: (source) =>
      source.replace(
        "          node scripts/verify-updater-signatures.mjs \\\n            --config crates/tidebreak-desktop/tauri.conf.json \\\n            downloads\n",
        "",
      ),
  },
  {
    name: "voice helper publishes unverified signatures",
    file: ".github/workflows/publish-whisper-helper.yml",
    expected: "production secrets remain isolated",
    mutate: (source) =>
      source.replace(
        /      - name: Verify every helper signature against the updater key\n[\s\S]*?(?=\n      # `gh release create`)/,
        "",
      ),
  },
  {
    name: "a disabled image workflow fails a public release",
    file: ".github/workflows/release.yml",
    expected: "publishing a release dispatches the server image build",
    mutate: (source) =>
      source.replace("          if ! gh workflow run publish-server-image.yml \\\n", "          gh workflow run publish-server-image.yml \\\n"),
  },
  {
    name: "signing job pnpm pin",
    file: ".github/workflows/release.yml",
    expected: "signing jobs run installers before loading signing material",
    mutate: (source) =>
      editWorkflowJob(source, "build_macos", (job) =>
        job.replace(/version: 10(?:\.18\.3)?\n/, "version: latest\n"),
      ),
  },
  {
    name: "signing job lockfile install",
    file: ".github/workflows/release.yml",
    expected: "signing jobs run installers before loading signing material",
    mutate: (source) =>
      editWorkflowJob(source, "build_macos", (job) => {
        const install = signingInstallStep(job);
        return job.replace(install, "");
      }),
  },
  {
    name: "signing job rust-cache writer",
    file: ".github/workflows/release.yml",
    expected: "signing jobs run installers before loading signing material",
    mutate: (source) =>
      editWorkflowJob(source, "build_macos", (job) =>
        mutateSigningRustCache(job, "true"),
      ),
  },
  {
    name: "signing job floating pnpm",
    file: ".github/workflows/release.yml",
    expected: "signing jobs run installers before loading signing material",
    mutate: (source) =>
      editWorkflowJob(source, "build_macos", (job) =>
        job.replace(/version: 10\.18\.3\n/, "version: 10\n"),
      ),
  },
  {
    name: "signing job lifecycle scripts",
    file: ".github/workflows/release.yml",
    expected: "signing jobs run installers before loading signing material",
    mutate: (source) =>
      editWorkflowJob(source, "build_macos", (job) =>
        job.replace(
          /pnpm(?: --dir \.github\/tauri-cli)? install --frozen-lockfile --ignore-scripts/,
          (install) => install.replace(" --ignore-scripts", ""),
        ),
      ),
  },
  {
    name: "signing job installer order",
    file: ".github/workflows/release.yml",
    expected: "signing jobs run installers before loading signing material",
    mutate: (source) =>
      editWorkflowJob(source, "build_macos", (job) => {
        const install = signingInstallStep(job);
        return job.replace(install, "").replace(
          "      - name: Validate production signing configuration\n",
          `      - name: Validate production signing configuration\n${install}\n`,
        );
      }),
  },
  {
    name: "production signing rust-cache save-if",
    file: ".github/workflows/release.yml",
    expected: "signing jobs run installers before loading signing material",
    mutate: (source) =>
      editWorkflowJob(source, "build_macos", (job) =>
        mutateSigningRustCache(job, "${{ matrix.arch == 'aarch64' }}"),
      ),
  },
  {
    name: "Linux restored CLI discard",
    file: ".github/workflows/release.yml",
    expected: "restored product binaries are discarded before the packaging build",
    mutate: (source) =>
      editWorkflowJob(source, "build_linux", (job) => {
        if (/      - name: Discard restored product binaries\n/.test(job)) {
          return job.replace(
            /\n\s+target\/\$\{\{ matrix\.target \}\}\/release\/tidebreak \\\n/,
            "\n",
          );
        }
        return job.replace(
          "      - name: Install Linux packaging dependencies\n",
          `      - name: Restore unsigned Rust build cache
        uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: target/\${{ matrix.target }}/release
          key: linux-release-target-v1-\${{ matrix.arch }}

      - name: Discard restored product binaries
        run: |
          rm -rf \\
            target/\${{ matrix.target }}/release/tidebreak-desktop \\
            target/\${{ matrix.target }}/release/tidebreak-host-broker \\
            crates/tidebreak-desktop/binaries/tidebreak-host-broker-\${{ matrix.target }} \\
            crates/tidebreak-desktop/binaries/tidebreak-\${{ matrix.target }}

      - name: Install Linux packaging dependencies
`,
        );
      }),
  },
  ...[
    { file: ".github/workflows/release.yml", prepare: "prepare_macos", build: "build_macos" },
  ].flatMap(({ file, prepare, build }) => [
    {
      name: `${prepare} helper checksum omission`,
      file,
      expected: "macOS computer-use helper survives packaging and is signed before bundling",
      mutate: (source) => editWorkflowJob(source, prepare, (job) =>
        job.replace('              "$cu_helper" \\\n', ""),
      ),
    },
    {
      name: `${build} helper archive file-set omission`,
      file,
      expected: "macOS computer-use helper survives packaging and is signed before bundling",
      mutate: (source) => editWorkflowJob(source, build, (job) =>
        job.replace('              "./crates/tidebreak-desktop/binaries/tidebreak-cu-helper-$RELEASE_TARGET" \\\n', ""),
      ),
    },
    {
      name: `${build} helper resource restoration omission`,
      file,
      expected: "macOS computer-use helper survives packaging and is signed before bundling",
      mutate: (source) => editWorkflowJob(source, build, (job) =>
        job.replace('          install -m 755 "$PREPARED_ROOT/$cu_helper" "$cu_resource"\n', ""),
      ),
    },
    {
      name: `${build} helper signing omission`,
      file,
      expected: "macOS computer-use helper survives packaging and is signed before bundling",
      mutate: (source) => editWorkflowJob(source, build, (job) =>
        job.replace(/      - name: Sign the computer-use helper resource\n[\s\S]*?(?=\n      - name:)/, ""),
      ),
    },
    {
      name: `${build} helper signing team mismatch allowed`,
      file,
      expected: "macOS computer-use helper survives packaging and is signed before bundling",
      mutate: (source) => editWorkflowJob(source, build, (job) =>
        job.replace(' && "$helper_team" = "$app_team"', ""),
      ),
    },
  ]),
  {
    name: "universal helper architecture verification omission",
    file: ".github/workflows/release.yml",
    expected: "macOS computer-use helper survives packaging and is signed before bundling",
    mutate: (source) => editWorkflowJob(source, "combine_macos", (job) =>
      job.replace('for file in "$app_binary" "$broker_sidecar" "$cli_sidecar" "$cu_helper"; do',
        'for file in "$app_binary" "$broker_sidecar" "$cli_sidecar"; do'),
    ),
  },
  {
    name: "in-flight release sends boolean fields",
    file: ".github/workflows/release.yml",
    expected: "release builds freeze a draft tag from the trusted main workflow",
    mutate: (source) => source.replace(
      "{draft: true, prerelease: true}",
      '{draft: "true", prerelease: "true"}',
    ),
  },
  {
    name: "in-flight release rejects early publication",
    file: ".github/workflows/release.yml",
    expected: "release builds freeze a draft tag from the trusted main workflow",
    mutate: (source) => source.replace(
      ".draft == true and .prerelease == true",
      ".prerelease == true",
    ),
  },
  {
    name: "in-flight release retains the explicit tag",
    file: ".github/workflows/release.yml",
    expected: "release builds freeze a draft tag from the trusted main workflow",
    mutate: (source) => source.replace(
      "{tag_name: $tag, target_commitish: $target}",
      "{target_commitish: $target}",
    ),
  },
  {
    name: "in-flight release rejects a changed source",
    file: ".github/workflows/release.yml",
    expected: "release builds freeze a draft tag from the trusted main workflow",
    mutate: (source) => source.replace(
      ".tag_name == $tag and .target_commitish == $target",
      ".tag_name == $tag",
    ),
  },
  {
    name: "README macOS download matches an uploaded asset",
    file: "README.md",
    expected: "GitHub release assets are attached before immutable publication",
    mutate: (source) =>
      source.replace(
        /Tidebreak-macos-[\w-]+\.dmg/,
        "Tidebreak-macos-legacy.dmg",
      ),
  },
];

test("workflow-security controls fail closed under targeted mutations", async (t) => {
  for (const mutation of mutations) {
    await t.test(mutation.name, () => {
      const root = policyFixture();
      try {
        edit(root, mutation.file, mutation.mutate);
        const result = runPolicy(root);
        const output = `${result.stdout}\n${result.stderr}`;
        assert.notEqual(result.status, 0, `mutation passed unexpectedly:\n${output}`);
        assert.match(output, new RegExp(mutation.expected));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
