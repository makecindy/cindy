import type { DragEvent } from 'react';
import { finishSessionDrag, startSessionDrag } from '../cc-agent/splitGroupDnd';

export function companionDragProps(route: string | undefined, label: string) {
  if (!route) return {};
  return {
    draggable: true,
    'data-split-group-drag-source': 'true',
    onDragStart: (event: DragEvent) => {
      startSessionDrag(event, {
        sessionId: route,
        label,
        enabled: true,
        needsDedicatedHandle: false,
      });
    },
    onDragEnd: (event: DragEvent) => finishSessionDrag(event, route),
  };
}
