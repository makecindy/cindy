import { useCallback, useEffect, useRef, useState } from 'react';

import {
  MAX_XCODE_BUILD_OUTPUT_CHARS,
  type XcodeBuildDestination,
  type XcodeBuildEvent,
  type XcodeBuildState,
  type XcodeProjectContainer,
  type XcodeProjectDiscovery,
} from '../../../../../shared/xcodeBuild';
import { extractIpcError } from '@/utils/ipcError';

interface UseXcodeBuildOptions {
  sessionId: string | null;
  workdir: string;
  enabled: boolean;
}

export interface UseXcodeBuildReturn {
  available: boolean;
  loading: boolean;
  error: string | null;
  projects: XcodeProjectContainer[];
  selectedContainerPath: string | null;
  schemes: string[];
  selectedScheme: string | null;
  destinations: XcodeBuildDestination[];
  selectedDestination: XcodeBuildDestination | null;
  build: XcodeBuildState | null;
  output: string;
  outputExpanded: boolean;
  selectProject: (containerPath: string) => Promise<void>;
  selectScheme: (scheme: string) => Promise<void>;
  selectDestination: (destinationId: string) => void;
  startBuild: () => Promise<boolean>;
  stopBuild: () => Promise<void>;
  hotReload: () => Promise<void>;
  hotRestart: () => Promise<void>;
  toggleOutput: () => void;
}

function boundedOutput(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_XCODE_BUILD_OUTPUT_CHARS
    ? next
    : next.slice(next.length - MAX_XCODE_BUILD_OUTPUT_CHARS);
}

function errorMessage(error: unknown): string {
  return (
    extractIpcError(error)?.message ?? (error instanceof Error ? error.message : String(error))
  );
}

