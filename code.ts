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
	fontSize?: number;
	fills?: string[];
	fingerprint: string;
};

type ScreenSummary = {
	selectionCount: number;
	nodes: ExtractedNode[];
};

type DemandMode = "on_demand" | "low_demand" | "always_visible";
type UiMode = "debug" | "real";
type DeviceType = "desktop" | "tablet" | "mobile";

type SelectionImagePayload = {
	imageBase64: string | null;
	mimeType: string;
	source: string;
	error?: string | null;
};

const DEFAULT_DEMAND_MODE: DemandMode = "on_demand";
const DEFAULT_UI_MODE: UiMode = "debug";
const DEFAULT_DEVICE_TYPE: DeviceType = "desktop";
const EXPORT_MAX_WIDTH = 1000;
const TEMP_EXPORT_PADDING = 24;

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

function isDeviceType(value: unknown): value is DeviceType {
	return value === "desktop" || value === "tablet" || value === "mobile";
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

async function getDeviceType(): Promise<DeviceType> {
	const existing = await figma.clientStorage.getAsync("device_type");
	if (isDeviceType(existing)) {
		return existing;
	}

	await figma.clientStorage.setAsync("device_type", DEFAULT_DEVICE_TYPE);
	return DEFAULT_DEVICE_TYPE;
}

async function setDeviceType(deviceType: DeviceType): Promise<void> {
	await figma.clientStorage.setAsync("device_type", deviceType);
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
		base.fontSize =
			typeof node.fontSize === "number" ? node.fontSize : undefined;
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

function canExportNode(node: SceneNode): node is SceneNode & ExportMixin {
	return "exportAsync" in node;
}

function canCloneNode(
	node: SceneNode,
): node is SceneNode & { clone(): SceneNode } {
	return (
		typeof (node as SceneNode & { clone?: () => SceneNode }).clone ===
		"function"
	);
}

async function exportNodeAsPngBase64(node: SceneNode): Promise<string> {
	const nodeName = node.name;
	const nodeType = node.type;

	if (!canExportNode(node)) {
		throw new Error(`Node "${nodeName}" (${nodeType}) is not exportable.`);
	}

	const bytes = await node.exportAsync({
		format: "PNG",
		constraint: { type: "WIDTH", value: EXPORT_MAX_WIDTH },
	});

	return figma.base64Encode(bytes);
}

async function exportMultiSelectionAsPngBase64(
	selection: readonly SceneNode[],
): Promise<string> {
	const exportableNodes = selection.filter(
		(node) => canCloneNode(node) && canExportNode(node),
	);

	if (exportableNodes.length === 0) {
		throw new Error("No selected nodes could be cloned/exported.");
	}

	if (exportableNodes.length === 1) {
		return await exportNodeAsPngBase64(exportableNodes[0]);
	}

	const minX = Math.min(
		...exportableNodes.map((node) => ("x" in node ? node.x : 0)),
	);
	const minY = Math.min(
		...exportableNodes.map((node) => ("y" in node ? node.y : 0)),
	);
	const maxX = Math.max(
		...exportableNodes.map((node) =>
			"x" in node && "width" in node ? node.x + node.width : 0,
		),
	);
	const maxY = Math.max(
		...exportableNodes.map((node) =>
			"y" in node && "height" in node ? node.y + node.height : 0,
		),
	);

	const frame = figma.createFrame();
	frame.name = "__temp_accessibility_export__";
	frame.layoutMode = "NONE";
	frame.clipsContent = false;
	frame.fills = [];
	frame.strokes = [];
	frame.x = minX;
	frame.y = minY;
	frame.resizeWithoutConstraints(
		Math.max(1, Math.ceil(maxX - minX + TEMP_EXPORT_PADDING * 2)),
		Math.max(1, Math.ceil(maxY - minY + TEMP_EXPORT_PADDING * 2)),
	);

	figma.currentPage.appendChild(frame);

	try {
		for (const node of exportableNodes) {
			const clone = node.clone();
			frame.appendChild(clone);

			if ("x" in clone && "x" in node) {
				clone.x = Math.round(node.x - minX + TEMP_EXPORT_PADDING);
			}
			if ("y" in clone && "y" in node) {
				clone.y = Math.round(node.y - minY + TEMP_EXPORT_PADDING);
			}
		}

		const bytes = await frame.exportAsync({
			format: "PNG",
			constraint: { type: "WIDTH", value: EXPORT_MAX_WIDTH },
		});

		return figma.base64Encode(bytes);
	} finally {
		frame.remove();
	}
}

async function buildSelectionImagePayload(): Promise<SelectionImagePayload> {
	const selection = figma.currentPage.selection;

	if (!selection.length) {
		return {
			imageBase64: null,
			mimeType: "image/png",
			source: "no_selection",
			error: "Nothing is selected.",
		};
	}

	try {
		if (selection.length === 1) {
			const imageBase64 = await exportNodeAsPngBase64(selection[0]);
			return {
				imageBase64,
				mimeType: "image/png",
				source: "single_node_export",
				error: null,
			};
		}

		try {
			const imageBase64 =
				await exportMultiSelectionAsPngBase64(selection);
			return {
				imageBase64,
				mimeType: "image/png",
				source: "multi_selection_export",
				error: null,
			};
		} catch (multiError) {
			console.warn(
				"Multi-selection export failed, falling back to first exportable node:",
				multiError,
			);

			const fallbackNode = selection.find(canExportNode);
			if (!fallbackNode) {
				throw multiError;
			}

			const imageBase64 = await exportNodeAsPngBase64(fallbackNode);
			return {
				imageBase64,
				mimeType: "image/png",
				source: "fallback_first_selected_node",
				error:
					multiError instanceof Error
						? `Multi-selection export failed. Fell back to first selected node. ${multiError.message}`
						: "Multi-selection export failed. Fell back to first selected node.",
			};
		}
	} catch (error) {
		return {
			imageBase64: null,
			mimeType: "image/png",
			source: "export_failed",
			error:
				error instanceof Error ? error.message : "Unknown export error",
		};
	}
}

async function sendSelectionToUI() {
	const data = collectSelectionData();
	const imagePayload = await buildSelectionImagePayload();
	const userId = await getOrCreateUserId();
	const demandMode = await getDemandMode();
	const uiMode = await getUiMode();
	const deviceType = await getDeviceType();

	figma.ui.postMessage({
		type: "selection-data",
		payload: data,
	});

	figma.ui.postMessage({
		type: "selection-image",
		payload: imagePayload,
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

	figma.ui.postMessage({
		type: "device-type",
		payload: { deviceType },
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
		const deviceType = await getDeviceType();
		const fileKey = getFileKey();

		figma.ui.postMessage({
			type: "status",
			payload: {
				message: "Preparing screen structure and selection preview...",
			},
		});

		try {
			const selectionImagePayload = await buildSelectionImagePayload();

			figma.ui.postMessage({
				type: "selection-image",
				payload: selectionImagePayload,
			});

			figma.ui.postMessage({
				type: "status",
				payload: {
					message:
						"Sending screen data and preview image to backend...",
				},
			});

			const response = await fetch("http://localhost:3001/analyze", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Session-Id": sessionId,
					"X-User-Id": userId,
					"X-Condition": condition,
					"X-UI-Mode": uiMode,
					"X-Demand-Mode": demandMode,
					"X-Device-Type": deviceType,
					"X-File-Key": fileKey,
				},
				body: JSON.stringify({
					screen: data,
					selectionImage: {
						imageBase64: selectionImagePayload.imageBase64,
						mimeType: selectionImagePayload.mimeType,
						source: selectionImagePayload.source,
						error: selectionImagePayload.error || null,
					},
					meta: {
						sessionId,
						userId,
						condition,
						uiMode,
						demandMode,
						deviceType,
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
			const deviceType = await getDeviceType();
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
					"X-Device-Type": deviceType,
					"X-File-Key": fileKey,
				},
				body: JSON.stringify(
					Object.assign({}, msg.event, {
						uiMode,
						demandMode,
						deviceType,
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
		const deviceType = await getDeviceType();
		const newMode = msg.mode;
		const previousMode = await getDemandMode();
		const userId = await getOrCreateUserId();
		const reason =
			typeof msg.reason === "string"
				? msg.reason
				: "manual_settings_toggle";

		if (!isDemandMode(newMode)) {
			return;
		}

		const isAutomaticAdaptiveChange =
			reason === "threshold_rule_adaptation";

		if (uiMode === "real" && !isAutomaticAdaptiveChange) {
			const lockedMode = await getDemandMode();
			figma.ui.postMessage({
				type: "demand-mode",
				payload: { mode: lockedMode },
			});
			return;
		}

		if (newMode === previousMode) {
			figma.ui.postMessage({
				type: "demand-mode",
				payload: { mode: newMode },
			});
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
					"X-Device-Type": deviceType,
					"X-File-Key": getFileKey(),
				},
				body: JSON.stringify({
					eventType: "demand_mode_changed",
					fromMode: previousMode,
					toMode: newMode,
					trigger: reason,
					timestamp: new Date().toISOString(),
					fileKey: getFileKey(),
					deviceType,
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

	if (msg.type === "set-device-type") {
		const newDeviceType = msg.deviceType;
		const demandMode = await getDemandMode();
		const uiMode = await getUiMode();
		const previousDeviceType = await getDeviceType();
		const userId = await getOrCreateUserId();
		const fileKey = getFileKey();

		if (!isDeviceType(newDeviceType)) {
			return;
		}

		if (newDeviceType === previousDeviceType) {
			figma.ui.postMessage({
				type: "device-type",
				payload: { deviceType: newDeviceType },
			});
			return;
		}

		await setDeviceType(newDeviceType);

		figma.ui.postMessage({
			type: "device-type",
			payload: { deviceType: newDeviceType },
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
					"X-Demand-Mode": demandMode,
					"X-Device-Type": newDeviceType,
					"X-File-Key": fileKey,
				},
				body: JSON.stringify({
					eventType: "device_type_persisted",
					fromDeviceType: previousDeviceType,
					toDeviceType: newDeviceType,
					timestamp: new Date().toISOString(),
					fileKey,
				}),
			});
		} catch (error) {
			console.error("Failed to log device type change:", error);
		}

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

	if (msg.type === "resolve-issue") {
		try {
			const demandMode = await getDemandMode();
			const uiMode = await getUiMode();
			const deviceType = await getDeviceType();
			const fileKey = getFileKey();

			const response = await fetch(
				"http://localhost:3001/resolve-issue",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Session-Id": msg.sessionId || "unknown",
						"X-User-Id": msg.userId || (await getOrCreateUserId()),
						"X-Condition": msg.condition || "unknown",
						"X-UI-Mode": uiMode,
						"X-Demand-Mode": demandMode,
						"X-Device-Type": deviceType,
						"X-File-Key": fileKey,
					},
					body: JSON.stringify({
						issue: msg.issue,
						fileKey,
					}),
				},
			);

			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Resolve error ${response.status}: ${text}`);
			}

			figma.ui.postMessage({
				type: "issue-resolved",
				payload: {
					issueType: msg.issue.issue_type,
					nodeId: msg.issue.node_id,
				},
			});
		} catch (error) {
			console.error("Failed to resolve issue:", error);

			figma.ui.postMessage({
				type: "check-error",
				payload: {
					message:
						error instanceof Error
							? error.message
							: "Unknown resolve error",
				},
			});
		}

		return;
	}

	if (msg.type === "recheck-issue") {
		try {
			const demandMode = await getDemandMode();
			const uiMode = await getUiMode();
			const deviceType = await getDeviceType();
			const fileKey = getFileKey();
			const selectionImagePayload = await buildSelectionImagePayload();
			const data = collectSelectionData();

			const response = await fetch(
				"http://localhost:3001/recheck-issue",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Session-Id": msg.sessionId || "unknown",
						"X-User-Id": msg.userId || (await getOrCreateUserId()),
						"X-Condition": msg.condition || "unknown",
						"X-UI-Mode": uiMode,
						"X-Demand-Mode": demandMode,
						"X-Device-Type": deviceType,
						"X-File-Key": fileKey,
					},
					body: JSON.stringify({
						issue: msg.issue,
						fileKey,
						screen: data,
						selectionImage: {
							imageBase64: selectionImagePayload.imageBase64,
							mimeType: selectionImagePayload.mimeType,
							source: selectionImagePayload.source,
							error: selectionImagePayload.error || null,
						},
						meta: {
							fileKey,
							deviceType,
						},
					}),
				},
			);

			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Recheck error ${response.status}: ${text}`);
			}

			const payload = await response.json();

			figma.ui.postMessage({
				type: "issue-rechecked",
				payload,
			});
		} catch (error) {
			console.error("Failed to recheck issue:", error);

			figma.ui.postMessage({
				type: "check-error",
				payload: {
					message:
						error instanceof Error
							? error.message
							: "Unknown recheck error",
				},
			});
		}

		return;
	}

	if (msg.type === "reset-dismissed-issues") {
		try {
			const demandMode = await getDemandMode();
			const uiMode = await getUiMode();
			const deviceType = await getDeviceType();
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
						"X-Device-Type": deviceType,
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
