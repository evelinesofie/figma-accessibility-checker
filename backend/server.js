js;
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, "data");
const eventsFile = path.join(dataDir, "events.jsonl");
const dismissedIssuesFile = path.join(dataDir, "dismissed_issues.json");
const reviewCacheFile = path.join(dataDir, "review_cache.json");

if (!fs.existsSync(dataDir)) {
	fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(eventsFile)) {
	fs.writeFileSync(eventsFile, "", "utf8");
}

if (!fs.existsSync(dismissedIssuesFile)) {
	fs.writeFileSync(dismissedIssuesFile, JSON.stringify({}), "utf8");
}

if (!fs.existsSync(reviewCacheFile)) {
	fs.writeFileSync(reviewCacheFile, JSON.stringify({}), "utf8");
}

function appendEvent(event) {
	fs.appendFileSync(eventsFile, JSON.stringify(event) + "\n", "utf8");
	console.log("WROTE EVENT TO:", eventsFile);
}

function readJsonFile(filePath) {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return raw ? JSON.parse(raw) : {};
	} catch (error) {
		console.error(`Failed to read ${filePath}:`, error);
		return {};
	}
}

function writeJsonFile(filePath, data) {
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function readDismissedIssues() {
	return readJsonFile(dismissedIssuesFile);
}

function writeDismissedIssues(data) {
	writeJsonFile(dismissedIssuesFile, data);
}

function readReviewCache() {
	return readJsonFile(reviewCacheFile);
}

function writeReviewCache(data) {
	writeJsonFile(reviewCacheFile, data);
}

function stableHash(value) {
	return crypto
		.createHash("sha1")
		.update(JSON.stringify(value))
		.digest("hex");
}

function createIssueKey(issue) {
	return `${issue?.issue_type || "other"}|${issue?.node_id || "unknown-node"}`;
}

function getResolvedIssueKey(fileKey, issue) {
	return `${fileKey}|${createIssueKey(issue)}`;
}

function getResolvedIssueKeySetForUserAndFile(userId, fileKey) {
	const store = readDismissedIssues();
	const entries = Array.isArray(store[userId]) ? store[userId] : [];
	const resolvedKeys = new Set();

	for (const item of entries) {
		if (item.fileKey !== fileKey) continue;
		if (!item.issueType || !item.nodeId) continue;
		resolvedKeys.add(`${fileKey}|${item.issueType}|${item.nodeId}`);
	}

	return resolvedKeys;
}

function resolveIssueForUser(userId, fileKey, issue) {
	const store = readDismissedIssues();
	const existing = Array.isArray(store[userId]) ? store[userId] : [];
	const resolvedKey = getResolvedIssueKey(fileKey, issue);

	const filtered = existing.filter(
		(item) => item.resolvedKey !== resolvedKey,
	);

	filtered.push({
		resolvedKey,
		fileKey,
		issueType: issue.issue_type,
		nodeId: issue.node_id,
		nodeName: issue.node_name || "",
		resolvedAt: new Date().toISOString(),
	});

	store[userId] = filtered;
	writeDismissedIssues(store);
}

function unresolveIssueForUser(userId, fileKey, issue) {
	const store = readDismissedIssues();
	const existing = Array.isArray(store[userId]) ? store[userId] : [];
	const resolvedKey = getResolvedIssueKey(fileKey, issue);

	store[userId] = existing.filter((item) => item.resolvedKey !== resolvedKey);
	writeDismissedIssues(store);
}

function resetDismissedIssuesForUser(userId, fileKey) {
	const store = readDismissedIssues();
	const existing = Array.isArray(store[userId]) ? store[userId] : [];
	store[userId] = existing.filter((item) => item.fileKey !== fileKey);
	writeDismissedIssues(store);
}

function getUserFileReviewCache(store, userId, fileKey) {
	if (!store[userId]) store[userId] = {};

	if (!store[userId][fileKey]) {
		store[userId][fileKey] = {
			screens: {},
			families: {},
			resolvedByRecheck: {},
		};
	}

	if (!store[userId][fileKey].screens) {
		store[userId][fileKey].screens = {};
	}

	if (!store[userId][fileKey].families) {
		store[userId][fileKey].families = {};
	}

	if (!store[userId][fileKey].resolvedByRecheck) {
		store[userId][fileKey].resolvedByRecheck = {};
	}

	return store[userId][fileKey];
}

function getAnchorIssueKey(issue) {
	return `${issue.node_anchor}|${issue.issue_type}`;
}

function buildStoredIssueMap(storedIssues = []) {
	const map = new Map();
	for (const issue of storedIssues) {
		map.set(getAnchorIssueKey(issue), issue);
	}
	return map;
}

function createResolvedRecheckKey(
	screenFamilySignature,
	nodeAnchor,
	issueType,
) {
	return `${screenFamilySignature}|${nodeAnchor}|${issueType}`;
}

function markIssueResolvedByRecheck(
	fileCache,
	screenFamilySignature,
	nodeAnchor,
	issueType,
) {
	const key = createResolvedRecheckKey(
		screenFamilySignature,
		nodeAnchor,
		issueType,
	);

	fileCache.resolvedByRecheck[key] = {
		screenFamilySignature,
		nodeAnchor,
		issueType,
		resolvedAt: new Date().toISOString(),
	};
}

function clearResolvedByRecheck(
	fileCache,
	screenFamilySignature,
	nodeAnchor,
	issueType,
) {
	const key = createResolvedRecheckKey(
		screenFamilySignature,
		nodeAnchor,
		issueType,
	);

	delete fileCache.resolvedByRecheck[key];
}

function isResolvedByRecheck(
	fileCache,
	screenFamilySignature,
	nodeAnchor,
	issueType,
) {
	const key = createResolvedRecheckKey(
		screenFamilySignature,
		nodeAnchor,
		issueType,
	);

	return !!fileCache.resolvedByRecheck[key];
}

function hasResolvedRecheckInFamily(fileCache, screenFamilySignature) {
	return Object.values(fileCache.resolvedByRecheck || {}).some(
		(item) => item.screenFamilySignature === screenFamilySignature,
	);
}

function buildNodeIndex(compactScreen) {
	const nodes = Array.isArray(compactScreen?.nodes)
		? compactScreen.nodes
		: [];
	const index = new Map();

	for (const node of nodes) {
		if (!node?.id) continue;
		index.set(node.id, node);
	}

	return index;
}

function getNodeFingerprintFromIndex(nodeIndex, nodeId) {
	const node = nodeIndex.get(nodeId);
	if (!node) return null;

	if (typeof node.fingerprint === "string" && node.fingerprint.length > 0) {
		return node.fingerprint;
	}

	return stableHash({
		id: node.id,
		name: node.name,
		type: node.type,
		width: node.width,
		height: node.height,
		x: node.x,
		y: node.y,
		text: node.text,
		fontSize: node.fontSize,
		fills: node.fills,
	});
}

function getNodeVisualSignature(node) {
	if (
		node &&
		typeof node.visualSignature === "string" &&
		node.visualSignature.length > 0
	) {
		return node.visualSignature;
	}

	return stableHash({
		name: node?.name,
		type: node?.type,
		visible: node?.visible,
		width: node?.width,
		height: node?.height,
		text: node?.text,
		fontSize: node?.fontSize,
		fills: Array.isArray(node?.fills) ? node.fills : [],
	});
}

function buildAnchorFingerprintMap(compactScreen, nodeIdToAnchor, nodeIndex) {
	const map = {};

	for (const node of compactScreen.nodes || []) {
		const anchor = nodeIdToAnchor.get(node.id);
		if (!anchor) continue;

		map[anchor] = {
			nodeId: node.id,
			fingerprint: getNodeFingerprintFromIndex(nodeIndex, node.id),
			visualSignature: getNodeVisualSignature(node),
			name: node.name || "",
			type: node.type || "",
		};
	}

	return map;
}

function getKnownFamilyAnchors(familyEntry) {
	const anchorFingerprints =
		familyEntry?.latestScreenEntry?.anchorFingerprints || {};
	return new Set(Object.keys(anchorFingerprints));
}

function makeCompactScreen(screen) {
	const nodes = Array.isArray(screen?.nodes) ? screen.nodes : [];

	const compactNodes = nodes.slice(0, 180).map((node) => ({
		id: node.id,
		name: node.name,
		type: node.type,
		visible: node.visible,
		width: node.width,
		height: node.height,
		x: node.x,
		y: node.y,
		text: node.text,
		fontSize: typeof node.fontSize === "number" ? node.fontSize : undefined,
		fills: node.fills,
		fingerprint: node.fingerprint,
		visualSignature: node.visualSignature,
	}));

	const textNodes = compactNodes.filter((n) => n.type === "TEXT").length;

	return {
		selectionCount: screen?.selectionCount ?? 0,
		totalNodes: compactNodes.length,
		textNodes,
		nodes: compactNodes,
	};
}

function createSelectionSignature(compactScreen, deviceType) {
	const normalizedNodes = (compactScreen.nodes || [])
		.map((node) => ({
			name: node.name,
			type: node.type,
			visible: node.visible,
			width: node.width,
			height: node.height,
			text: node.text || "",
			fontSize: node.fontSize,
			fills: Array.isArray(node.fills) ? [...node.fills] : [],
			visualSignature: getNodeVisualSignature(node),
		}))
		.sort((a, b) => {
			const keyA = JSON.stringify(a);
			const keyB = JSON.stringify(b);
			return keyA.localeCompare(keyB);
		});

	return stableHash({
		deviceType,
		selectionCount: compactScreen.selectionCount,
		totalNodes: compactScreen.totalNodes,
		textNodes: compactScreen.textNodes,
		nodes: normalizedNodes,
	});
}

function createScreenFamilySignature(compactScreen, deviceType) {
	const stableNodes = (compactScreen.nodes || [])
		.map((node) => ({
			type: node.type,
			name: node.name || "",
			x: typeof node.x === "number" ? Math.round(node.x / 20) : 0,
			y: typeof node.y === "number" ? Math.round(node.y / 20) : 0,
		}))
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

	return stableHash({
		deviceType,
		selectionCount: compactScreen.selectionCount,
		totalNodes: compactScreen.totalNodes,
		textNodes: compactScreen.textNodes,
		nodes: stableNodes,
	});
}

function buildNodeAnchors(compactScreen) {
	const sortedNodes = [...(compactScreen.nodes || [])].sort((a, b) => {
		const aBase = {
			type: a.type,
			name: a.name || "",
			x: typeof a.x === "number" ? Math.round(a.x / 20) : 0,
			y: typeof a.y === "number" ? Math.round(a.y / 20) : 0,
		};
		const bBase = {
			type: b.type,
			name: b.name || "",
			x: typeof b.x === "number" ? Math.round(b.x / 20) : 0,
			y: typeof b.y === "number" ? Math.round(b.y / 20) : 0,
		};

		return JSON.stringify(aBase).localeCompare(JSON.stringify(bBase));
	});

	const seenCounts = new Map();
	const nodeIdToAnchor = new Map();
	const anchorToNode = new Map();

	for (const node of sortedNodes) {
		const base = stableHash({
			type: node.type,
			name: node.name || "",
			x: typeof node.x === "number" ? Math.round(node.x / 20) : 0,
			y: typeof node.y === "number" ? Math.round(node.y / 20) : 0,
		});

		const count = (seenCounts.get(base) || 0) + 1;
		seenCounts.set(base, count);

		const anchor = `${base}:${count}`;
		nodeIdToAnchor.set(node.id, anchor);
		anchorToNode.set(anchor, node);
	}

	return {
		nodeIdToAnchor,
		anchorToNode,
	};
}

function attachAnchorsToIssues(issues, nodeIdToAnchor) {
	return issues
		.map((issue) => {
			const anchor = nodeIdToAnchor.get(issue.node_id);
			if (!anchor) return null;

			return {
				...issue,
				node_anchor: anchor,
			};
		})
		.filter(Boolean);
}

function materializeStoredIssues(storedIssues, anchorToNode) {
	return (storedIssues || [])
		.map((issue) => {
			const node = anchorToNode.get(issue.node_anchor);
			if (!node) return null;

			return {
				issue_type: issue.issue_type,
				title: issue.title,
				node_name: node.name,
				node_id: node.id,
				severity: issue.severity,
				explanation: issue.explanation,
				why_it_matters: issue.why_it_matters,
				suggestion: issue.suggestion,
				node_anchor: issue.node_anchor,
			};
		})
		.filter(Boolean);
}

function buildInitialReviewPrompt(
	compactScreen,
	hasSelectionImage,
	deviceType,
) {
	return `
You are an AI accessibility reviewer for Figma screens.

Review the provided Figma selection using:
1. structured screen data with exact node ids and properties
2. a rendered image preview of the selection, when available

Use the image to improve visual judgment about hierarchy, spacing, readability, and likely contrast.
Use the structured data as the source of truth for exact node identity, node ids, names, dimensions, text, and colors.

Return ONLY valid JSON with this exact structure:

{
  "summary": {
    "total_nodes": number,
    "text_nodes": number
  },
  "overall_assessment": string,
  "issues": [
    {
      "issue_type": "small_text" | "low_contrast" | "small_touch_target" | "unclear_label" | "weak_visual_hierarchy" | "other",
      "title": string,
      "node_name": string,
      "node_id": string,
      "severity": "low" | "medium" | "high",
      "explanation": string,
      "why_it_matters": string,
      "suggestion": string
    }
  ]
}

Rules:
- Review a design mockup, not live code.
- Only report issues that can be fixed in Figma.
- Do not report code-only issues like alt text, ARIA, semantic HTML, keyboard handlers, or screen reader roles.
- Each issue must be tied to exactly one real node from the provided screen data.
- node_id must exactly match a node id from the provided data.
- node_name must exactly match that node's name.
- Do not report duplicate issue types for the same node.
- Return at most 8 strong, clearly evidenced issues.
- Prefer fewer, better-supported issues over many weak ones.
- If there are no clear issues, return an empty issues array.
- Use cautious wording when evidence is incomplete.
- Be conservative.
- If an issue is borderline, omit it.

Use these issue types only:
- "small_text"
- "low_contrast"
- "small_touch_target"
- "unclear_label"
- "weak_visual_hierarchy"
- "other"

Device context:
- This prototype should be reviewed as a ${deviceType} interface.
- Desktop interfaces should be judged primarily for mouse/trackpad interaction, readability, clarity, scanability, spacing, and visual hierarchy.
- Mobile and tablet interfaces may be judged using touch-oriented heuristics.
- Only use "small_touch_target" when touch interaction is genuinely relevant for the chosen device context.
- For desktop reviews, do NOT use touch language such as "tap", "finger", or "touch target".
- For desktop reviews, use desktop wording such as "click", "click target", "small control", or "hard to click".
- For desktop reviews, avoid reporting "small_touch_target" unless there is exceptionally strong reason to treat the prototype as touch-first despite the selected device type.

Image note:
- ${hasSelectionImage ? "A rendered preview image is included." : "No preview image is included."}

Screen data:
${JSON.stringify(compactScreen, null, 2)}
  `.trim();
}

function buildSingleIssueRecheckPrompt(
	node,
	issueType,
	hasSelectionImage,
	deviceType,
) {
	return `
You are rechecking one specific accessibility issue on one specific Figma node.

Return ONLY valid JSON with this exact structure:

{
  "issue": {
    "issue_type": "small_text" | "low_contrast" | "small_touch_target" | "unclear_label" | "weak_visual_hierarchy" | "other",
    "title": string,
    "node_name": string,
    "node_id": string,
    "severity": "low" | "medium" | "high",
    "explanation": string,
    "why_it_matters": string,
    "suggestion": string
  } | null
}

Rules:
- Re-evaluate ONLY this requested issue type: "${issueType}".
- Do not return any other issue type.
- Return issue: null if this specific issue is not currently justified.
- node_id must exactly match the provided node id.
- node_name must exactly match the provided node name.
- Review a design mockup, not live code.
- Only report issues that can be fixed in Figma.
- Do not report code-only issues like alt text, ARIA, semantic HTML, keyboard handlers, or screen reader roles.

Device context:
- This prototype should be reviewed as a ${deviceType} interface.
- Only use touch-oriented reasoning when appropriate for the selected device type.

Image note:
- ${hasSelectionImage ? "A rendered preview image is included." : "No preview image is included."}

Node data:
${JSON.stringify(node, null, 2)}
  `.trim();
}

function buildReviewResponseSchema(name) {
	return {
		type: "json_schema",
		name,
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				summary: {
					type: "object",
					additionalProperties: false,
					properties: {
						total_nodes: { type: "number" },
						text_nodes: { type: "number" },
					},
					required: ["total_nodes", "text_nodes"],
				},
				overall_assessment: { type: "string" },
				issues: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							issue_type: {
								type: "string",
								enum: [
									"small_text",
									"low_contrast",
									"small_touch_target",
									"unclear_label",
									"weak_visual_hierarchy",
									"other",
								],
							},
							title: { type: "string" },
							node_name: { type: "string" },
							node_id: { type: "string" },
							severity: {
								type: "string",
								enum: ["low", "medium", "high"],
							},
							explanation: { type: "string" },
							why_it_matters: { type: "string" },
							suggestion: { type: "string" },
						},
						required: [
							"issue_type",
							"title",
							"node_name",
							"node_id",
							"severity",
							"explanation",
							"why_it_matters",
							"suggestion",
						],
					},
				},
			},
			required: ["summary", "overall_assessment", "issues"],
		},
	};
}

