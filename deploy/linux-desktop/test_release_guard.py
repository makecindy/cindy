import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_guard import CMD, ENTRYPOINT, ReleaseRejected, audit_image

class ReleaseGuardTest(unittest.TestCase):
    def setUp(self):
        self.base = {'RootFS': {'Layers': ['base']}}
        self.image = {'Id': 'image-test', 'Os': 'linux', 'Architecture': 'amd64', 'Size': 100,
                      'RootFS': {'Layers': ['base', 'application']},
                      'Config': {'User': 'cindy', 'Entrypoint': ENTRYPOINT, 'Cmd': CMD,
                                 'Labels': {'io.cindy.source-commit': 'commit', 'io.cindy.entrypoint-sha256': 'wrapper'}}}

    def rejected(self, image):
        with self.assertRaises(ReleaseRejected):
            audit_image(image, self.base, 'commit', 'wrapper')

    def test_accepts_the_built_image(self):
        self.assertEqual(audit_image(self.image, self.base, 'commit', 'wrapper'),
                         {'imageId': 'image-test', 'layers': 2, 'bytes': 100})

    def test_rejects_platform_and_layers(self):
        for key, value in [('Architecture', 'arm64'), ('Os', 'darwin'),
                           ('RootFS', {'Layers': ['base', 'old-app', 'new-app']}),
                           ('RootFS', {'Layers': ['other-base', 'application']})]:
            with self.subTest(key=key, value=value):
                self.rejected({**copy.deepcopy(self.image), key: value})

    def test_rejects_user_and_start_command(self):
        for key, value in [('User', 'root'), ('Entrypoint', ['/bin/sh']), ('Cmd', ['sleep', 'infinity'])]:
            with self.subTest(key=key):
                bad = copy.deepcopy(self.image)
                bad['Config'][key] = value
                self.rejected(bad)

    def test_rejects_other_source_or_entrypoint_labels(self):
        for label in ['io.cindy.source-commit', 'io.cindy.entrypoint-sha256']:
            with self.subTest(label=label):
                bad = copy.deepcopy(self.image)
                bad['Config']['Labels'][label] = 'other'
                self.rejected(bad)

if __name__ == '__main__':
    unittest.main(verbosity=2)
