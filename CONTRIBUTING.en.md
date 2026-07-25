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
[Developer Certificate of Origin](https://developercertificate.org/) sign-off:
commit with `git commit -s`, which appends a
`Signed-off-by: Your Name <your@email>` trailer stating that you have the right
to submit the contribution under these terms. Do not submit code you are not
entitled to license (for example proprietary code copied without permission).

## Security issues

Do not disclose vulnerabilities, credentials, or exploitable details in public
issues, pull requests, or discussions. Follow the private reporting process in
[`SECURITY.en.md`](SECURITY.en.md).
