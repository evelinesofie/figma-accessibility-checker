figma.showUI(__html__, { width: 420, height: 700 });

type ExtractedNode = {
	id: string;
	name: string;
	type: string;
	visible: boolean;
	width?: number;
	height?: number;
	x?: number;
	y?: number;
	text?: string;
	fontSize?: number | typeof figma.mixed;
	fills?: string[];
};

type ScreenSummary = {
	selectionCount: number;
	nodes: ExtractedNode[];
};

type DemandMode = "always" | "on_demand";

async function getDemandMode(): Promise<DemandMode> {
	const existing = await figma.clientStorage.getAsync("demand_mode");
	if (existing === "always" || existing === "on_demand") {
		return existing;
	}

	const defaultMode: DemandMode = "on_demand";
	await figma.clientStorage.setAsync("demand_mode", defaultMode);
	return defaultMode;
}

async function setDemandMode(mode: DemandMode): Promise<void> {
	await figma.clientStorage.setAsync("demand_mode", mode);
}

function createId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

async function getOrCreateUserId(): Promise<string> {
	const existing = await figma.clientStorage.getAsync("user_id");
	if (existing) return existing;

	const newUserId = createId("user");
	await figma.clientStorage.setAsync("user_id", newUserId);
	return newUserId;
}

function rgbToHex(color: RGB): string {
	const toHex = (value: number) =>
		Math.round(value * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function extractFills(node: SceneNode): string[] {
	if (!("fills" in node)) return [];
	if (node.fills === figma.mixed || !Array.isArray(node.fills)) return [];

	return node.fills
		.filter((fill) => fill.type === "SOLID")
		.map((fill) => rgbToHex(fill.color));
}

function extractNode(node: SceneNode): ExtractedNode {
	const base: ExtractedNode = {
		id: node.id,
		name: node.name,
		type: node.type,
		visible: node.visible,
	};

	if ("width" in node) base.width = Math.round(node.width);
	if ("height" in node) base.height = Math.round(node.height);
	if ("x" in node) base.x = Math.round(node.x);
	if ("y" in node) base.y = Math.round(node.y);

	base.fills = extractFills(node);

	if (node.type === "TEXT") {
		base.text = node.characters.slice(0, 200);
		base.fontSize = node.fontSize;
	}

	return base;
}

function collectSelectionData(): ScreenSummary {
	const selection = figma.currentPage.selection;
	const nodes: ExtractedNode[] = [];

	for (const selectedNode of selection) {
		nodes.push(extractNode(selectedNode));

		if ("findAll" in selectedNode) {
			const descendants = selectedNode.findAll(() => true);
			for (const child of descendants) {
				nodes.push(extractNode(child));
			}
		}
	}

	return {
		selectionCount: selection.length,
		nodes,
	};
}

async function sendSelectionToUI() {
	const data = collectSelectionData();
	const userId = await getOrCreateUserId();
	const demandMode = await getDemandMode();

	figma.ui.postMessage({
		type: "selection-data",
		payload: data,
	});

	figma.ui.postMessage({
		type: "user-id",
		payload: { userId },
	});

	figma.ui.postMessage({
		type: "demand-mode",
		payload: { mode: demandMode },
	});
}

figma.on("selectionchange", async () => {
	await sendSelectionToUI();
});

figma.ui.onmessage = async (msg) => {
	console.log("CODE got message:", JSON.stringify(msg));
	if (msg.type === "run-gpt-check") {
		const data = collectSelectionData();
		const sessionId = msg.sessionId || "unknown";
		const userId = await getOrCreateUserId();
		const condition = msg.condition || "unknown";
		const demandMode = await getDemandMode();

		figma.ui.postMessage({
			type: "status",
			payload: { message: "Sending screen data to backend..." },
		});

		try {
			const response = await fetch("http://localhost:3001/analyze", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Session-Id": sessionId,
					"X-User-Id": userId,
					"X-Condition": condition,
					"X-Demand-Mode": demandMode,
				},
				body: JSON.stringify({
					screen: data,
					meta: {
						sessionId,
						userId,
						condition,
						demandMode,
					},
				}),
			});

			if (!response.ok) {
				const text = await response.text();
				console.log("Raw backend error:", text);
				throw new Error(`Backend error ${response.status}: ${text}`);
			}

			const result = await response.json();

			figma.ui.postMessage({
				type: "check-results",
				payload: result,
			});
		} catch (error) {
			figma.ui.postMessage({
				type: "check-error",
				payload: {
					message:
						error instanceof Error
							? error.message
							: "Unknown backend error",
				},
			});
		}

		return;
	}

	if (msg.type === "log-event") {
		try {
			const demandMode = await getDemandMode();

			await fetch("http://localhost:3001/log", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Session-Id": msg.sessionId || "unknown",
					"X-User-Id": msg.userId || (await getOrCreateUserId()),
					"X-Condition": msg.condition || "unknown",
					"X-Demand-Mode": demandMode,
				},
				body: JSON.stringify(
					Object.assign({}, msg.event, { demandMode }),
				),
			});
		} catch (error) {
			console.error("Failed to log event:", error);
		}

		return;
	}

	if (msg.type === "set-demand-mode") {
		console.log("SET DEMAND MODE HIT:", msg.mode);
		const newMode = msg.mode as DemandMode;
		const previousMode = await getDemandMode();
		const userId = await getOrCreateUserId();

		if (newMode !== "always" && newMode !== "on_demand") {
			return;
		}

		if (newMode === previousMode) {
			return;
		}

		await setDemandMode(newMode);
		await sendSelectionToUI();

		try {
			await fetch("http://localhost:3001/log", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Session-Id": msg.sessionId || "unknown",
					"X-User-Id": msg.userId || userId,
					"X-Condition": msg.condition || "unknown",
					"X-Demand-Mode": newMode,
				},
				body: JSON.stringify({
					eventType: "demand_mode_changed",
					fromMode: previousMode,
					toMode: newMode,
					trigger: msg.reason || "manual_settings_toggle",
					timestamp: new Date().toISOString(),
				}),
			});
		} catch (error) {
			console.error("Failed to log demand mode change:", error);
		}

		return;
	}

	if (msg.type === "close") {
		figma.closePlugin();
	}
};

void sendSelectionToUI();