function buildSingleIssueRecheckResponseSchema() {
	return {
		type: "json_schema",
		name: "accessibility_single_issue_recheck",
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				issue: {
					anyOf: [
						{
							type: "object",
							additionalProperties: false,
							properties: {
								issue_type: {
									type: "string",
									enum: [
										"small_text",
										"low_contrast",
										"small_touch_target",
										"unclear_label",
										"weak_visual_hierarchy",
										"other",
									],
								},
								title: { type: "string" },
								node_name: { type: "string" },
								node_id: { type: "string" },
								severity: {
									type: "string",
									enum: ["low", "medium", "high"],
								},
								explanation: { type: "string" },
								why_it_matters: { type: "string" },
								suggestion: { type: "string" },
							},
							required: [
								"issue_type",
								"title",
								"node_name",
								"node_id",
								"severity",
								"explanation",
								"why_it_matters",
								"suggestion",
							],
						},
						{ type: "null" },
					],
				},
			},
			required: ["issue"],
		},
	};
}

function normalizeIssue(issue, nodeIndex) {
	if (!issue || typeof issue !== "object") return null;

	const validIssueTypes = new Set([
		"small_text",
		"low_contrast",
		"small_touch_target",
		"unclear_label",
		"weak_visual_hierarchy",
		"other",
	]);

	const validSeverities = new Set(["low", "medium", "high"]);

	const nodeId = typeof issue.node_id === "string" ? issue.node_id : "";
	const node = nodeIndex.get(nodeId);

	if (!node) {
		return null;
	}

	const issueType = validIssueTypes.has(issue.issue_type)
		? issue.issue_type
		: "other";

	const severity = validSeverities.has(issue.severity)
		? issue.severity
		: "medium";

	return {
		issue_type: issueType,
		title: String(issue.title || "Accessibility issue").trim(),
		node_name: node.name,
		node_id: node.id,
		severity,
		explanation: String(issue.explanation || "").trim(),
		why_it_matters: String(issue.why_it_matters || "").trim(),
		suggestion: String(issue.suggestion || "").trim(),
	};
}

