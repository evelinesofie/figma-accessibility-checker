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

function getUserFileReviewCache(store, userId, fileKey) {
	if (!store[userId]) store[userId] = {};
	if (!store[userId][fileKey]) store[userId][fileKey] = {};
	return store[userId][fileKey];
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
	}));

	const textNodes = compactNodes.filter((n) => n.type === "TEXT").length;

	return {
		selectionCount: screen?.selectionCount ?? 0,
		totalNodes: compactNodes.length,
		textNodes,
		nodes: compactNodes,
	};
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
- Return at most 10 strong, grounded issues.
- Prefer fewer, better-supported issues over many weak ones.
- If there are no clear issues, return an empty issues array.
- Use cautious wording when evidence is incomplete.

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
- Use the image for context, but use the structured data for exact ids and properties.

Screen data:
${JSON.stringify(compactScreen, null, 2)}
  `.trim();
}

function buildBatchNodeUpdatePrompt(changedNodes, deviceType) {
	return `
You are updating a previous AI accessibility review for multiple changed Figma nodes.

Important goal: preserve review stability.
A small edit should not cause unrelated issue types to appear for the first time.

For each changed node, review the CURRENT node in light of:
- the PREVIOUS version of the node
- the PREVIOUS issues already reported for that same node
- the list of changed fields

Return ONLY valid JSON with this exact structure:

{
  "overall_assessment": string,
  "updated_nodes": [
    {
      "node_id": string,
      "node_name": string,
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
  ]
}

Critical stability rules:
- Start from the previous issue set as the baseline.
- Preserve previous issue judgments unless the actual change makes them no longer valid or materially changes their severity or explanation.
- Do NOT introduce a new unrelated issue type just because you now notice something that was already present before.
- New issue types should appear only when they are plausibly caused, revealed, or strongly justified by the changed fields.
- If only colors changed, avoid introducing size-related or labeling-related issues unless the current data clearly makes that necessary because of the change itself.
- If only text changed, avoid introducing unrelated size or contrast issues unless the change plausibly affects them.
- If evidence remains weak, keep the prior judgment stable.

General rules:
- Review a design mockup, not live code.
- Only report issues that can be fixed in Figma.
- Do not report code-only issues like alt text, ARIA, semantic HTML, keyboard handlers, or screen reader roles.
- Each issue must be tied to that exact node only.
- node_id must exactly match the current node id.
- node_name must exactly match the current node name.
- Do not report duplicate issue types for the same node.
- A node may return zero issues if no issue remains justified.

Device context:
- This prototype should be reviewed as a ${deviceType} interface.
- Desktop interfaces should not receive touch-target complaints unless the change clearly introduces a device-relevant interaction problem.
- Only use "small_touch_target" when touch interaction is genuinely relevant for the chosen device context.
- For desktop reviews, do NOT use touch language such as "tap", "finger", or "touch target".
- For desktop reviews, use desktop wording such as "click", "click target", "small control", or "hard to click".

Changed nodes:
${JSON.stringify(changedNodes, null, 2)}
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

function extractComparableNodeSnapshot(node) {
	if (!node || typeof node !== "object") return null;

	return {
		id: node.id,
		name: node.name,
		type: node.type,
		visible: node.visible,
		width: node.width,
		height: node.height,
		x: node.x,
		y: node.y,
		text: node.text,
		fontSize: node.fontSize,
		fills: Array.isArray(node.fills) ? [...node.fills] : [],
		fingerprint: node.fingerprint,
	};
}

function arraysEqual(a = [], b = []) {
	if (!Array.isArray(a) || !Array.isArray(b)) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function getChangedFields(previousNode, currentNode) {
	if (!previousNode || !currentNode) {
		return ["new_node"];
	}

	const changed = [];

	if (previousNode.name !== currentNode.name) changed.push("name");
	if (previousNode.type !== currentNode.type) changed.push("type");
	if (previousNode.visible !== currentNode.visible) changed.push("visible");
	if (previousNode.width !== currentNode.width) changed.push("width");
	if (previousNode.height !== currentNode.height) changed.push("height");
	if (previousNode.x !== currentNode.x) changed.push("x");
	if (previousNode.y !== currentNode.y) changed.push("y");
	if ((previousNode.text || "") !== (currentNode.text || ""))
		changed.push("text");
	if (previousNode.fontSize !== currentNode.fontSize)
		changed.push("fontSize");
	if (!arraysEqual(previousNode.fills || [], currentNode.fills || [])) {
		changed.push("fills");
	}

	return changed;
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

function buildBatchUpdateResponseSchema() {
	return {
		type: "json_schema",
		name: "accessibility_review_batch_update",
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				overall_assessment: { type: "string" },
				updated_nodes: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							node_id: { type: "string" },
							node_name: { type: "string" },
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
						required: ["node_id", "node_name", "issues"],
					},
				},
			},
			required: ["overall_assessment", "updated_nodes"],
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

async function updateChangedNodesWithModel({
	changedNodes,
	client,
	deviceType,
}) {
	if (!Array.isArray(changedNodes) || changedNodes.length === 0) {
		return {
			overall_assessment: "",
			updatedNodes: [],
		};
	}

	const normalizedChangedNodes = changedNodes.map((item) => ({
		node_id: item.currentNode.id,
		node_name: item.currentNode.name,
		previousNode: item.previousNode,
		currentNode: item.currentNode,
		changedFields: item.changedFields,
		previousIssues: item.previousIssues,
	}));

	const prompt = buildBatchNodeUpdatePrompt(
		normalizedChangedNodes,
		deviceType,
	);

	const response = await client.responses.create({
		model: "gpt-5-mini",
		input: prompt,
		text: {
			format: buildBatchUpdateResponseSchema(),
		},
	});

	const parsed = JSON.parse(response.output_text);
	const updatedNodesRaw = Array.isArray(parsed.updated_nodes)
		? parsed.updated_nodes
		: [];

	const resultByNodeId = new Map();

	for (const item of changedNodes) {
		const singleNodeScreen = {
			selectionCount: 1,
			totalNodes: 1,
			textNodes: item.currentNode.type === "TEXT" ? 1 : 0,
			nodes: [item.currentNode],
		};
		const nodeIndex = buildNodeIndex(singleNodeScreen);

		const matchingRaw = updatedNodesRaw.find(
			(entry) => entry && entry.node_id === item.currentNode.id,
		);

		const rawIssues = Array.isArray(matchingRaw?.issues)
			? matchingRaw.issues
			: [];

		const normalizedIssues = rawIssues
			.map((issue) => normalizeIssue(issue, nodeIndex))
			.filter(Boolean);

		resultByNodeId.set(item.currentNode.id, {
			nodeId: item.currentNode.id,
			nodeName: item.currentNode.name,
			issues: dedupeIssues(normalizedIssues),
			changedFields: item.changedFields,
		});
	}

	return {
		overall_assessment: parsed.overall_assessment || "",
		updatedNodes: Array.from(resultByNodeId.values()),
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

function buildSubScreenFromNodes(nodes) {
	const compactNodes = nodes.map((node) => ({
		id: node.id,
		name: node.name,
		type: node.type,
		visible: node.visible,
		width: node.width,
		height: node.height,
		x: node.x,
		y: node.y,
		text: node.text,
		fontSize: node.fontSize,
		fills: node.fills,
		fingerprint: node.fingerprint,
	}));

	return {
		selectionCount: compactNodes.length,
		totalNodes: compactNodes.length,
		textNodes: compactNodes.filter((n) => n.type === "TEXT").length,
		nodes: compactNodes,
	};
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
		const fileReviewCache = getUserFileReviewCache(
			reviewCacheStore,
			userId,
			fileKey,
		);

		const currentNodes = compactScreen.nodes || [];
		const reusedIssues = [];
		const newNodesToReview = [];
		const changedNodesToReview = [];
		const currentNodeIds = new Set();

		for (const node of currentNodes) {
			currentNodeIds.add(node.id);

			const currentFingerprint =
				typeof node.fingerprint === "string" &&
				node.fingerprint.length > 0
					? node.fingerprint
					: stableHash(node);

			const cachedEntry = fileReviewCache[node.id];

			if (!cachedEntry) {
				newNodesToReview.push(node);
				continue;
			}

			const cachedFingerprint = cachedEntry.fingerprint || null;
			const cachedIssues = Array.isArray(cachedEntry.issues)
				? cachedEntry.issues
				: [];
			const cachedDeviceType = cachedEntry.deviceType || "desktop";

			const sameFingerprint = cachedFingerprint === currentFingerprint;
			const sameDeviceType = cachedDeviceType === deviceType;

			if (sameFingerprint && sameDeviceType) {
				reusedIssues.push(...cachedIssues);
				continue;
			}

			if (sameFingerprint && !sameDeviceType) {
				newNodesToReview.push(node);
				continue;
			}

			const currentNode = extractComparableNodeSnapshot(node);
			const previousNode =
				extractComparableNodeSnapshot(cachedEntry.nodeSnapshot) ||
				extractComparableNodeSnapshot({
					id: cachedEntry.nodeId,
					name: cachedEntry.nodeName,
					...cachedEntry.nodeSnapshot,
				}) ||
				currentNode;

			changedNodesToReview.push({
				currentNode,
				previousNode,
				previousIssues: cachedIssues,
				previousFingerprint: cachedFingerprint,
				changedFields: getChangedFields(previousNode, currentNode),
			});
		}

		for (const cachedNodeId of Object.keys(fileReviewCache)) {
			if (!currentNodeIds.has(cachedNodeId)) {
				delete fileReviewCache[cachedNodeId];
			}
		}

		let newNodeIssues = [];
		let changedNodeIssues = [];
		let overallAssessment = "";
		let changedNodeSummaries = [];

		if (newNodesToReview.length > 0) {
			const subScreen = buildSubScreenFromNodes(newNodesToReview);
			const subNodeIndex = buildNodeIndex(subScreen);

			const analysis = await analyzeScreenWithModel(
				subScreen,
				subNodeIndex,
				client,
				selectionImage,
				deviceType,
			);

			newNodeIssues = analysis.issues;
			overallAssessment = analysis.overall_assessment || "";

			const issuesByNodeId = new Map();
			for (const issue of newNodeIssues) {
				if (!issuesByNodeId.has(issue.node_id)) {
					issuesByNodeId.set(issue.node_id, []);
				}
				issuesByNodeId.get(issue.node_id).push(issue);
			}

			for (const node of newNodesToReview) {
				const currentFingerprint =
					typeof node.fingerprint === "string" &&
					node.fingerprint.length > 0
						? node.fingerprint
						: stableHash(node);

				fileReviewCache[node.id] = {
					nodeId: node.id,
					nodeName: node.name,
					fingerprint: currentFingerprint,
					deviceType,
					nodeSnapshot: extractComparableNodeSnapshot(node),
					issues: issuesByNodeId.get(node.id) || [],
					reviewedAt: new Date().toISOString(),
				};
			}
		}

		if (changedNodesToReview.length > 0) {
			const updatedBatch = await updateChangedNodesWithModel({
				changedNodes: changedNodesToReview,
				client,
				deviceType,
			});

			if (!overallAssessment) {
				overallAssessment = updatedBatch.overall_assessment || "";
			}

			for (const updatedNode of updatedBatch.updatedNodes) {
				changedNodeIssues.push(...updatedNode.issues);

				const originalItem = changedNodesToReview.find(
					(item) => item.currentNode.id === updatedNode.nodeId,
				);

				changedNodeSummaries.push({
					nodeId: updatedNode.nodeId,
					nodeName: updatedNode.nodeName,
					changedFields: updatedNode.changedFields,
					previousIssueCount:
						originalItem?.previousIssues?.length || 0,
					updatedIssueCount: updatedNode.issues.length,
				});

				const currentNode = originalItem?.currentNode;
				if (!currentNode) continue;

				const currentFingerprint =
					typeof currentNode.fingerprint === "string" &&
					currentNode.fingerprint.length > 0
						? currentNode.fingerprint
						: stableHash(currentNode);

				fileReviewCache[currentNode.id] = {
					nodeId: currentNode.id,
					nodeName: currentNode.name,
					fingerprint: currentFingerprint,
					deviceType,
					nodeSnapshot: extractComparableNodeSnapshot(currentNode),
					issues: updatedNode.issues,
					reviewedAt: new Date().toISOString(),
				};
			}
		}

		writeReviewCache(reviewCacheStore);

		const mergedIssues = dedupeIssues([
			...reusedIssues,
			...newNodeIssues,
			...changedNodeIssues,
		]).map((issue) => ({
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

		const visibleIssues = mergedIssues.filter((issue) => {
			const resolvedKey = getResolvedIssueKey(fileKey, issue);
			return !resolvedIssueKeys.has(resolvedKey);
		});

		const parsed = {
			summary: {
				total_nodes: compactScreen.totalNodes,
				text_nodes: compactScreen.textNodes,
			},
			overall_assessment:
				overallAssessment ||
				(newNodesToReview.length === 0 &&
				changedNodesToReview.length === 0
					? "No element changes detected since the last check. Reusing existing issue results for the current selection."
					: changedNodesToReview.length > 0 &&
						  newNodesToReview.length === 0
						? "Updated issues for changed elements in one batch and reused results for unchanged elements."
						: visibleIssues.length === 0
							? "Issues reviewed for new or changed elements. No visible issues to show after filtering."
							: "Issues updated for new or changed elements and reused for unchanged elements."),
			issues: visibleIssues,
		};

		appendEvent({
			userId,
			sessionId,
			condition,
			demandMode,
			deviceType,
			fileKey,
			eventType: "check_completed",
			issueCount: Array.isArray(parsed.issues) ? parsed.issues.length : 0,
			reusedIssueCount: reusedIssues.length,
			newlyReviewedIssueCount: newNodeIssues.length,
			updatedChangedNodeIssueCount: changedNodeIssues.length,
			newNodeCount: newNodesToReview.length,
			changedNodeCount: changedNodesToReview.length,
			unchangedNodeCount:
				currentNodes.length -
				newNodesToReview.length -
				changedNodesToReview.length,
			changedNodeSummaries,
			hasSelectionImage:
				typeof selectionImage?.imageBase64 === "string" &&
				selectionImage.imageBase64.length > 0,
			overallAssessment: parsed.overall_assessment || "",
			timestamp: new Date().toISOString(),
		});

		res.json(parsed);
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

		const refreshedIssue = await recheckSingleIssueWithModel({
			node,
			issueType: issue.issue_type,
			client,
			selectionImage,
			deviceType,
		});

		const reviewCacheStore = readReviewCache();
		const fileReviewCache = getUserFileReviewCache(
			reviewCacheStore,
			userId,
			fileKey,
		);

		const currentFingerprint =
			typeof node.fingerprint === "string" && node.fingerprint.length > 0
				? node.fingerprint
				: stableHash(node);

		const existingEntry = fileReviewCache[node.id] || {
			nodeId: node.id,
			nodeName: node.name,
			fingerprint: currentFingerprint,
			deviceType,
			nodeSnapshot: extractComparableNodeSnapshot(node),
			issues: [],
			reviewedAt: new Date().toISOString(),
		};

		const existingIssues = Array.isArray(existingEntry.issues)
			? existingEntry.issues
			: [];

		const keptIssues = existingIssues.filter(
			(item) => item.issue_type !== issue.issue_type,
		);

		const nextIssues = refreshedIssue
			? dedupeIssues([...keptIssues, refreshedIssue])
			: dedupeIssues(keptIssues);

		fileReviewCache[node.id] = {
			...existingEntry,
			nodeId: node.id,
			nodeName: node.name,
			fingerprint: currentFingerprint,
			deviceType,
			nodeSnapshot: extractComparableNodeSnapshot(node),
			issues: nextIssues,
			reviewedAt: new Date().toISOString(),
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
			issueType: issue.issue_type,
			nodeId: issue.node_id,
			nodeName: issue.node_name || node.name || "",
			stillPresent: !!refreshedIssue,
			timestamp: new Date().toISOString(),
		});

		res.json({
			issueType: issue.issue_type,
			nodeId: issue.node_id,
			issue: refreshedIssue
				? {
						...refreshedIssue,
						node_fingerprint: currentFingerprint,
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
