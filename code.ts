figma.showUI(__html__, { width: 420, height: 900 });

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
	fingerprint: string;
};

type ScreenSummary = {
	selectionCount: number;
	nodes: ExtractedNode[];
};

type DemandMode = "on_demand" | "low_demand" | "always_visible";
type UiMode = "debug" | "real";

const DEFAULT_DEMAND_MODE: DemandMode = "on_demand";
const DEFAULT_UI_MODE: UiMode = "real";

function getFileKey(): string {
	return figma.fileKey || "unknown-file";
}

function isDemandMode(value: unknown): value is DemandMode {
	return (
		value === "on_demand" ||
		value === "low_demand" ||
		value === "always_visible"
	);
}

function isUiMode(value: unknown): value is UiMode {
	return value === "debug" || value === "real";
}

async function getDemandMode(): Promise<DemandMode> {
	const existing = await figma.clientStorage.getAsync("demand_mode");
	if (isDemandMode(existing)) {
		return existing;
	}

	await figma.clientStorage.setAsync("demand_mode", DEFAULT_DEMAND_MODE);
	return DEFAULT_DEMAND_MODE;
}

async function setDemandMode(mode: DemandMode): Promise<void> {
	await figma.clientStorage.setAsync("demand_mode", mode);
}

async function getUiMode(): Promise<UiMode> {
	const existing = await figma.clientStorage.getAsync("ui_mode");
	if (isUiMode(existing)) {
		return existing;
	}

	await figma.clientStorage.setAsync("ui_mode", DEFAULT_UI_MODE);
	return DEFAULT_UI_MODE;
}