function severityRank(severity) {
	if (severity === "high") return 3;
	if (severity === "medium") return 2;
	return 1;
}

function dedupeIssues(issues) {
	const bestByKey = new Map();

	for (const issue of issues) {
		const key = `${issue.issue_type}|${issue.node_id}`;
		const existing = bestByKey.get(key);

		if (!existing) {
			bestByKey.set(key, issue);
			continue;
		}

		const existingScore = severityRank(existing.severity);
		const nextScore = severityRank(issue.severity);

		if (nextScore > existingScore) {
			bestByKey.set(key, issue);
			continue;
		}

		if (nextScore === existingScore) {
			const existingLen =
				(existing.explanation?.length || 0) +
				(existing.why_it_matters?.length || 0) +
				(existing.suggestion?.length || 0);

			const nextLen =
				(issue.explanation?.length || 0) +
				(issue.why_it_matters?.length || 0) +
				(issue.suggestion?.length || 0);

			if (nextLen > existingLen) {
				bestByKey.set(key, issue);
			}
		}
	}

	return Array.from(bestByKey.values()).sort(
		(a, b) => severityRank(b.severity) - severityRank(a.severity),
	);
}

async function analyzeScreenWithModel(
	compactScreen,
	nodeIndex,
	client,
	selectionImage,
	deviceType,
) {
	const hasSelectionImage =
		typeof selectionImage?.imageBase64 === "string" &&
		selectionImage.imageBase64.length > 0;

	const prompt = buildInitialReviewPrompt(
		compactScreen,
		hasSelectionImage,
		deviceType,
	);

	const content = [
		{
			type: "input_text",
			text: prompt,
		},
	];

	if (hasSelectionImage) {
		content.push({
			type: "input_image",
			image_url: `data:${selectionImage.mimeType || "image/png"};base64,${selectionImage.imageBase64}`,
		});
	}

	const response = await client.responses.create({
		model: "gpt-5.4-mini",
		input: [
			{
				role: "user",
				content,
			},
		],
		text: {
			format: buildReviewResponseSchema("accessibility_review"),
		},
	});

	const parsed = JSON.parse(response.output_text);

	if (!parsed.summary) {
		parsed.summary = {
			total_nodes: compactScreen.totalNodes,
			text_nodes: compactScreen.textNodes,
		};
	}

	const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
	const normalizedIssues = rawIssues
		.map((issue) => normalizeIssue(issue, nodeIndex))
		.filter(Boolean);

	return {
		summary: parsed.summary,
		overall_assessment: parsed.overall_assessment || "",
		issues: dedupeIssues(normalizedIssues),
	};
}

