import type { XboxGamepadButtonId, XboxGamepadStickId } from '../../../shared/xboxGamepad';

import {
  AnalogStick,
  GamepadArtBoard,
  GeomHit,
  GeomShape,
  GeomShapes,
  Hit,
  PressGeom,
} from './gamepadLayoutPrimitives';
import * as Art from './joyConSilhouette';
import type { XboxGamepadLayoutProps } from './XboxGamepadLayout';

/**
 * Bindings stay on Apple/Xbox positions (A=bottom, B=right, X=left, Y=top).
 * Joy-Con prints Nintendo letters, so physical B/A/Y/X map onto a/b/x/y.
 */
export function JoyConGamepadLayout({
  disabled = false,
  hintFor,
  onEdit,
  preview,
  labels,
}: XboxGamepadLayoutProps) {
  const pressed = (id: XboxGamepadButtonId) => preview?.buttons[id] ?? false;
  const analog = (id: XboxGamepadStickId) => preview?.sticks[id] ?? { x: 0, y: 0 };
  const trigger = (id: 'lt' | 'rt') => preview?.triggers[id] ?? 0;

  return (
    <GamepadArtBoard
      testId="joycon-gamepad-layout"
      hits={
        <>
          <GeomHit
            part="lt"
            geom={Art.PRESS_ZL}
            hint={hintFor('lt')}
            disabled={disabled}
            pressed={pressed('lt')}
            onEdit={onEdit}
          />
          <GeomHit
            part="rt"
            geom={Art.PRESS_ZR}
            hint={hintFor('rt')}
            disabled={disabled}
            pressed={pressed('rt')}
            onEdit={onEdit}
          />
          <GeomHit
            part="lb"
            geom={Art.PRESS_L}
            hint={hintFor('lb')}
            disabled={disabled}
            pressed={pressed('lb')}
            onEdit={onEdit}
          />
          <GeomHit
            part="rb"
            geom={Art.PRESS_R}
            hint={hintFor('rb')}
            disabled={disabled}
            pressed={pressed('rb')}
            onEdit={onEdit}
          />
          <g data-testid="joycon-gamepad-dpad">
            <GeomHit
              part="dpadUp"
              geom={Art.PRESS_DPAD_UP}
              hint={hintFor('dpadUp')}
              disabled={disabled}
              pressed={pressed('dpadUp')}
              onEdit={onEdit}
            />
            <GeomHit
              part="dpadDown"
              geom={Art.PRESS_DPAD_DOWN}
              hint={hintFor('dpadDown')}
              disabled={disabled}
              pressed={pressed('dpadDown')}
              onEdit={onEdit}
            />
            <GeomHit
              part="dpadLeft"
              geom={Art.PRESS_DPAD_LEFT}
              hint={hintFor('dpadLeft')}
              disabled={disabled}
              pressed={pressed('dpadLeft')}
              onEdit={onEdit}
            />
            <GeomHit
              part="dpadRight"
              geom={Art.PRESS_DPAD_RIGHT}
              hint={hintFor('dpadRight')}
              disabled={disabled}
              pressed={pressed('dpadRight')}
              onEdit={onEdit}
            />
          </g>
          <g data-testid="joycon-gamepad-face">
            <GeomHit
              part="a"
              geom={Art.PRESS_B}
              hint={hintFor('a')}
              disabled={disabled}
              pressed={pressed('a')}
              onEdit={onEdit}
            />
            <GeomHit
              part="b"
              geom={Art.PRESS_A}
              hint={hintFor('b')}
              disabled={disabled}
              pressed={pressed('b')}
              onEdit={onEdit}
            />
            <GeomHit
              part="x"
              geom={Art.PRESS_Y}
              hint={hintFor('x')}
              disabled={disabled}
              pressed={pressed('x')}
              onEdit={onEdit}
            />
            <GeomHit
              part="y"
              geom={Art.PRESS_X}
              hint={hintFor('y')}
              disabled={disabled}
              pressed={pressed('y')}
              onEdit={onEdit}
            />
          </g>
          <GeomHit
            part="view"
            geom={Art.PRESS_MINUS}
            hint={hintFor('view')}
            disabled={disabled}
            pressed={pressed('view')}
            onEdit={onEdit}
          />
          <GeomHit
            part="menu"
            geom={Art.PRESS_PLUS}
            hint={hintFor('menu')}
            disabled={disabled}
            pressed={pressed('menu')}
            onEdit={onEdit}
          />
          <GeomHit
            part="xbox"
            geom={Art.PRESS_HOME}
            hint={hintFor('xbox')}
            disabled={disabled}
            pressed={pressed('xbox')}
            onEdit={onEdit}
          />
        </>
      }
      overlays={
        <>
          <Hit
            part="left"
            hint={hintFor('left')}
            disabled={disabled}
            pressed={pressed('ls')}
            onEdit={onEdit}
            box={[297, 182, 90, 83]}
            round
            testId="joycon-gamepad-stick-left"
            title={labels.leftStick}
          />
          <Hit
            part="right"
            hint={hintFor('right')}
            disabled={disabled}
            pressed={pressed('rs')}
            onEdit={onEdit}
            box={[661, 360, 90, 83]}
            round
            testId="joycon-gamepad-stick-right"
            title={labels.rightStick}
          />
        </>
      }
    >
      <GeomShapes geoms={Art.BODY_LEFT} />
      <GeomShapes geoms={Art.RAIL_LEFT} />
      <GeomShape geom={Art.L_BUTTON} />
      <GeomShapes geoms={Art.BODY_RIGHT} />
      <GeomShapes geoms={Art.RAIL_RIGHT} />
      <GeomShape geom={Art.R_BUTTON} />

      <PressGeom geom={Art.PRESS_ZL} on={pressed('lt') || trigger('lt') > 0.08} />
      <PressGeom geom={Art.PRESS_ZR} on={pressed('rt') || trigger('rt') > 0.08} />
      <PressGeom geom={Art.PRESS_L} on={pressed('lb')} />
      <PressGeom geom={Art.PRESS_R} on={pressed('rb')} />

      <AnalogStick
        well={Art.LEFT_STICK.slice(3)}
        socket={Art.STICK_LEFT_SOCKET}
        moving={Art.LEFT_STICK.slice(0, 2)}
        press={Art.PRESS_STICK_LEFT}
        analog={analog('left')}
        clicked={pressed('ls')}
      />
      <AnalogStick
        well={Art.RIGHT_STICK.slice(3)}
        socket={Art.STICK_RIGHT_SOCKET}
        moving={Art.RIGHT_STICK.slice(0, 2)}
        press={Art.PRESS_STICK_RIGHT}
        analog={analog('right')}
        clicked={pressed('rs')}
      />

      <GeomShapes geoms={Art.DPAD_UP} />
      <GeomShapes geoms={Art.DPAD_RIGHT} />
      <GeomShapes geoms={Art.DPAD_DOWN} />
      <GeomShapes geoms={Art.DPAD_LEFT} />
      <PressGeom geom={Art.PRESS_DPAD_UP} on={pressed('dpadUp')} />
      <PressGeom geom={Art.PRESS_DPAD_DOWN} on={pressed('dpadDown')} />
      <PressGeom geom={Art.PRESS_DPAD_LEFT} on={pressed('dpadLeft')} />
      <PressGeom geom={Art.PRESS_DPAD_RIGHT} on={pressed('dpadRight')} />

      <GeomShapes geoms={Art.FACE_B} />
      <GeomShapes geoms={Art.FACE_A} />
      <GeomShapes geoms={Art.FACE_X} />
      <GeomShapes geoms={Art.FACE_Y} />
      <PressGeom geom={Art.PRESS_B} on={pressed('a')} />
      <PressGeom geom={Art.PRESS_A} on={pressed('b')} />
      <PressGeom geom={Art.PRESS_Y} on={pressed('x')} />
      <PressGeom geom={Art.PRESS_X} on={pressed('y')} />

      <GeomShapes geoms={Art.MINUS} />
      <GeomShapes geoms={Art.PLUS} />
      <GeomShapes geoms={Art.HOME} />
      <GeomShapes geoms={Art.CAPTURE} />
      <PressGeom geom={Art.PRESS_MINUS} on={pressed('view')} />
      <PressGeom geom={Art.PRESS_PLUS} on={pressed('menu')} />
      <PressGeom geom={Art.PRESS_HOME} on={pressed('xbox')} />
    </GamepadArtBoard>
  );
}