async function setUiMode(mode: UiMode): Promise<void> {
	await figma.clientStorage.setAsync("ui_mode", mode);
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

function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function getNodeText(node: SceneNode): string | undefined {
	if (node.type !== "TEXT") return undefined;
	return normalizeText(node.characters || "");
}

function getNodeFontSize(
	node: SceneNode,
): number | typeof figma.mixed | undefined {
	if (node.type !== "TEXT") return undefined;
	return node.fontSize;
}

function extractFills(node: SceneNode): string[] {
	if (!("fills" in node)) return [];
	if (node.fills === figma.mixed || !Array.isArray(node.fills)) return [];

	return node.fills
		.filter((fill): fill is SolidPaint => fill.type === "SOLID")
		.map((fill) => rgbToHex(fill.color));
}

function simpleHash(input: string): string {
	let hash = 0;

	for (let i = 0; i < input.length; i += 1) {
		hash = (hash << 5) - hash + input.charCodeAt(i);
		hash |= 0;
	}

	return String(hash);
}

function createNodeFingerprint(node: SceneNode): string {
	const text = getNodeText(node);
	const fontSize = getNodeFontSize(node);
	const fills = extractFills(node);

	const fingerprintPayload = {
		id: node.id,
		name: node.name,
		type: node.type,
		visible: node.visible,
		width: "width" in node ? Math.round(node.width) : undefined,
		height: "height" in node ? Math.round(node.height) : undefined,
		x: "x" in node ? Math.round(node.x) : undefined,
		y: "y" in node ? Math.round(node.y) : undefined,
		text,
		fontSize: typeof fontSize === "number" ? fontSize : String(fontSize),
		fills,
	};

	return simpleHash(JSON.stringify(fingerprintPayload));
}

function extractNode(node: SceneNode): ExtractedNode {
	const base: ExtractedNode = {
		id: node.id,
		name: node.name,
		type: node.type,
		visible: node.visible,
		fingerprint: createNodeFingerprint(node),
	};

	if ("width" in node) base.width = Math.round(node.width);
	if ("height" in node) base.height = Math.round(node.height);
	if ("x" in node) base.x = Math.round(node.x);
	if ("y" in node) base.y = Math.round(node.y);

	base.fills = extractFills(node);

	if (node.type === "TEXT") {
		base.text = normalizeText(node.characters);
		base.fontSize = node.fontSize;
	}

	return base;
}

function collectSelectionData(): ScreenSummary {
	const selection = figma.currentPage.selection;
	const nodes: ExtractedNode[] = [];
	const seenIds = new Set<string>();

	function pushNode(node: SceneNode) {
		if (seenIds.has(node.id)) return;
		seenIds.add(node.id);
		nodes.push(extractNode(node));
	}

	for (const selectedNode of selection) {
		pushNode(selectedNode);

		if ("findAll" in selectedNode) {
			const descendants = selectedNode.findAll(() => true);
			for (const child of descendants) {
				pushNode(child);
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
	const uiMode = await getUiMode();

	figma.ui.postMessage({
		type: "selection-data",
		payload: data,
	});

	figma.ui.postMessage({
		type: "user-id",
		payload: { userId },
	});

	figma.ui.postMessage({
		type: "ui-mode",
		payload: { mode: uiMode },
	});

	figma.ui.postMessage({
		type: "demand-mode",
		payload: { mode: demandMode },
	});
}

async function findSceneNodeById(nodeId: string): Promise<SceneNode | null> {
	const node = await figma.getNodeByIdAsync(nodeId);

	if (!node) return null;
	if (node.type === "PAGE" || node.type === "DOCUMENT") return null;

	return node as SceneNode;
}

function getContainingPage(node: BaseNode): PageNode | null {
	let current: BaseNode | null = node;

	while (current) {
		if (current.type === "PAGE") {
			return current as PageNode;
		}
		current = current.parent;
	}

	return null;
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
		const uiMode = await getUiMode();
		const fileKey = getFileKey();

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
					"X-UI-Mode": uiMode,
					"X-Demand-Mode": demandMode,
					"X-File-Key": fileKey,
				},
				body: JSON.stringify({
					screen: data,
					meta: {
						sessionId,
						userId,
						condition,
						uiMode,
						demandMode,
						fileKey,
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
			const uiMode = await getUiMode();
			const fileKey = getFileKey();

			await fetch("http://localhost:3001/log", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Session-Id": msg.sessionId || "unknown",
					"X-User-Id": msg.userId || (await getOrCreateUserId()),
					"X-Condition": msg.condition || "unknown",
					"X-UI-Mode": uiMode,
					"X-Demand-Mode": demandMode,
					"X-File-Key": fileKey,
				},
				body: JSON.stringify(
					Object.assign({}, msg.event, {
						uiMode,
						demandMode,
						fileKey,
					}),
				),
			});
		} catch (error) {
			console.error("Failed to log event:", error);
		}

		return;
	}

	if (msg.type === "set-demand-mode") {
		const uiMode = await getUiMode();

		if (uiMode === "real") {
			const lockedMode = await getDemandMode();
			figma.ui.postMessage({
				type: "demand-mode",
				payload: { mode: lockedMode },
			});
			return;
		}

		const newMode = msg.mode;
		const previousMode = await getDemandMode();
		const userId = await getOrCreateUserId();

		if (!isDemandMode(newMode)) {
			return;
		}

		if (newMode === previousMode) {
			return;
		}

		await setDemandMode(newMode);

		figma.ui.postMessage({
			type: "demand-mode",
			payload: { mode: newMode },
		});

		try {
			await fetch("http://localhost:3001/log", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Session-Id": msg.sessionId || "unknown",
					"X-User-Id": msg.userId || userId,
					"X-Condition": msg.condition || "unknown",
					"X-UI-Mode": uiMode,
					"X-Demand-Mode": newMode,
					"X-File-Key": getFileKey(),
				},
				body: JSON.stringify({
					eventType: "demand_mode_changed",
					fromMode: previousMode,
					toMode: newMode,
					trigger: msg.reason || "manual_settings_toggle",
					timestamp: new Date().toISOString(),
					fileKey: getFileKey(),
				}),
			});
		} catch (error) {
			console.error("Failed to log demand mode change:", error);
		}

		return;
	}

	if (msg.type === "set-ui-mode") {
		const newMode = msg.mode;

		if (!isUiMode(newMode)) {
			return;
		}

		await setUiMode(newMode);

		figma.ui.postMessage({
			type: "ui-mode",
			payload: { mode: newMode },
		});

		return;
	}

	if (msg.type === "select-issue-node") {
		try {
			const nodeId = typeof msg.nodeId === "string" ? msg.nodeId : "";

			if (!nodeId) {
				return;
			}

			const node = await findSceneNodeById(nodeId);

			if (!node) {
				figma.ui.postMessage({
					type: "status",
					payload: {
						message:
							"Could not find that layer in the current file.",
					},
				});
				return;
			}

			const containingPage = getContainingPage(node);

			if (containingPage && figma.currentPage.id !== containingPage.id) {
				await figma.setCurrentPageAsync(containingPage);
			}

			figma.currentPage.selection = [node];
			figma.viewport.scrollAndZoomIntoView([node]);

			figma.ui.postMessage({
				type: "status",
				payload: { message: `Selected: ${node.name}` },
			});
		} catch (error) {
			console.error("Failed to select issue node:", error);

			figma.ui.postMessage({
				type: "check-error",
				payload: {
					message:
						error instanceof Error
							? error.message
							: "Unknown selection error",
				},
			});
		}

		return;
	}

	if (msg.type === "close") {
		figma.closePlugin();
		return;
	}

	if (msg.type === "dismiss-issue") {
		try {
			const demandMode = await getDemandMode();
			const uiMode = await getUiMode();
			const fileKey = getFileKey();

			const response = await fetch(
				"http://localhost:3001/dismiss-issue",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Session-Id": msg.sessionId || "unknown",
						"X-User-Id": msg.userId || (await getOrCreateUserId()),
						"X-Condition": msg.condition || "unknown",
						"X-UI-Mode": uiMode,
						"X-Demand-Mode": demandMode,
						"X-File-Key": fileKey,
					},
					body: JSON.stringify({
						issue: msg.issue,
						fileKey,
						nodeFingerprint: msg.nodeFingerprint || null,
					}),
				},
			);

			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Dismiss error ${response.status}: ${text}`);
			}

			figma.ui.postMessage({
				type: "issue-dismissed",
				payload: {
					issueType: msg.issue.issue_type,
					nodeId: msg.issue.node_id,
				},
			});
		} catch (error) {
			console.error("Failed to dismiss issue:", error);

			figma.ui.postMessage({
				type: "check-error",
				payload: {
					message:
						error instanceof Error
							? error.message
							: "Unknown dismiss error",
				},
			});
		}

		return;
	}

	if (msg.type === "reset-dismissed-issues") {
		try {
			const demandMode = await getDemandMode();
			const uiMode = await getUiMode();
			const fileKey = getFileKey();

			const response = await fetch(
				"http://localhost:3001/reset-dismissed-issues",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Session-Id": msg.sessionId || "unknown",
						"X-User-Id": msg.userId || (await getOrCreateUserId()),
						"X-Condition": msg.condition || "unknown",
						"X-UI-Mode": uiMode,
						"X-Demand-Mode": demandMode,
						"X-File-Key": fileKey,
					},
					body: JSON.stringify({ fileKey }),
				},
			);

			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Reset error ${response.status}: ${text}`);
			}

			figma.ui.postMessage({
				type: "dismissed-issues-reset",
				payload: { ok: true },
			});
		} catch (error) {
			console.error("Failed to reset dismissed issues:", error);

			figma.ui.postMessage({
				type: "check-error",
				payload: {
					message:
						error instanceof Error
							? error.message
							: "Unknown reset error",
				},
			});
		}

		return;
	}
};

void sendSelectionToUI();