async function recheckSingleIssueWithModel({
	node,
	issueType,
	client,
	selectionImage,
	deviceType,
}) {
	const singleNodeScreen = {
		selectionCount: 1,
		totalNodes: 1,
		textNodes: node.type === "TEXT" ? 1 : 0,
		nodes: [node],
	};
	const nodeIndex = buildNodeIndex(singleNodeScreen);

	const hasSelectionImage =
		typeof selectionImage?.imageBase64 === "string" &&
		selectionImage.imageBase64.length > 0;

	const prompt = buildSingleIssueRecheckPrompt(
		node,
		issueType,
		hasSelectionImage,
		deviceType,
	);

	const content = [
		{
			type: "input_text",
			text: prompt,
		},
	];

	if (hasSelectionImage) {
		content.push({
			type: "input_image",
			image_url: `data:${selectionImage.mimeType || "image/png"};base64,${selectionImage.imageBase64}`,
		});
	}

	const response = await client.responses.create({
		model: "gpt-5.4-mini",
		input: [
			{
				role: "user",
				content,
			},
		],
		text: {
			format: buildSingleIssueRecheckResponseSchema(),
		},
	});

	const parsed = JSON.parse(response.output_text);
	const normalized = parsed.issue
		? normalizeIssue(parsed.issue, nodeIndex)
		: null;

	if (!normalized) {
		return null;
	}

	if (normalized.issue_type !== issueType) {
		return null;
	}

	return normalized;
}

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "15mb" }));

