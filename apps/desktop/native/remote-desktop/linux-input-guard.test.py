"""Native ordering with a simulated synchronous WM grab; no display or user input."""
import ctypes
import importlib.util
import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "input_guard", pathlib.Path(__file__).with_name("linux-input-guard.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InputGuardTests(unittest.TestCase):
    def fixture(self, states, mapping=(1, 2, 3, 4, 5, 6, 7)):
        display = module.Display.__new__(module.Display)
        display.connection, display.root, display.screen = 1, 2, 0
        display.width, display.height = 1280, 800
        display.keys, display.buttons = set(), set()
        calls = []
        remaining = iter(states)
        last = 0

        def query(_connection, _window, _root, _child, *_args):
            nonlocal last
            last = next(remaining, last)
            ctypes.cast(_args[-1], ctypes.POINTER(ctypes.c_uint))[0] = last
            calls.append(('state', last))
            return 1

        def get_mapping(_connection, output, _length):
            for index, value in enumerate(mapping):
                output[index] = value
            return len(mapping)

        display.library = SimpleNamespace(
            XQueryPointer=Mock(side_effect=query), XGetPointerMapping=Mock(side_effect=get_mapping),
            XKeysymToKeycode=lambda *_: 38, XStringToKeysym=lambda *_: 1,
            XSync=Mock(), XCloseDisplay=Mock(),
        )
        display.test = SimpleNamespace(
            XTestFakeKeyEvent=Mock(side_effect=lambda _c, key, down, _t: calls.append(('key', key, down))),
            XTestFakeButtonEvent=Mock(side_effect=lambda _c, button, down, _t: calls.append(('button', button, down))),
            XTestFakeMotionEvent=Mock(),
        )
        return display, calls

    def test_waits_for_replayed_release_before_delivering_keyboard(self):
        display, calls = self.fixture([256, 256, 256, 0])
        with patch.object(module.time, 'sleep') as sleep:
            display.command(['mousedown', '1', 'mouseup', '1', 'keydown', 'a', 'keyup', 'a'])
        self.assertLess(calls.index(('state', 0)), calls.index(('key', 38, True)))
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(display.test.XTestFakeButtonEvent.call_count, 2)  # never replay
        self.assertFalse(display.buttons)
        self.assertFalse(display.keys)

    def test_no_delay_when_logical_state_already_matches(self):
        display, _ = self.fixture([256, 0])
        with patch.object(module.time, 'sleep') as sleep:
            display.command(['mousedown', '1', 'mouseup', '1'])
        sleep.assert_not_called()

    def test_follows_swapped_pointer_mapping(self):
        display, calls = self.fixture([1024, 1024, 0], mapping=(3, 2, 1, 4, 5, 6, 7))
        with patch.object(module.time, 'sleep'):
            display.command(['mousedown', '1', 'mouseup', '1', 'keydown', 'a'])
        self.assertLess(calls.index(('state', 0)), calls.index(('key', 38, True)))

    def test_shared_deadline_stops_batch_without_replaying_and_cleanup_releases(self):
        display, calls = self.fixture([256, 256])
        with patch.object(module.time, 'monotonic', side_effect=[10, 11.1]):
            with self.assertRaisesRegex(ValueError, 'pointer processing timeout'):
                display.command(['mousedown', '1', 'mouseup', '1', 'keydown', 'a'])
        self.assertFalse(any(call[0] == 'key' for call in calls))
        self.assertEqual(display.buttons, {1})  # uncertain release is retained for cleanup
        display.library.XQueryPointer.reset_mock()
        display.close()
        display.library.XQueryPointer.assert_not_called()  # cleanup must not block on the grab
        display.library.XCloseDisplay.assert_called_once()
        self.assertFalse(display.buttons)

    def test_window_screen_change_stops_before_following_key(self):
        display, calls = self.fixture([])
        display.library.XQueryPointer.return_value = 0
        display.library.XQueryPointer.side_effect = None
        with self.assertRaisesRegex(ValueError, 'pointer unavailable'):
            display.command(['mousedown', '1', 'keydown', 'a'])
        self.assertFalse(any(call[0] == 'key' for call in calls))
        self.assertEqual(display.buttons, {1})

    def test_drag_and_horizontal_wheel_do_not_wait_for_unrepresentable_masks(self):
        display, _ = self.fixture([256])
        display.command(['mousedown', '1', 'mousemove', '30', '40'])
        self.assertEqual(display.buttons, {1})
        display.library.XQueryPointer.reset_mock()
        display.command(['click', '--repeat', '2', '--delay', '0', '6'])
        display.library.XQueryPointer.assert_not_called()
        self.assertEqual(display.buttons, {1})
        display.close()


class NativeTextTests(unittest.TestCase):
    def fixture(self):
        display, _ = InputGuardTests().fixture([])
        display.text_connection = 10
        display.typing = SimpleNamespace(xdo_enter_text_window=Mock(return_value=0), xdo_free=Mock())
        display.library.XkbLockModifiers = Mock()
        display.validate_text_target = Mock()
        display.prepare_text_mapping = Mock()
        display.text_modifiers = Mock(return_value={50})
        display.caps_locked = Mock(return_value=2)
        return display

    def test_native_unicode_and_modifier_restoration_do_not_touch_mouse(self):
        display = self.fixture()
        display.text({'windowId': 42, 'pid': 90, 'text': 'Ab中😀'})
        self.assertEqual([call.args[2] for call in display.typing.xdo_enter_text_window.call_args_list],
                         [c.encode() for c in 'Ab中😀'])
        self.assertTrue(all(call.args[1] == 0 for call in display.typing.xdo_enter_text_window.call_args_list))
        self.assertEqual(display.test.XTestFakeKeyEvent.call_args_list[0].args, (1, 50, False, 0))
        self.assertEqual(display.test.XTestFakeKeyEvent.call_args_list[-1].args, (1, 50, True, 0))
        self.assertEqual(display.library.XkbLockModifiers.call_args_list[-1].args, (1, 0x100, 2, 2))
        display.test.XTestFakeButtonEvent.assert_not_called()

    def test_focus_change_stops_mid_chunk_and_restores_modifiers(self):
        display = self.fixture()
        display.validate_text_target.side_effect = [None, None, ValueError('text focus changed')]
        with self.assertRaisesRegex(ValueError, 'focus changed'):
            display.text({'windowId': 42, 'pid': 90, 'text': 'private'})
        display.typing.xdo_enter_text_window.assert_called_once()
        self.assertEqual(display.test.XTestFakeKeyEvent.call_args_list[-1].args, (1, 50, True, 0))

    def test_interrupted_native_call_restores_keyboard_state_without_retry(self):
        display = self.fixture()
        display.typing.xdo_enter_text_window.side_effect = SystemExit()
        with self.assertRaises(SystemExit):
            display.text({'windowId': 42, 'pid': 90, 'text': 'private'})
        display.typing.xdo_enter_text_window.assert_called_once()
        self.assertEqual(display.library.XkbLockModifiers.call_args_list[-1].args[-1], 2)

    def test_invalid_request_fails_before_any_native_effect(self):
        for value in ['', 'a' * 33, '\x00', '\x1b', '\x7f', '\ud83d']:
            display = self.fixture()
            with self.assertRaisesRegex(ValueError, 'invalid text'):
                display.text({'windowId': 42, 'pid': 90, 'text': value})
            display.validate_text_target.assert_not_called()
            display.typing.xdo_enter_text_window.assert_not_called()
        for window, pid in [(True, 90), (42, False), (0, 90), (42, -1)]:
            with self.assertRaisesRegex(ValueError, 'invalid text'):
                self.fixture().text({'windowId': window, 'pid': pid, 'text': 'x'})

    def test_batch_deadline_prevents_an_unbounded_native_operation(self):
        display = self.fixture()
        with patch.object(module.time, 'monotonic', side_effect=[10, 11.1]):
            with self.assertRaisesRegex(ValueError, 'timeout'):
                display.text({'windowId': 42, 'pid': 90, 'text': 'private'})
        display.typing.xdo_enter_text_window.assert_not_called()

    def test_stale_active_window_and_unrelated_keyboard_focus_are_rejected(self):
        display = self.fixture()
        del display.validate_text_target
        display.property = Mock(side_effect=[99])
        with self.assertRaisesRegex(ValueError, 'focus changed'):
            display.validate_text_target(42, 90)
        display.property = Mock(side_effect=[42, 90])
        display.library.XGetInputFocus = lambda _d, focus, _r: setattr(focus._obj, 'value', 2)
        with self.assertRaisesRegex(ValueError, 'focus changed'):
            display.validate_text_target(42, 90)
        display.property = Mock(side_effect=[42, 90])
        display.library.XGetInputFocus = lambda _d, focus, _r: setattr(focus._obj, 'value', 42)
        display.validate_text_target(42, 90)


class StableMappingTests(unittest.TestCase):
    def fixture(self, mapping):
        display = NativeTextTests().fixture()
        del display.prepare_text_mapping
        display.text_mappings = {}
        display.keyboard_mapping = lambda: dict(mapping)
        def change(_connection, code, _width, symbols, _count):
            mapping[code] = tuple(symbols)
        display.library.XChangeKeyboardMapping = Mock(side_effect=change)
        display.library.XQueryKeymap = Mock()
        display.typing.xdo_new_with_opened_display = Mock(return_value=10)
        return display

    def test_reuses_stable_unicode_bindings_and_restores_only_owned_empty_slots(self):
        mapping = {8: (97, 65), 9: (0, 0), 10: (0, 0)}
        display = self.fixture(mapping)
        display.prepare_text_mapping('中😀a')
        self.assertEqual(mapping[8], (97, 65))
        self.assertEqual(len(display.text_mappings), 2)
        before = dict(mapping)
        display.prepare_text_mapping('😀中')
        self.assertEqual(mapping, before)
        self.assertEqual(display.library.XChangeKeyboardMapping.call_count, 2)
        display.restore_text_mapping()
        self.assertEqual(mapping, {8: (97, 65), 9: (0, 0), 10: (0, 0)})

    def test_full_map_never_steals_an_existing_physical_binding(self):
        display = self.fixture({8: (97, 65)})
        with self.assertRaisesRegex(ValueError, 'mapping unavailable'):
            display.prepare_text_mapping('中')
        display.library.XChangeKeyboardMapping.assert_not_called()

    def test_eviction_uses_only_idle_owned_slots_not_current_chunk_symbols(self):
        mapping = {8: (0, 0), 9: (0, 0)}
        display = self.fixture(mapping)
        display.prepare_text_mapping('中😀')
        with patch.object(module.time, 'sleep') as sleep:
            display.prepare_text_mapping('😀文')
        self.assertEqual(set(mapping[9]), {0x0101f600})
        self.assertEqual(set(mapping[8]), {0x01006587})
        self.assertLessEqual(sleep.call_args.args[0], 0.05)

    def test_external_mapping_changes_are_preserved_during_cleanup(self):
        mapping = {8: (0, 0)}
        display = self.fixture(mapping)
        display.prepare_text_mapping('中')
        mapping[8] = (0x01004e2d, 65)
        display.restore_text_mapping()
        self.assertEqual(mapping[8], (0x01004e2d, 65))


if __name__ == '__main__':
    unittest.main()
