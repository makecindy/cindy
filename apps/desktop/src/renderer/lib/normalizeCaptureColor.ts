/** Resolve CSS colors in the current theme, then serialize bounded sRGB for the IPC palette. */
export function normalizeCaptureColor(value: string, fallback: string): string {
  if (!value || !CSS.supports('color', value)) return fallback;
  const probe = document.createElement('span');
  probe.style.color = value;
  probe.style.display = 'none';
  document.documentElement.appendChild(probe);
  try {
    // Computed color resolves currentColor/variables against the current document.
    const color = getComputedStyle(probe).color;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return fallback;
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    // Default canvas is sRGB: modern CSS spaces/color-mix become safe numeric rgba.
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
  } catch {
    return fallback;
  } finally {
    probe.remove();
  }
}