const client = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

console.log("API key loaded:", !!process.env.OPENAI_API_KEY);

app.get("/health", (_req, res) => {
	res.json({ ok: true });
});

app.post("/analyze", async (req, res) => {
	try {
		const compactScreen = makeCompactScreen(req.body.screen);
		const selectionImage = req.body.selectionImage || null;
		const nodeIndex = buildNodeIndex(compactScreen);

		const userId = req.headers["x-user-id"] || "unknown";
		const sessionId = req.headers["x-session-id"] || "unknown";
		const condition = req.headers["x-condition"] || "unknown";
		const demandMode = req.headers["x-demand-mode"] || "unknown";
		const deviceType =
			req.headers["x-device-type"] ||
			req.body?.meta?.deviceType ||
			"desktop";
		const fileKey =
			req.headers["x-file-key"] ||
			req.body?.meta?.fileKey ||
			"unknown-file";

		appendEvent({
			userId,
			sessionId,
			condition,
			demandMode,
			deviceType,
			fileKey,
			eventType: "run_check",
			selectionCount: compactScreen.selectionCount,
			totalNodes: compactScreen.totalNodes,
			textNodes: compactScreen.textNodes,
			hasSelectionImage:
				typeof selectionImage?.imageBase64 === "string" &&
				selectionImage.imageBase64.length > 0,
			timestamp: new Date().toISOString(),
		});

		const reviewCacheStore = readReviewCache();
		const fileCache = getUserFileReviewCache(
			reviewCacheStore,
			userId,
			fileKey,
		);

		const selectionSignature = createSelectionSignature(
			compactScreen,
			deviceType,
		);
		const screenFamilySignature = createScreenFamilySignature(
			compactScreen,
			deviceType,
		);

		const exactScreenEntry = fileCache.screens[selectionSignature] || null;
		const familyEntry = fileCache.families[screenFamilySignature] || null;

		const { nodeIdToAnchor, anchorToNode } =
			buildNodeAnchors(compactScreen);

		const currentAnchorFingerprints = buildAnchorFingerprintMap(
			compactScreen,
			nodeIdToAnchor,
			nodeIndex,
		);

		if (exactScreenEntry && Array.isArray(exactScreenEntry.storedIssues)) {
			const reusedIssues = dedupeIssues(
				materializeStoredIssues(
					exactScreenEntry.storedIssues,
					anchorToNode,
				),
			).map((issue) => ({
				...issue,
				node_fingerprint: getNodeFingerprintFromIndex(
					nodeIndex,
					issue.node_id,
				),
			}));

			const resolvedIssueKeys = getResolvedIssueKeySetForUserAndFile(
				userId,
				fileKey,
			);

			const visibleIssues = reusedIssues.filter((issue) => {
				const resolvedKey = getResolvedIssueKey(fileKey, issue);
				return !resolvedIssueKeys.has(resolvedKey);
			});

			appendEvent({
				userId,
				sessionId,
				condition,
				demandMode,
				deviceType,
				fileKey,
				eventType: "check_reused_screen_signature",
				selectionSignature,
				issueCount: visibleIssues.length,
				timestamp: new Date().toISOString(),
			});

			return res.json({
				summary: {
					total_nodes: compactScreen.totalNodes,
					text_nodes: compactScreen.textNodes,
				},
				overall_assessment:
					exactScreenEntry.overallAssessment ||
					"Matched a previously reviewed equivalent screen. Reusing prior AI review.",
				issues: visibleIssues,
			});
		}

		const baselineEntry = familyEntry?.latestScreenEntry || null;
		const baselineStoredIssues =
			baselineEntry && Array.isArray(baselineEntry.storedIssues)
				? baselineEntry.storedIssues
				: [];
		const baselineIssueMap = buildStoredIssueMap(baselineStoredIssues);

		const analysis = await analyzeScreenWithModel(
			compactScreen,
			nodeIndex,
			client,
			selectionImage,
			deviceType,
		);

		const candidateIssues = dedupeIssues(analysis.issues || []);
		const candidateStoredIssues = attachAnchorsToIssues(
			candidateIssues,
			nodeIdToAnchor,
		);

		const filteredCandidateStoredIssues = candidateStoredIssues.filter(
			(issue) => {
				return !isResolvedByRecheck(
					fileCache,
					screenFamilySignature,
					issue.node_anchor,
					issue.issue_type,
				);
			},
		);

		const familyPreviouslyKnown = !!familyEntry;
		const familyIsLocked = hasResolvedRecheckInFamily(
			fileCache,
			screenFamilySignature,
		);
		const knownFamilyAnchors = getKnownFamilyAnchors(familyEntry);

		let finalStoredIssues = [];

		if (!familyPreviouslyKnown) {
			finalStoredIssues = filteredCandidateStoredIssues;
		} else {
			const mergedMap = new Map();

			for (const issue of baselineStoredIssues) {
				if (anchorToNode.has(issue.node_anchor)) {
					mergedMap.set(getAnchorIssueKey(issue), issue);
				}
			}

			for (const issue of filteredCandidateStoredIssues) {
				const key = getAnchorIssueKey(issue);
				const anchor = issue.node_anchor;
				const existedBeforeSameIssue = baselineIssueMap.has(key);

				if (existedBeforeSameIssue) {
					mergedMap.set(key, issue);
					continue;
				}

				const isNewAnchorForFamily = !knownFamilyAnchors.has(anchor);

				if (familyIsLocked) {
					if (isNewAnchorForFamily) {
						mergedMap.set(key, issue);
					}
					continue;
				}

				if (isNewAnchorForFamily) {
					mergedMap.set(key, issue);
				}
			}

			finalStoredIssues = Array.from(mergedMap.values());
		}

		const finalIssues = dedupeIssues(
			materializeStoredIssues(finalStoredIssues, anchorToNode),
		);

		const nextScreenEntry = {
			deviceType,
			selectionSignature,
			screenFamilySignature,
			overallAssessment: analysis.overall_assessment || "",
			storedIssues: finalStoredIssues,
			anchorFingerprints: currentAnchorFingerprints,
			reviewedAt: new Date().toISOString(),
		};

		fileCache.screens[selectionSignature] = nextScreenEntry;
		fileCache.families[screenFamilySignature] = {
			deviceType,
			screenFamilySignature,
			latestSelectionSignature: selectionSignature,
			latestScreenEntry: nextScreenEntry,
			updatedAt: new Date().toISOString(),
		};

		writeReviewCache(reviewCacheStore);

		const resolvedIssueKeys = getResolvedIssueKeySetForUserAndFile(
			userId,
			fileKey,
		);

		const visibleIssues = finalIssues
			.map((issue) => ({
				...issue,
				node_fingerprint: getNodeFingerprintFromIndex(
					nodeIndex,
					issue.node_id,
				),
			}))
			.filter((issue) => {
				const resolvedKey = getResolvedIssueKey(fileKey, issue);
				return !resolvedIssueKeys.has(resolvedKey);
			});

		appendEvent({
			userId,
			sessionId,
			condition,
			demandMode,
			deviceType,
			fileKey,
			eventType: "check_completed_new_screen_signature",
			selectionSignature,
			screenFamilySignature,
			familyPreviouslyKnown,
			baselineIssueCount: baselineStoredIssues.length,
			candidateIssueCount: filteredCandidateStoredIssues.length,
			finalIssueCount: visibleIssues.length,
			familyLocked: familyIsLocked,
			knownAnchorCount: knownFamilyAnchors.size,
			timestamp: new Date().toISOString(),
		});

		res.json({
			summary: {
				total_nodes: compactScreen.totalNodes,
				text_nodes: compactScreen.textNodes,
			},
			overall_assessment:
				analysis.overall_assessment || "AI review completed.",
			issues: visibleIssues,
		});
	} catch (error) {
		console.error("Analyze error:", error);

		let message = "Unknown server error";
		if (error instanceof Error) {
			message = error.message;
		}

		if (error && typeof error === "object" && "status" in error) {
			message = `OpenAI/API error ${error.status}: ${message}`;
		}

		res.status(500).json({
			error: true,
			message,
		});
	}
});

