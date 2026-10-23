import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, ensureConfigExists, loadConfig, saveConfig, type BeautifulConfig } from "./config.ts";
import { installEditor } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { installHeader } from "./header.ts";
import { registerSettingsCommand } from "./settings-command.ts";
import { createInitialState, invalidateUsageCache, getModelMeta, type FooterState } from "./state.ts";
import { getStyle, getStylePaint } from "./styles.ts";
import { formatTurnTelemetry, TurnTelemetryTracker } from "./telemetry.ts";

/** Footer timer displays whole seconds, so sub-second wakeups provide no visible benefit. */
const FOOTER_REFRESH_INTERVAL_MS = 1000;

function isInteractiveLaunch(): boolean {
	if (!process.stdout.isTTY) return false;
	const args = process.argv.slice(2);
	const nonInteractiveFlags = ["-p", "--print", "--help", "-h", "--version", "-v", "--list-models", "--export"];
	for (const arg of args) {
		if (nonInteractiveFlags.includes(arg)) return false;
		if (arg.startsWith("--mode")) return false;
	}
	return true;
}

function clearVisibleScreen(): void {
	if (process.stdout.isTTY) {
		process.stdout.write("\x1b[2J\x1b[H");
	}
}

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	const state: FooterState = createInitialState();
	const turnTelemetry = new TurnTelemetryTracker();

	let config: BeautifulConfig = structuredClone(DEFAULT_CONFIG);
	let active = false;
	let lastCtx: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	let cleanupHeader: (() => void) | undefined;
	let cleanupFooter: (() => void) | undefined;
	let cleanupEditor: (() => void) | undefined;

	const getThinkingLevel = () => pi.getThinkingLevel();

	const applyWorkingIndicator = (ctx: ExtensionContext) => {
		const style = getStyle(config.style);
		const paint = getStylePaint(ctx.ui.theme, style);
		ctx.ui.setWorkingIndicator({
			frames: style.workingIndicator.frames.map((frame) => paint.accent(frame)),
			intervalMs: style.workingIndicator.intervalMs,
		});
	};

	const applyUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (!config.enabled) {
			uninstallUi(ctx);
			return;
		}
		if (!active) {
			cleanupHeader = installHeader(pi, ctx, () => config);
			cleanupFooter = installFooter(
				ctx,
				() => state,
				() => config,
				() => getModelMeta(ctx, getThinkingLevel),
				{
					setRequestRender: (fn) => {
						requestFooterRender = fn ?? undefined;
					},
				},
			);
			cleanupEditor = installEditor(pi, ctx, () => config);
			applyWorkingIndicator(ctx);
			active = true;
		}
	};

	const uninstallUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (active) {
			cleanupHeader?.();
			cleanupFooter?.();
			cleanupEditor?.();
			cleanupHeader = undefined;
			cleanupFooter = undefined;
			cleanupEditor = undefined;
			requestFooterRender = undefined;
			ctx.ui.setWorkingIndicator();
			active = false;
		}
	};

	const refreshInteractiveState = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		requestFooterRender?.();
	};

	const startWorkingTimer = () => {
		stopWorkingTimer();
		const tick = () => {
			if (!active) return;
			requestFooterRender?.();
		};
		tick();
		workingTimer = setInterval(tick, FOOTER_REFRESH_INTERVAL_MS);
		workingTimer.unref?.();
	};

	const stopWorkingTimer = () => {
		if (workingTimer) {
			clearInterval(workingTimer);
			workingTimer = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		state.sessionStartEpoch = Date.now();
		state.workingSince = undefined;
		state.lastDoneIn = undefined;
		invalidateUsageCache();

		ensureConfigExists();
		config = loadConfig((msg, level) => ctx.ui.notify(msg, level));

		if (isInteractiveLaunch() && config.enabled && isTuiContext(ctx)) {
			clearVisibleScreen();
		}

		applyUi(ctx);
		refreshInteractiveState(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopWorkingTimer();
		if (active) {
			uninstallUi(ctx);
		}
		lastCtx = undefined;
	});

	pi.on("agent_start", (event, _ctx) => {
		turnTelemetry.handle(event);
		state.workingSince = Date.now();
		state.lastDoneIn = undefined;
		startWorkingTimer();
	});

	pi.on("agent_end", (_event, _ctx) => {
		stopWorkingTimer();
		if (state.workingSince !== undefined) {
			state.lastDoneIn = Date.now() - state.workingSince;
			state.workingSince = undefined;
		}
		requestFooterRender?.();
	});

	pi.on("model_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("turn_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_update", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("tool_execution_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("turn_end", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_end", (event, ctx) => {
		turnTelemetry.handle(event);
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("agent_settled", (event, ctx) => {
		const telemetry = turnTelemetry.handle(event);
		if (!telemetry || !config.enabled || !config.telemetry.enabled || !isTuiContext(ctx)) return;
		const message = formatTurnTelemetry(telemetry, ctx.ui.theme, config.telemetry);
		if (message) ctx.ui.notify(message, "info");
	});

	pi.on("session_compact", (_event, ctx) => {
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (newConfig) => {
			const wasEnabled = config.enabled;
			saveConfig(newConfig);
			config = newConfig;
			if (lastCtx && wasEnabled !== newConfig.enabled) {
				if (newConfig.enabled) {
					applyUi(lastCtx);
				} else {
					uninstallUi(lastCtx);
				}
			} else if (lastCtx && active) {
				applyWorkingIndicator(lastCtx);
			}
			requestFooterRender?.();
		},
	});
}