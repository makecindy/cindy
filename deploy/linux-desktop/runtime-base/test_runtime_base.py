"""Offline checks for the dependency-base lock."""

import importlib.util
import io
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base_lock = load("base_lock", "base_lock.py")

DPKG = "ii \tadduser\t3.134\tall\nii \tlibc6\t2.36-9+deb12u14\tamd64\nii \tplank\t0.11.89-4+b1\tamd64\n"
MANUAL = "plank\n"


class LockTest(unittest.TestCase):
    def test_round_trip_keeps_versions_and_marks(self):
        rows = base_lock.parse_installed(DPKG, MANUAL)
        text = base_lock.format_lock(rows)
        self.assertEqual(base_lock.read_lock(text), rows)
        self.assertEqual(rows[("plank", "amd64")], ("0.11.89-4+b1", "manual"))
        self.assertEqual(rows[("adduser", "all")], ("3.134", "auto"))

    def test_rejects_partial_installs_and_dangling_marks(self):
        with self.assertRaisesRegex(base_lock.LockError, "not fully installed"):
            base_lock.parse_installed("rc \tplank\t0.11.89-4+b1\tamd64\n", "")
        with self.assertRaisesRegex(base_lock.LockError, "not installed"):
            base_lock.parse_installed(DPKG, "gh\n")

    def test_rejects_malformed_or_duplicate_lines(self):
        for text in ("plank\t1\tamd64\n", "plank\t1\tamd64\tsometimes\n",
                     "plank\t1 2\tamd64\tauto\n", "# only a comment\n"):
            with self.assertRaises(base_lock.LockError):
                base_lock.read_lock(text)
        with self.assertRaisesRegex(base_lock.LockError, "duplicate"):
            base_lock.read_lock("plank\t1\tamd64\tauto\nplank\t2\tamd64\tauto\n")

    def test_preferences_pin_every_package_above_1000(self):
        rows = base_lock.parse_installed(DPKG, MANUAL)
        prefs = base_lock.preferences(rows)
        self.assertEqual(prefs.count("Pin-Priority: 1001"), 3)
        self.assertIn("Package: libc6\nPin: version 2.36-9+deb12u14\n", prefs)

    def test_differences_report_every_kind(self):
        expected = base_lock.parse_installed(DPKG, MANUAL)
        actual = dict(expected)
        del actual[("adduser", "all")]
        actual[("libc6", "amd64")] = ("2.36-9+deb12u15", "auto")
        actual[("plank", "amd64")] = ("0.11.89-4+b1", "auto")
        actual[("gh", "amd64")] = ("2.100.0", "manual")
        problems = base_lock.differences(expected, actual)
        self.assertEqual(len(problems), 4)
        self.assertTrue(any(p.startswith("missing adduser") for p in problems))
        self.assertTrue(any(p.startswith("unexpected gh") for p in problems))
        self.assertTrue(any("2.36-9+deb12u15" in p for p in problems))
        self.assertTrue(any(p.startswith("mark plank") for p in problems))

    def test_verify_exit_codes(self):
        lock = base_lock.format_lock(base_lock.parse_installed(DPKG, MANUAL))
        with tempfile.NamedTemporaryFile("w", suffix=".lock") as handle:
            handle.write(lock)
            handle.flush()
            for manual, code in ((MANUAL, 0), ("", 1)):
                outputs = {"dpkg-query": DPKG, "apt-mark": manual}
                with mock.patch.object(base_lock, "run", side_effect=lambda *c: outputs[c[0]]), \
                        redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    self.assertEqual(base_lock.main(["verify", handle.name]), code)

    def test_manual_excludes_only_locked_names(self):
        lock = base_lock.format_lock(base_lock.parse_installed(DPKG, MANUAL))
        with tempfile.NamedTemporaryFile("w", suffix=".lock") as handle:
            handle.write(lock)
            handle.flush()
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(base_lock.main(["manual", handle.name]), 0)
            self.assertEqual(out.getvalue(), "plank\n")
            with redirect_stderr(io.StringIO()):
                self.assertEqual(base_lock.main(["manual", handle.name, "--exclude", "gh"]), 2)

    def test_capture_rejects_mutable_tags(self):
        with self.assertRaisesRegex(base_lock.LockError, "mutable tag"):
            base_lock.capture("cindy-runtime-cn:latest")

    def test_committed_lock_is_valid_and_consistent(self):
        rows = base_lock.read_lock((HERE / "packages.lock").read_text())
        self.assertEqual(rows[("google-chrome-stable", "amd64")], ("155.0.8059.84-1", "manual"))
        self.assertEqual(rows[("libc6", "amd64")][0], "2.36-9+deb12u14")
        dockerfile = (HERE / "Dockerfile").read_text()
        # Files extracted without installing must not also be locked packages,
        # and every downloaded package needs its own checksum line.
        command = re.search(r"apt-get [^\n]*\bdownload (.*?)\nsha256sum", dockerfile, re.S).group(1)
        names = re.findall(r"\b([a-z0-9][a-z0-9.+-]+)=[0-9][^ \\\n]*", command)
        self.assertEqual(len(names), 6)
        sums = dockerfile.split("<<'SUMS'", 1)[1].split("SUMS", 1)[0]
        for name in names:
            self.assertNotIn((name, "all"), rows)
            self.assertNotIn((name, "amd64"), rows)
            self.assertRegex(sums, rf"\n[0-9a-f]{{64}}  {re.escape(name)}_")
        # The extracted locale sources must match the locked C library.
        self.assertIn("locales=" + rows[("libc6", "amd64")][0], dockerfile)


if __name__ == "__main__":
    unittest.main()