app.post("/log", (req, res) => {
	try {
		const userId = req.headers["x-user-id"] || "unknown";
		const sessionId = req.headers["x-session-id"] || "unknown";
		const condition = req.headers["x-condition"] || "unknown";
		const demandMode = req.headers["x-demand-mode"] || "unknown";
		const deviceType =
			req.headers["x-device-type"] || req.body.deviceType || "desktop";
		const fileKey =
			req.headers["x-file-key"] || req.body.fileKey || "unknown-file";

		const record = {
			userId,
			sessionId,
			condition,
			demandMode,
			deviceType,
			fileKey,
			...req.body,
		};

		appendEvent(record);
		console.log("LOG EVENT:", JSON.stringify(record, null, 2));

		res.json({ ok: true });
	} catch (error) {
		console.error("Log error:", error);
		res.status(500).json({
			error: true,
			message:
				error instanceof Error ? error.message : "Unknown log error",
		});
	}
});

app.post("/resolve-issue", (req, res) => {
	try {
		const userId = req.headers["x-user-id"] || req.body.userId || "unknown";
		const sessionId = req.headers["x-session-id"] || "unknown";
		const condition = req.headers["x-condition"] || "unknown";
		const demandMode = req.headers["x-demand-mode"] || "unknown";
		const deviceType =
			req.headers["x-device-type"] || req.body.deviceType || "desktop";
		const fileKey =
			req.headers["x-file-key"] || req.body.fileKey || "unknown-file";

		const issue = req.body.issue;

		if (!issue || !issue.issue_type || !issue.node_id) {
			return res.status(400).json({
				error: true,
				message: "Missing required issue identity fields",
			});
		}

		resolveIssueForUser(userId, fileKey, issue);

		appendEvent({
			userId,
			sessionId,
			condition,
			demandMode,
			deviceType,
			fileKey,
			eventType: "issue_resolved",
			issueType: issue.issue_type,
			nodeId: issue.node_id,
			nodeName: issue.node_name || "",
			timestamp: new Date().toISOString(),
		});

		res.json({ ok: true });
	} catch (error) {
		console.error("Resolve issue error:", error);
		res.status(500).json({
			error: true,
			message:
				error instanceof Error
					? error.message
					: "Unknown resolve error",
		});
	}
});

