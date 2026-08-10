import type {
  IOSSimulatorDiscreteInputDriver,
  IOSSimulatorDriverCapabilities,
  IOSSimulatorJpegStreamDriver,
  IOSSimulatorNativeSidecarDriver,
  IOSSimulatorSemanticDriver,
} from "./driver.js";
import type { IOSSimulatorNativeCapabilityAdmissionDecision } from "./capability-admission.js";

export type IOSSimulatorStreamEncoding = "jpeg" | "h264" | "bgra";

export interface IOSSimulatorDriverRoute {
  selected: "wda" | "native-sidecar";
  fallback: boolean;
  reason: string | null;
}

export interface IOSSimulatorDriverCapabilityReport {
  generatedAt: string;
  semantic: {
    adapter: "wda";
    capabilities: Readonly<IOSSimulatorDriverCapabilities>;
  };
  jpegStream: {
    adapter: "wda";
    capabilities: Readonly<IOSSimulatorDriverCapabilities>;
  };
  nativeSidecar: {
    available: boolean;
    capabilities: Readonly<IOSSimulatorDriverCapabilities> | null;
    simulatorUdid: string | null;
    generation: number | null;
    reason: string | null;
    admission: IOSSimulatorNativeCapabilityAdmissionDecision | null;
  };
  routes: {
    discreteInput: IOSSimulatorDriverRoute;
    continuousInput: IOSSimulatorDriverRoute;
    stream: Record<IOSSimulatorStreamEncoding, IOSSimulatorDriverRoute>;
  };
}

export type IOSSimulatorStreamRoute =
  | {
      adapter: "wda";
      fallback: boolean;
      reason: string | null;
      source: IOSSimulatorJpegStreamDriver;
    }
  | {
      adapter: "native-sidecar";
      fallback: false;
      reason: null;
      source: IOSSimulatorNativeSidecarDriver;
    };

export interface IOSSimulatorDriverRouterOptions {
  semantic: IOSSimulatorSemanticDriver;
  discreteInput: IOSSimulatorDiscreteInputDriver;
  jpegStream: IOSSimulatorJpegStreamDriver;
  nativeSidecar?: IOSSimulatorNativeSidecarDriver | null;
  nativeUnavailableReason?: string | null;
  isNativeSidecarAvailable?: () => boolean;
  nativeAdmission?: () => IOSSimulatorNativeCapabilityAdmissionDecision | null;
  now?: () => Date;
}

/**
 * Chooses an adapter by capability while keeping policy, ownership and
 * generation checks in the main host. WDA remains the deterministic default.
 */
export class IOSSimulatorDriverRouter {
  readonly #semantic: IOSSimulatorSemanticDriver;
  readonly #discreteInput: IOSSimulatorDiscreteInputDriver;
  readonly #jpegStream: IOSSimulatorJpegStreamDriver;
  readonly #nativeSidecar: IOSSimulatorNativeSidecarDriver | null;
  readonly #nativeUnavailableReason: string;
  readonly #isNativeSidecarAvailable: () => boolean;
  readonly #nativeAdmission: () => IOSSimulatorNativeCapabilityAdmissionDecision | null;
  readonly #now: () => Date;

  constructor(options: IOSSimulatorDriverRouterOptions) {
    this.#semantic = options.semantic;
    this.#discreteInput = options.discreteInput;
    this.#jpegStream = options.jpegStream;
    this.#nativeSidecar = options.nativeSidecar ?? null;
    this.#nativeUnavailableReason =
      options.nativeUnavailableReason?.trim() ||
      "Native sidecar is not configured.";
    this.#isNativeSidecarAvailable =
      options.isNativeSidecarAvailable ?? (() => true);
    this.#nativeAdmission = options.nativeAdmission ?? (() => null);
    this.#now = options.now ?? (() => new Date());
  }

  semantic(): IOSSimulatorSemanticDriver {
    return this.#semantic;
  }

  discreteInput(): IOSSimulatorDiscreteInputDriver {
    return this.#discreteInput;
  }

