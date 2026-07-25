<p align="right">
  <a href="CONTRIBUTING.md">简体中文</a> · <strong>English</strong>
</p>

# Contributing

Thank you for contributing code, documentation, and feedback to Cindy. This
repository is the open-source Cindy client: the desktop and mobile apps plus
their shared packages. The server is maintained in a separate repository and
is outside the scope of this repository.

## Before you start

- Follow [`docs/dev-rules/environment-setup.md`](docs/dev-rules/environment-setup.md)
  for supported tool versions and installation steps.
- Read the installation section in [`README.md`](README.md) and the
  applicable [engineering rules](AGENTS.md). `AGENTS.md` contains detailed
  engineering constraints; it is not a replacement for this contribution guide.
- Follow [`CODE_OF_CONDUCT.en.md`](CODE_OF_CONDUCT.en.md) when participating in
  the community. For ordinary usage questions, see [`SUPPORT.en.md`](SUPPORT.en.md).
- Do not commit credentials, tokens, authorization files, personal data, or
  generated local databases.
- The public repository pins only the public protocol submodule. Plugins are
  installed through SkillHub or manually. Do not put credentials in Git
  configuration or repository files.

## Getting the code and installing dependencies

Follow [Development environment and dependency setup](docs/dev-rules/environment-setup.md)
for cloning, public submodules, Git LFS, and dependency installation. That
document is the single source of truth for installation commands; this guide
does not duplicate them.

## Development and verification

### Desktop

See [Desktop development, launch, and verification](docs/dev-rules/desktop-development.md)
for startup, region selection, safe restarts, and verification commands.

### Mobile

See [Mobile development, simulators, and verification](docs/dev-rules/mobile-development.md)
for simulators, native rebuilds, and verification commands.

### Verification

Choose checks according to the risk-tiering principles in [AGENTS.md](AGENTS.md).
Use the desktop and mobile commands defined by their respective development
rules. When a change touches the database, protocol, endpoints, mobile scopes,
or another specialized area, read the applicable rules and run their checks as
well. Every pull request must state the commands that were run and their results;
explain why any highly relevant check was not run.

## Opening a pull request

1. Create a short-lived branch from the latest `main` and keep each pull
   request focused on one clear problem.
2. Use `<type>(<scope>): <short description>` for the pull request title, for
   example `docs(readme): clarify local mode`. See the
   [pull request template](.github/PULL_REQUEST_TEMPLATE.md) for available
   types.
3. Review the complete diff and confirm that it contains no credentials,
   unrelated generated files, or unintended submodule pointer changes.
4. Complete the [pull request template](.github/PULL_REQUEST_TEMPLATE.md),
   including scope, verification, risks, and rollback information.
5. Wait for CI and review; do not push directly to `main`.

Small documentation fixes are welcome as pull requests. For larger changes to
architecture, protocols, database migrations, permissions, or user data,
please open an issue first to discuss scope and compatibility.

## Licensing of contributions (DCO)

This repository is licensed under [Apache-2.0](LICENSE). Per Section 5 of the
license, any contribution you intentionally submit for inclusion is accepted
under the Apache-2.0 terms — no separate CLA is required.

We do require every commit to carry a
[Developer Certificate of Origin](https://developercertificate.org/) sign-off
(DCO 1.1; the full text is in the [`DCO`](DCO) file at the repository root):
commit with `git commit -s`, which appends a
`Signed-off-by: Your Name <your@email>` trailer stating that you have the right
to submit the contribution under these terms. Both the name and the address in
the trailer must match the commit's author (or committer) — the trailer is a
statement about yourself and cannot be made on someone else's behalf. Do not
submit code you are not entitled to license (for example proprietary code copied
without permission).

The **DCO check** on every pull request (the
[DCO GitHub App](https://github.com/apps/dco)) validates each commit in the pull
request; merge commits and bot commits are exempt, and history from before the
DCO requirement is never examined. Check yourself locally with `pnpm check:dco`.
If a commit is missing its sign-off:

```bash
# only the most recent commit is missing a sign-off
git commit --amend -s --no-edit

# several commits are missing sign-offs (<base> is the pull request base commit)
git rebase --signoff <base>

# update the pull request afterwards
git push --force-with-lease
```

If you would rather not rewrite history — say the pull request already carries
review discussion worth keeping — push a **remediation commit** instead. Its
message must contain the following line verbatim, where the sha is the full
40-character sha of the commit being signed off, and the remediation commit
itself must also carry your sign-off:

```text
I, Your Name <your@email>, hereby add my Signed-off-by to this commit: <full 40-char sha>

Signed-off-by: Your Name <your@email>
```

The author of both commits, and the name and address on that line, all have to
match exactly. To sign off on someone else's commit:

```text
On behalf of Author Name <author@email>, I, Your Name <your@email>, hereby add my Signed-off-by to this commit: <full 40-char sha>

Signed-off-by: Your Name <your@email>
```

Note that `pnpm check:dco` is deliberately more conservative than the gate on the
pull request: it only recognises direct sign-offs (not remediation commits) and it
does not exempt bot commits, since bot status depends on the GitHub account type
and cannot be determined offline. Passing locally therefore implies passing on the
pull request, but not the other way round — when using remediation, or when the
range contains bot commits, the DCO check on the pull request is the authority.

Git has no configuration option that signs commits off automatically
(`format.signOff` only affects `git format-patch` / `git am`). To set it up once,
install the prepare-commit-msg hook shipped with this repository. The hook itself
is [`.githooks/prepare-commit-msg`](.githooks/prepare-commit-msg) — an ordinary
shell script, so read it before installing. `pnpm dco:install-hook` copies it into
your local hooks directory; nothing is changed on the remote, and deleting the
installed copy uninstalls it. You can also point Git at the directory yourself
with `git config core.hooksPath .githooks` (that takes over the whole hooks
directory).

## Security issues

Do not disclose vulnerabilities, credentials, or exploitable details in public
issues, pull requests, or discussions. Follow the private reporting process in
[`SECURITY.en.md`](SECURITY.en.md).