app.post("/recheck-issue", async (req, res) => {
	try {
		const userId = req.headers["x-user-id"] || req.body.userId || "unknown";
		const sessionId = req.headers["x-session-id"] || "unknown";
		const condition = req.headers["x-condition"] || "unknown";
		const demandMode = req.headers["x-demand-mode"] || "unknown";
		const deviceType =
			req.headers["x-device-type"] ||
			req.body?.meta?.deviceType ||
			"desktop";
		const fileKey =
			req.headers["x-file-key"] ||
			req.body?.meta?.fileKey ||
			"unknown-file";

		const issue = req.body.issue;
		const compactScreen = makeCompactScreen(req.body.screen);
		const selectionImage = req.body.selectionImage || null;
		const nodeIndex = buildNodeIndex(compactScreen);

		if (!issue || !issue.issue_type || !issue.node_id) {
			return res.status(400).json({
				error: true,
				message: "Missing required issue identity fields",
			});
		}

		const node = nodeIndex.get(issue.node_id);
		if (!node) {
			return res.status(404).json({
				error: true,
				message:
					"Could not find the target node in the current selection data",
			});
		}

		unresolveIssueForUser(userId, fileKey, issue);

		const reviewCacheStore = readReviewCache();
		const fileCache = getUserFileReviewCache(
			reviewCacheStore,
			userId,
			fileKey,
		);

		const selectionSignature = createSelectionSignature(
			compactScreen,
			deviceType,
		);
		const screenFamilySignature = createScreenFamilySignature(
			compactScreen,
			deviceType,
		);
		const familyEntry = fileCache.families[screenFamilySignature] || null;

		const { nodeIdToAnchor, anchorToNode } =
			buildNodeAnchors(compactScreen);

		const currentAnchorFingerprints = buildAnchorFingerprintMap(
			compactScreen,
			nodeIdToAnchor,
			nodeIndex,
		);

		if (!fileCache.screens[selectionSignature]) {
			const latestFamilyEntry = familyEntry?.latestScreenEntry || null;

			let seededStoredIssues = [];

			if (
				latestFamilyEntry &&
				Array.isArray(latestFamilyEntry.storedIssues)
			) {
				seededStoredIssues = latestFamilyEntry.storedIssues.filter(
					(item) => anchorToNode.has(item.node_anchor),
				);
			}

			const seededAnchorFingerprints =
				latestFamilyEntry?.anchorFingerprints &&
				typeof latestFamilyEntry.anchorFingerprints === "object"
					? latestFamilyEntry.anchorFingerprints
					: {};

			fileCache.screens[selectionSignature] = {
				deviceType,
				selectionSignature,
				screenFamilySignature,
				overallAssessment: latestFamilyEntry?.overallAssessment || "",
				storedIssues: seededStoredIssues,
				anchorFingerprints: seededAnchorFingerprints,
				reviewedAt: new Date().toISOString(),
			};
		}

		const screenEntry = fileCache.screens[selectionSignature];
		const targetAnchor = nodeIdToAnchor.get(issue.node_id);

		if (!targetAnchor) {
			return res.status(400).json({
				error: true,
				message:
					"Could not compute a stable anchor for the target node",
			});
		}

		const refreshedIssue = await recheckSingleIssueWithModel({
			node,
			issueType: issue.issue_type,
			client,
			selectionImage,
			deviceType,
		});

		const existingStoredIssues = Array.isArray(screenEntry.storedIssues)
			? screenEntry.storedIssues
			: [];

		const keptStoredIssues = existingStoredIssues.filter(
			(item) =>
				!(
					item.node_anchor === targetAnchor &&
					item.issue_type === issue.issue_type
				),
		);

		const nextStoredIssues = [...keptStoredIssues];

		if (refreshedIssue) {
			nextStoredIssues.push({
				...refreshedIssue,
				node_anchor: targetAnchor,
			});

			clearResolvedByRecheck(
				fileCache,
				screenFamilySignature,
				targetAnchor,
				issue.issue_type,
			);
		} else {
			markIssueResolvedByRecheck(
				fileCache,
				screenFamilySignature,
				targetAnchor,
				issue.issue_type,
			);
		}

		screenEntry.storedIssues = nextStoredIssues;
		screenEntry.reviewedAt = new Date().toISOString();
		screenEntry.screenFamilySignature = screenFamilySignature;
		screenEntry.anchorFingerprints = currentAnchorFingerprints;

		fileCache.families[screenFamilySignature] = {
			deviceType,
			screenFamilySignature,
			latestSelectionSignature: selectionSignature,
			latestScreenEntry: screenEntry,
			updatedAt: new Date().toISOString(),
		};

		writeReviewCache(reviewCacheStore);

		appendEvent({
			userId,
			sessionId,
			condition,
			demandMode,
			deviceType,
			fileKey,
			eventType: "issue_rechecked",
			selectionSignature,
			screenFamilySignature,
			issueType: issue.issue_type,
			nodeId: issue.node_id,
			nodeName: issue.node_name || node.name || "",
			nodeAnchor: targetAnchor,
			stillPresent: !!refreshedIssue,
			timestamp: new Date().toISOString(),
		});

		res.json({
			issueType: issue.issue_type,
			nodeId: issue.node_id,
			issue: refreshedIssue
				? {
						...refreshedIssue,
						node_fingerprint: getNodeFingerprintFromIndex(
							nodeIndex,
							refreshedIssue.node_id,
						),
						node_anchor: targetAnchor,
					}
				: null,
		});
	} catch (error) {
		console.error("Recheck issue error:", error);

		let message = "Unknown recheck error";
		if (error instanceof Error) {
			message = error.message;
		}

		if (error && typeof error === "object" && "status" in error) {
			message = `OpenAI/API error ${error.status}: ${message}`;
		}

		res.status(500).json({
			error: true,
			message,
		});
	}
});

app.post("/reset-dismissed-issues", (req, res) => {
	try {
		const userId = req.headers["x-user-id"] || req.body.userId || "unknown";
		const sessionId = req.headers["x-session-id"] || "unknown";
		const condition = req.headers["x-condition"] || "unknown";
		const demandMode = req.headers["x-demand-mode"] || "unknown";
		const deviceType =
			req.headers["x-device-type"] || req.body.deviceType || "desktop";
		const fileKey =
			req.headers["x-file-key"] || req.body.fileKey || "unknown-file";

		resetDismissedIssuesForUser(userId, fileKey);

		appendEvent({
			userId,
			sessionId,
			condition,
			demandMode,
			deviceType,
			fileKey,
			eventType: "dismissed_issues_reset",
			timestamp: new Date().toISOString(),
		});

		res.json({ ok: true });
	} catch (error) {
		console.error("Reset dismissed issues error:", error);
		res.status(500).json({
			error: true,
			message:
				error instanceof Error ? error.message : "Unknown reset error",
		});
	}
});

app.listen(port, () => {
	console.log(`Backend listening on http://localhost:${port}`);
});
