"""Opt-in Hyprland cursor regression in a disposable nested compositor.

Usage: python cursor.integration.py /absolute/plugin.so /absolute/capture
Requires Hyprland 0.56.2, foot and ImageMagick on a Wayland desktop.
Never loads plugins, moves pointers or changes settings in the parent compositor.
"""
import base64
import json
import os
from pathlib import Path
import select
import subprocess as sp
import sys
import tempfile
import time


def output(args, **kwargs):
    return sp.check_output(args, timeout=8, **kwargs)


def stop(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except sp.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def exercise(root, scale, plugin, capture):
    config = root / 'hyprland.lua'
    config.write_text(
        f'hl.monitor({{output="",mode="1280x800@60",position="0x0",scale={scale}}})\n'
        'hl.config({misc={disable_hyprland_logo=true,disable_splash_rendering=true},'
        'animations={enabled=false},xwayland={enabled=false},'
        'cursor={no_hardware_cursors=1}})\n'
    )
    compositor = foot = child = None
    with (root / 'hyprland.log').open('w') as log:
        try:
            compositor = sp.Popen(
                ['Hyprland', '--config', str(config)],
                env=dict(os.environ, AQ_BACKEND='wayland', XDG_CACHE_HOME=str(root / 'cache')),
                stdout=log, stderr=sp.STDOUT,
            )
            instance = None
            for _ in range(50):
                instances = json.loads(output(['hyprctl', '-j', 'instances']))
                instance = next((i for i in instances if i['pid'] == compositor.pid), None)
                if instance:
                    break
                assert compositor.poll() is None, 'Nested compositor exited'
                time.sleep(.1)
            assert instance, 'Nested compositor not ready'
            env = dict(os.environ, WAYLAND_DISPLAY=instance['wl_socket'],
                       HYPRLAND_INSTANCE_SIGNATURE=instance['instance'])

            def ctl(*args):
                return output(['hyprctl', '-i', instance['instance'], *args], text=True).strip()

            assert ctl('plugin', 'load', plugin) == 'ok'
            foot = sp.Popen(['foot', '--config=/dev/null', 'sh', '-c',
                             'printf "CURSOR REGRESSION\\n"; sleep 120'], env=env,
                            stdout=sp.DEVNULL, stderr=sp.DEVNULL)
            time.sleep(.8)
            monitor = json.loads(ctl('-j', 'monitors'))[0]
            assert monitor['scale'] == scale
            for mode in ['cursor-overlay', 'video']:
                child = sp.Popen([capture, mode, str(scale), '95', monitor['name']],
                                 env=env, stdin=sp.PIPE, stdout=sp.PIPE)
                paths = []
                for fraction in [.3, .7]:
                    x = int(monitor['width'] / scale * fraction)
                    y = int(monitor['height'] / scale * .6)
                    assert ctl('eval', f'hl.dispatch(hl.dsp.cursor.move({{x={x},y={y}}}))') == 'ok'
                    for _ in range(8):
                        child.stdin.write(b'f')
                        child.stdin.flush()
                        assert select.select([child.stdout], [], [], 5)[0], 'Frame timeout'
                        line = child.stdout.readline()
                        assert line, 'Capture exited'
                        frame = json.loads(line) if mode == 'cursor-overlay' else {'jpeg': line}
                        time.sleep(.06)
                    if mode == 'cursor-overlay':
                        cursor = frame['cursor']
                        assert cursor and cursor['visible'] and cursor['png']
                        assert abs(cursor['x'] - x * scale / monitor['width']) < .002
                        assert abs(cursor['y'] - y * scale / monitor['height']) < .002
                    path = root / f'{mode}-{fraction}.jpg'
                    path.write_bytes(base64.b64decode(frame['jpeg']))
                    paths.append(str(path))
                stop(child)
                child = None
                diff = str(root / 'diff.png')
                output(['magick', *paths, '-compose', 'difference', '-composite', diff])
                for fraction in [.3, .7]:
                    x, y = int(monitor['width'] * fraction), int(monitor['height'] * .6)
                    mean = float(output(['magick', diff, '-crop', f'100x100+{x-50}+{y-50}',
                                         '-format', '%[fx:mean]', 'info:']))
                    # Separate cursor: neither the old nor new pointer may be
                    # burned into video. Legacy video must still include it.
                    assert (mean < .001 if mode == 'cursor-overlay' else mean > .001), (mode, mean)
                print(f'PASS scale={scale} {mode}: coordinates / video pixels', flush=True)
        finally:
            stop(child)
            stop(foot)
            stop(compositor)


if __name__ == '__main__':
    plugin, capture = (str(Path(p).resolve(strict=True)) for p in sys.argv[1:])
    for scale in [1, 1.6]:
        with tempfile.TemporaryDirectory(prefix='cindy-cursor-regression-') as directory:
            exercise(Path(directory), scale, plugin, capture)
