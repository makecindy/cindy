"""Packaging checks; fixtures are generated and contain no third-party fonts."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("emoji_stage", Path(__file__).with_name("stage-emoji-font.py"))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)


class EmojiPackagingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source, self.target = root / "package", root / "layer"
        self.source.mkdir()
        self.target.mkdir()
        self.files = {}
        for name, data in [("usr/share/fonts/test.ttf", b"test font"),
                           ("usr/share/doc/test/copyright", b"test license")]:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            self.files[name] = hashlib.sha256(data).hexdigest()
        self.patcher = patch.object(stage, "FILES", self.files)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_restrictive_operator_umask_cannot_remove_runtime_access(self):
        old = os.umask(0o077)
        try:
            stage.stage(self.source, self.target)
        finally:
            os.umask(old)
        for path in [self.target, *self.target.rglob("*")]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o755 if path.is_dir() else 0o644)
        for name, digest in self.files.items():
            self.assertEqual(hashlib.sha256((self.target / name).read_bytes()).hexdigest(), digest)

    def test_invalid_license_does_not_leave_a_partial_distribution(self):
        (self.source / "usr/share/doc/test/copyright").write_bytes(b"wrong license")
        with self.assertRaisesRegex(ValueError, "unexpected"):
            stage.stage(self.source, self.target)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_symlink_cannot_redirect_image_writes(self):
        (self.target / "usr").symlink_to(self.source / "usr", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            stage.stage(self.source, self.target)

    def test_overlapping_input_and_output_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "separate directories"):
            stage.stage(self.source, self.source)


if __name__ == "__main__":
    unittest.main()
