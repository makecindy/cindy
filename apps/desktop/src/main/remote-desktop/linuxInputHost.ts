import { screen } from 'electron';
import { openLinuxDisplay } from './linuxDisplay';
import { LinuxDesktopInput } from './linuxX11Input';
import { checkLinuxInputGuard, openLinuxInputGuard } from './linuxInputGuard';

export async function openLinuxDesktopInput(
  displayId: string,
  onFailure: () => void,
): Promise<LinuxDesktopInput> {
  const connection = await openLinuxDisplay();
  const bounds = screen
    .getAllDisplays()
    .find((display) => String(display.id) === displayId)?.bounds;
  if (
    !bounds ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.x + bounds.width > connection.width ||
    bounds.y + bounds.height > connection.height
  )
    throw new Error('DESKTOP_DISPLAY_MISSING');
  const guard = await openLinuxInputGuard(connection.environment, onFailure);
  return new LinuxDesktopInput({ ...connection, ...guard }, onFailure);
}

export async function readLinuxInputSupport(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const connection = await openLinuxDisplay();
    await checkLinuxInputGuard(connection.environment);
    return await connection.current();
  } catch {
    return false;
  }
}