  continuousInput(): IOSSimulatorNativeSidecarDriver | null {
    const native = this.#availableNativeSidecar();
    if (
      !native?.capabilities.continuousInput ||
      !this.#isCapabilityAdmitted("continuousInput")
    ) {
      return null;
    }
    return native;
  }

  stream(encoding: IOSSimulatorStreamEncoding): IOSSimulatorStreamRoute {
    if (encoding === "jpeg") {
      return {
        adapter: "wda",
        fallback: false,
        reason: null,
        source: this.#jpegStream,
      };
    }
    const native = this.#availableNativeSidecar();
    const supported =
      encoding === "h264"
        ? native?.capabilities.h264Stream
        : native?.capabilities.bgraStream;
    const admitted = this.#isCapabilityAdmitted(
      encoding === "h264" ? "h264Stream" : "bgraStream",
    );
    if (native && supported && admitted) {
      return {
        adapter: "native-sidecar",
        fallback: false,
        reason: null,
        source: native,
      };
    }
    return {
      adapter: "wda",
      fallback: true,
      reason:
        this.#capabilityAdmissionReason(
          encoding === "h264" ? "h264Stream" : "bgraStream",
        ) ??
        (native
          ? `Native sidecar does not advertise ${encoding} stream capability.`
          : this.#nativeSidecar
            ? "Native sidecar process is not running."
            : this.#nativeUnavailableReason),
      source: this.#jpegStream,
    };
  }

  capabilityReport(): IOSSimulatorDriverCapabilityReport {
    const configuredNative = this.#nativeSidecar;
    const native = this.#availableNativeSidecar();
    const admission = this.#nativeAdmission();
    const continuousInput = Boolean(
      native?.capabilities.continuousInput &&
      this.#isCapabilityAdmitted("continuousInput"),
    );
    const streamRoute = (
      encoding: IOSSimulatorStreamEncoding,
    ): IOSSimulatorDriverRoute => {
      const route = this.stream(encoding);
      return {
        selected: route.adapter,
        fallback: route.fallback,
        reason: route.reason,
      };
    };
    return {
      generatedAt: this.#now().toISOString(),
      semantic: {
        adapter: "wda",
        capabilities: this.#semantic.capabilities,
      },
      jpegStream: {
        adapter: "wda",
        capabilities: this.#jpegStream.capabilities,
      },
      nativeSidecar: {
        available: native !== null,
        capabilities: native?.capabilities ?? null,
        simulatorUdid: native?.simulatorUdid ?? null,
        generation: native?.generation ?? null,
        reason: native
          ? null
          : configuredNative
            ? "Native sidecar process is not running."
            : this.#nativeUnavailableReason,
        admission,
      },
      routes: {
        discreteInput: {
          selected: "wda",
          fallback: false,
          reason: null,
        },
        continuousInput: {
          selected: continuousInput ? "native-sidecar" : "wda",
          fallback: !continuousInput,
          reason: continuousInput
            ? null
            : (this.#capabilityAdmissionReason("continuousInput") ??
              "Continuous native HID is unavailable; discrete WDA input remains available."),
        },
        stream: {
          jpeg: streamRoute("jpeg"),
          h264: streamRoute("h264"),
          bgra: streamRoute("bgra"),
        },
      },
    };
  }

  #availableNativeSidecar(): IOSSimulatorNativeSidecarDriver | null {
    const native = this.#nativeSidecar;
    if (!native || !this.#isNativeSidecarAvailable()) return null;
    return native;
  }

  #isCapabilityAdmitted(
    capability: "h264Stream" | "bgraStream" | "continuousInput" | "multiTouch",
  ): boolean {
    const admission = this.#nativeAdmission();
    return admission ? admission.capabilities[capability].active : true;
  }

  #capabilityAdmissionReason(
    capability: "h264Stream" | "bgraStream" | "continuousInput" | "multiTouch",
  ): string | null {
    const admission = this.#nativeAdmission();
    if (!admission || admission.capabilities[capability].active) return null;
    return admission.capabilities[capability].reason;
  }
}
