import { createRequire } from 'node:module';
import { nativeImage, type NativeImage } from 'electron';

const requireFromMain = createRequire(__filename);

// Windows 系统图标专属语义色对；Light/Dark 相同，不属于应用内 error 状态。
// 视觉合同见 DESIGN.md §2 的 Windows taskbar attention badge。
const BADGE_COLORS = { background: '#D91F37', foreground: '#FFFFFF' } as const;
const SCALE_FACTORS = [1, 1.25, 1.5, 2, 3] as const;

export function renderWindowsBadgePng(count: number, scaleFactor: number): Buffer {
  // 已随正式包附带的 N-API canvas；只在绘制时加载，macOS 启动不加载原生绘图库。
  const { createCanvas } = requireFromMain('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
  const size = Math.round(16 * scaleFactor);
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.scale(scaleFactor, scaleFactor);
  const label = count > 99 ? '99+' : String(count);
  ctx.fillStyle = BADGE_COLORS.background;
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, 15, 15, label.length === 1 ? 7.5 : 5);
  ctx.fill();
  // 细白边让角标在深浅任务栏和不同应用图标底色上都有清晰轮廓。
  ctx.strokeStyle = BADGE_COLORS.foreground;
  ctx.lineWidth = 0.75;
  ctx.stroke();
  const fontSize = label.length === 1 ? 12 : label.length === 2 ? 10 : 8;
  ctx.font = `bold ${fontSize}px "Segoe UI", sans-serif`;
  ctx.fillStyle = BADGE_COLORS.foreground;
  ctx.textAlign = 'center';
  const metrics = ctx.measureText(label);
  const baseline = 8 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
  ctx.fillText(label, 8, baseline, 13);
  return canvas.toBuffer('image/png');
}

export function createWindowsBadgeIcon(count: number): NativeImage | null {
  if (count <= 0) return null;
  const icon = nativeImage.createEmpty();
  for (const scaleFactor of SCALE_FACTORS) {
    icon.addRepresentation({
      scaleFactor,
      dataURL: `data:image/png;base64,${renderWindowsBadgePng(count, scaleFactor).toString('base64')}`,
    });
  }
  return icon;
}
