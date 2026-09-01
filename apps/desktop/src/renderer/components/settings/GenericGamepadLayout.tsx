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
import * as Art from './ultimateC1Silhouette';
import type { XboxGamepadLayoutProps } from './XboxGamepadLayout';

/** Ultimate C1 / 8BitDo-style pad: Xbox positions and Xbox printed letters. */
export function GenericGamepadLayout({
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
      testId="generic-gamepad-layout"
      hits={
        <>
          <GeomHit
            part="lt"
            geom={Art.PRESS_LT}
            hint={hintFor('lt')}
            disabled={disabled}
            pressed={pressed('lt')}
            onEdit={onEdit}
          />
          <GeomHit
            part="rt"
            geom={Art.PRESS_RT}
            hint={hintFor('rt')}
            disabled={disabled}
            pressed={pressed('rt')}
            onEdit={onEdit}
          />
          <GeomHit
            part="lb"
            geom={Art.PRESS_LB}
            hint={hintFor('lb')}
            disabled={disabled}
            pressed={pressed('lb')}
            onEdit={onEdit}
          />
          <GeomHit
            part="rb"
            geom={Art.PRESS_RB}
            hint={hintFor('rb')}
            disabled={disabled}
            pressed={pressed('rb')}
            onEdit={onEdit}
          />
          <g data-testid="generic-gamepad-dpad">
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
          <g data-testid="generic-gamepad-face">
            <GeomHit
              part="a"
              geom={Art.PRESS_A}
              hint={hintFor('a')}
              disabled={disabled}
              pressed={pressed('a')}
              onEdit={onEdit}
            />
            <GeomHit
              part="b"
              geom={Art.PRESS_B}
              hint={hintFor('b')}
              disabled={disabled}
              pressed={pressed('b')}
              onEdit={onEdit}
            />
            <GeomHit
              part="x"
              geom={Art.PRESS_X}
              hint={hintFor('x')}
              disabled={disabled}
              pressed={pressed('x')}
              onEdit={onEdit}
            />
            <GeomHit
              part="y"
              geom={Art.PRESS_Y}
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
            box={[153.6, 233.4, 111.0, 110.1]}
            round
            testId="generic-gamepad-stick-left"
            title={labels.leftStick}
          />
          <Hit
            part="right"
            hint={hintFor('right')}
            disabled={disabled}
            pressed={pressed('rs')}
            onEdit={onEdit}
            box={[631.0, 368.4, 113.5, 112.2]}
            round
            testId="generic-gamepad-stick-right"
            title={labels.rightStick}
          />
        </>
      }
    >
      <GeomShapes geoms={Art.BODY} />
      <GeomShapes geoms={Art.USB} />
      <GeomShapes geoms={Art.PAIRING} />
      <GeomShape geom={Art.CHARGE_LED} />

      <PressGeom geom={Art.PRESS_LT} on={pressed('lt') || trigger('lt') > 0.08} />
      <PressGeom geom={Art.PRESS_RT} on={pressed('rt') || trigger('rt') > 0.08} />
      <PressGeom geom={Art.PRESS_LB} on={pressed('lb')} />
      <PressGeom geom={Art.PRESS_RB} on={pressed('rb')} />

      <AnalogStick
        well={Art.STICK_LEFT.slice(0, 2)}
        socket={Art.STICK_LEFT_SOCKET}
        moving={Art.STICK_LEFT.slice(2, 4)}
        press={Art.PRESS_STICK_LEFT}
        analog={analog('left')}
        clicked={pressed('ls')}
      />
      <AnalogStick
        well={Art.STICK_RIGHT.slice(0, 2)}
        socket={Art.STICK_RIGHT_SOCKET}
        moving={Art.STICK_RIGHT.slice(2, 4)}
        press={Art.PRESS_STICK_RIGHT}
        analog={analog('right')}
        clicked={pressed('rs')}
      />

      <GeomShapes geoms={Art.DPAD} />
      <PressGeom geom={Art.PRESS_DPAD_UP} on={pressed('dpadUp')} />
      <PressGeom geom={Art.PRESS_DPAD_DOWN} on={pressed('dpadDown')} />
      <PressGeom geom={Art.PRESS_DPAD_LEFT} on={pressed('dpadLeft')} />
      <PressGeom geom={Art.PRESS_DPAD_RIGHT} on={pressed('dpadRight')} />

      <GeomShapes geoms={Art.FACE_Y} />
      <GeomShapes geoms={Art.FACE_X} />
      <GeomShapes geoms={Art.FACE_B} />
      <GeomShapes geoms={Art.FACE_A} />
      <PressGeom geom={Art.PRESS_Y} on={pressed('y')} />
      <PressGeom geom={Art.PRESS_X} on={pressed('x')} />
      <PressGeom geom={Art.PRESS_B} on={pressed('b')} />
      <PressGeom geom={Art.PRESS_A} on={pressed('a')} />

      <GeomShapes geoms={Art.MINUS} />
      <GeomShapes geoms={Art.PLUS} />
      <PressGeom geom={Art.PRESS_MINUS} on={pressed('view')} />
      <PressGeom geom={Art.PRESS_PLUS} on={pressed('menu')} />
    </GamepadArtBoard>
  );
}