export function useXcodeBuild({
  sessionId,
  workdir,
  enabled,
}: UseXcodeBuildOptions): UseXcodeBuildReturn {
  const [discovery, setDiscovery] = useState<XcodeProjectDiscovery | null>(null);
  const [selectedDestinationId, setSelectedDestinationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [build, setBuild] = useState<XcodeBuildState | null>(null);
  const [output, setOutput] = useState('');
  const [outputExpanded, setOutputExpanded] = useState(false);
  const requestSequence = useRef(0);
  const currentBuild = useRef<XcodeBuildState | null>(null);
  const startingBuild = useRef(false);
  const currentWorkdir = useRef(workdir);
  const pendingOutput = useRef(new Map<string, string>());
  currentWorkdir.current = workdir;
  currentBuild.current = build;

  const applyBuild = useCallback((next: XcodeBuildState, restoredOutput?: string) => {
    currentBuild.current = next;
    setBuild(next);
    if (restoredOutput !== undefined) setOutput(restoredOutput);
  }, []);

  const loadDiscovery = useCallback(
    async (containerPath?: string | null, scheme?: string | null) => {
      if (!enabled || !sessionId || !workdir || !window.electronAPI.xcode) return;
      const sequence = ++requestSequence.current;
      setLoading(true);
      setError(null);
      try {
        const next = await window.electronAPI.xcode.discover({
          sessionId,
          workdir,
          containerPath: containerPath ?? null,
          scheme: scheme ?? null,
        });
        if (sequence !== requestSequence.current) return;
        setDiscovery(next);
        setSelectedDestinationId((current) =>
          current && next.destinations.some((destination) => destination.id === current)
            ? current
            : (next.destinations[0]?.id ?? null),
        );
        if (next.status === 'error' && next.error) setError(next.error);
      } catch (loadError) {
        if (sequence !== requestSequence.current) return;
        setError(errorMessage(loadError));
        setDiscovery(null);
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    },
    [enabled, sessionId, workdir],
  );

  useEffect(() => {
    requestSequence.current += 1;
    setDiscovery(null);
    setSelectedDestinationId(null);
    setError(null);
    setOutputExpanded(false);
    setBuild(null);
    setOutput('');
    currentBuild.current = null;
    startingBuild.current = false;
    pendingOutput.current.clear();
    if (!enabled || !sessionId || !workdir || !window.electronAPI.xcode) {
      setLoading(false);
      return;
    }
    void loadDiscovery();
  }, [enabled, loadDiscovery, sessionId, workdir]);

  useEffect(() => {
    if (!enabled || !sessionId || !workdir || !window.electronAPI.xcode) return;
    let cancelled = false;
    void window.electronAPI.xcode
      .getStatus({ sessionId, workdir })
      .then((result) => {
        if (cancelled || currentBuild.current || !result.state) return;
        applyBuild(result.state, result.output);
        setOutputExpanded(result.state.status === 'running');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [applyBuild, enabled, sessionId, workdir]);

  useEffect(() => {
    if (!enabled || !window.electronAPI.xcode) return;
    return window.electronAPI.xcode.onEvent((event: XcodeBuildEvent) => {
      if (event.type === 'state') {
        if (event.state.workdir !== currentWorkdir.current) return;
        const pending = pendingOutput.current.get(event.state.buildId);
        if (pending !== undefined) {
          pendingOutput.current.delete(event.state.buildId);
          setOutput(pending);
        }
        applyBuild(event.state);
        return;
      }
      const active = currentBuild.current;
      if (!active) {
        if (!startingBuild.current) return;
        const previous = pendingOutput.current.get(event.buildId) ?? '';
        pendingOutput.current.set(event.buildId, boundedOutput(previous, event.chunk));
        return;
      }
      if (active.buildId !== event.buildId) return;
      setOutput((current) => boundedOutput(current, event.chunk));
    });
  }, [applyBuild, enabled]);

  const selectProject = useCallback(
    async (containerPath: string) => {
      await loadDiscovery(containerPath, null);
    },
    [loadDiscovery],
  );

  const selectScheme = useCallback(
    async (scheme: string) => {
      await loadDiscovery(discovery?.selectedContainerPath, scheme);
    },
    [discovery?.selectedContainerPath, loadDiscovery],
  );

  const selectDestination = useCallback((destinationId: string) => {
    setSelectedDestinationId(destinationId);
  }, []);

  const startBuild = useCallback(async (): Promise<boolean> => {
    const containerPath = discovery?.selectedContainerPath;
    const scheme = discovery?.selectedScheme;
    const destination = discovery?.destinations.find(
      (candidate) => candidate.id === selectedDestinationId,
    );
    const project = discovery?.projects.find(
      (candidate) => candidate.containerPath === containerPath,
    );
    if (!project || !scheme || !destination || !sessionId || !window.electronAPI.xcode) {
      return false;
    }
    setError(null);
    setOutput('');
    setOutputExpanded(true);
    pendingOutput.current.clear();
    startingBuild.current = true;
    try {
      const state = await window.electronAPI.xcode.start({
        sessionId,
        workdir,
        containerPath: project.containerPath,
        containerKind: project.containerKind,
        scheme,
        destinationId: destination.id,
        destinationPlatform: destination.platform,
        destinationName: destination.name,
        destinationOsVersion: destination.osVersion,
      });
      const pending = pendingOutput.current.get(state.buildId);
      if (pending !== undefined) {
        pendingOutput.current.delete(state.buildId);
        setOutput(pending);
      }
      if (currentBuild.current?.buildId !== state.buildId) applyBuild(state);
      return true;
    } catch (startError) {
      setError(errorMessage(startError));
      return false;
    } finally {
      startingBuild.current = false;
    }
  }, [applyBuild, discovery, selectedDestinationId, sessionId, workdir]);

  const stopBuild = useCallback(async () => {
    const active = currentBuild.current;
    if (!active || !window.electronAPI.xcode) return;
    try {
      await window.electronAPI.xcode.stop(active.buildId);
    } catch (stopError) {
      setError(errorMessage(stopError));
    }
  }, []);

  const runFlutterAction = useCallback(async (action: 'reload' | 'restart') => {
    const active = currentBuild.current;
    if (!active || !window.electronAPI.xcode) return;
    try {
      await window.electronAPI.xcode.flutterAction(active.buildId, action);
    } catch (actionError) {
      setError(errorMessage(actionError));
    }
  }, []);

  const selectedDestination =
    discovery?.destinations.find((destination) => destination.id === selectedDestinationId) ?? null;

  return {
    available: discovery?.status === 'available',
    loading,
    error,
    projects: discovery?.projects ?? [],
    selectedContainerPath: discovery?.selectedContainerPath ?? null,
    schemes: discovery?.schemes ?? [],
    selectedScheme: discovery?.selectedScheme ?? null,
    destinations: discovery?.destinations ?? [],
    selectedDestination,
    build,
    output,
    outputExpanded,
    selectProject,
    selectScheme,
    selectDestination,
    startBuild,
    stopBuild,
    hotReload: () => runFlutterAction('reload'),
    hotRestart: () => runFlutterAction('restart'),
    toggleOutput: () => setOutputExpanded((expanded) => !expanded),
  };
}
