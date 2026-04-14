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
const reviewCacheFile = path.join(dataDir, "review_cache.json");

if (!fs.existsSync(dataDir)) {
	fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(eventsFile)) {
	fs.writeFileSync(eventsFile, "", "utf8");
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

function getUserFileReviewCache(store, userId, fileKey) {
	if (!store[userId]) store[userId] = {};

	if (!store[userId][fileKey]) {
		store[userId][fileKey] = {
			screens: {},
			nodeReviews: {},
			latestSelectionSignature: null,
		};
	}

	if (!store[userId][fileKey].screens) {
		store[userId][fileKey].screens = {};
	}

	if (!store[userId][fileKey].nodeReviews) {
		store[userId][fileKey].nodeReviews = {};
	}

	return store[userId][fileKey];
}

function makeCompactScreen(screen) {
	const nodes = Array.isArray(screen?.nodes) ? screen.nodes : [];

	const compactNodes = nodes.slice(0, 300).map((node) => ({
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
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

	return stableHash({
		deviceType,
		selectionCount: compactScreen.selectionCount,
		totalNodes: compactScreen.totalNodes,
		textNodes: compactScreen.textNodes,
		nodes: normalizedNodes,
	});
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

function buildChangedNodesReviewPrompt(changedNodes, deviceType) {
	return `
You are an AI accessibility reviewer for changed nodes within an already-reviewed Figma screen.

Only review the nodes provided below.
Do not infer new issues for unrelated unchanged parts of the screen.
Return only issues tied to the provided node ids.

Return ONLY valid JSON with this exact structure:

{
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
- Only report issues for the provided node ids.
- node_id must exactly match one of the provided node ids.
- node_name must exactly match that node's name.
- Do not report duplicate issue types for the same node.
- Prefer fewer, stronger issues.
- Be conservative.

Use these issue types only:
- "small_text"
- "low_contrast"
- "small_touch_target"
- "unclear_label"
- "weak_visual_hierarchy"
- "other"

Device context:
- This prototype should be reviewed as a ${deviceType} interface.

Changed node data:
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

function buildChangedNodesResponseSchema() {
	return {
		type: "json_schema",
		name: "accessibility_changed_nodes_review",
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
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
			required: ["issues"],
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

	const content = [{ type: "input_text", text: prompt }];

	if (hasSelectionImage) {
		content.push({
			type: "input_image",
			image_url: `data:${selectionImage.mimeType || "image/png"};base64,${selectionImage.imageBase64}`,
		});
	}

	const response = await client.responses.create({
		model: "gpt-5.4-mini",
		input: [{ role: "user", content }],
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

async function analyzeChangedNodesWithModel(
	changedNodes,
	nodeIndex,
	client,
	deviceType,
) {
	if (!changedNodes.length) {
		return [];
	}

	const prompt = buildChangedNodesReviewPrompt(changedNodes, deviceType);

	const response = await client.responses.create({
		model: "gpt-5.4-mini",
		input: [
			{
				role: "user",
				content: [{ type: "input_text", text: prompt }],
			},
		],
		text: {
			format: buildChangedNodesResponseSchema(),
		},
	});

	const parsed = JSON.parse(response.output_text);
	const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];

	return dedupeIssues(
		rawIssues
			.map((issue) => normalizeIssue(issue, nodeIndex))
			.filter(Boolean),
	);
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

	const content = [{ type: "input_text", text: prompt }];

	if (hasSelectionImage) {
		content.push({
			type: "input_image",
			image_url: `data:${selectionImage.mimeType || "image/png"};base64,${selectionImage.imageBase64}`,
		});
	}

	const response = await client.responses.create({
		model: "gpt-5.4-mini",
		input: [{ role: "user", content }],
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

function groupIssuesByNodeId(issues) {
	const byNodeId = new Map();

	for (const issue of issues || []) {
		if (!issue?.node_id) continue;

		if (!byNodeId.has(issue.node_id)) {
			byNodeId.set(issue.node_id, []);
		}

		byNodeId.get(issue.node_id).push(issue);
	}

	return byNodeId;
}

function materializeIssuesFromNodeReviews(
	nodeReviews,
	currentNodes,
	nodeIndex,
) {
	const issues = [];

	for (const node of currentNodes) {
		const stored = nodeReviews[node.id];
		if (!stored) continue;

		const currentFingerprint = getNodeFingerprintFromIndex(
			nodeIndex,
			node.id,
		);
		if (!currentFingerprint) continue;

		if (stored.fingerprint !== currentFingerprint) {
			continue;
		}

		for (const issue of stored.issues || []) {
			issues.push({
				...issue,
				node_id: node.id,
				node_name: node.name,
				node_fingerprint: currentFingerprint,
			});
		}
	}

	return dedupeIssues(issues);
}

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "20mb" }));

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

		const nodeReviews = fileCache.nodeReviews || {};
		const currentNodes = compactScreen.nodes || [];
		const currentNodeIds = new Set(currentNodes.map((node) => node.id));

		const existingNodeReviewCount = Object.keys(nodeReviews).length;
		const isFirstReview = existingNodeReviewCount === 0;

		let overallAssessment = "AI review completed.";
		let reusedNodeCount = 0;
		let changedNodeCount = 0;
		let newNodeCount = 0;
		let removedNodeCount = 0;

		if (isFirstReview) {
			const analysis = await analyzeScreenWithModel(
				compactScreen,
				nodeIndex,
				client,
				selectionImage,
				deviceType,
			);

			overallAssessment =
				analysis.overall_assessment || overallAssessment;

			const issuesByNodeId = groupIssuesByNodeId(analysis.issues);

			for (const node of currentNodes) {
				const fingerprint = getNodeFingerprintFromIndex(
					nodeIndex,
					node.id,
				);
				if (!fingerprint) continue;

				nodeReviews[node.id] = {
					nodeId: node.id,
					nodeName: node.name || "",
					fingerprint,
					issues: dedupeIssues(issuesByNodeId.get(node.id) || []),
					lastReviewedAt: new Date().toISOString(),
				};
			}

			newNodeCount = currentNodes.length;
		} else {
			const changedOrNewNodes = [];

			for (const node of currentNodes) {
				const fingerprint = getNodeFingerprintFromIndex(
					nodeIndex,
					node.id,
				);
				if (!fingerprint) continue;

				const existing = nodeReviews[node.id];

				if (!existing) {
					newNodeCount += 1;
					changedOrNewNodes.push(node);
					continue;
				}

				if (existing.fingerprint === fingerprint) {
					reusedNodeCount += 1;
					existing.nodeName = node.name || "";
					continue;
				}

				changedNodeCount += 1;
				changedOrNewNodes.push(node);
			}

			for (const storedNodeId of Object.keys(nodeReviews)) {
				if (!currentNodeIds.has(storedNodeId)) {
					delete nodeReviews[storedNodeId];
					removedNodeCount += 1;
				}
			}

			const changedIssues = await analyzeChangedNodesWithModel(
				changedOrNewNodes,
				nodeIndex,
				client,
				deviceType,
			);

			const changedIssuesByNodeId = groupIssuesByNodeId(changedIssues);

			for (const node of changedOrNewNodes) {
				const fingerprint = getNodeFingerprintFromIndex(
					nodeIndex,
					node.id,
				);
				if (!fingerprint) continue;

				nodeReviews[node.id] = {
					nodeId: node.id,
					nodeName: node.name || "",
					fingerprint,
					issues: dedupeIssues(
						changedIssuesByNodeId.get(node.id) || [],
					),
					lastReviewedAt: new Date().toISOString(),
				};
			}
		}

		fileCache.latestSelectionSignature = selectionSignature;
		fileCache.screens[selectionSignature] = {
			selectionSignature,
			deviceType,
			nodeIds: currentNodes.map((node) => node.id),
			reviewedAt: new Date().toISOString(),
		};

		writeReviewCache(reviewCacheStore);

		const finalIssues = materializeIssuesFromNodeReviews(
			nodeReviews,
			currentNodes,
			nodeIndex,
		);

		appendEvent({
			userId,
			sessionId,
			condition,
			demandMode,
			deviceType,
			fileKey,
			eventType: "check_completed_incremental",
			selectionSignature,
			isFirstReview,
			reusedNodeCount,
			changedNodeCount,
			newNodeCount,
			removedNodeCount,
			finalIssueCount: finalIssues.length,
			timestamp: new Date().toISOString(),
		});

		res.json({
			summary: {
				total_nodes: compactScreen.totalNodes,
				text_nodes: compactScreen.textNodes,
			},
			overall_assessment: overallAssessment,
			issues: finalIssues,
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

		const reviewCacheStore = readReviewCache();
		const fileCache = getUserFileReviewCache(
			reviewCacheStore,
			userId,
			fileKey,
		);

		const nodeReview = fileCache.nodeReviews[issue.node_id];

		if (!nodeReview) {
			return res.status(404).json({
				error: true,
				message: "Could not find stored node review for this node",
			});
		}

		nodeReview.issues = (nodeReview.issues || []).filter(
			(item) => item.issue_type !== issue.issue_type,
		);
		nodeReview.lastReviewedAt = new Date().toISOString();

		writeReviewCache(reviewCacheStore);

		appendEvent({
			userId,
			sessionId,
			condition,
			demandMode,
			deviceType,
			fileKey,
			eventType: "issue_resolved",
			nodeId: issue.node_id,
			nodeName: issue.node_name || "",
			issueType: issue.issue_type,
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
		const selectionImage =
			req.body.nodeImage || req.body.selectionImage || null;
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

		const fingerprint = getNodeFingerprintFromIndex(nodeIndex, node.id);
		if (!fingerprint) {
			return res.status(400).json({
				error: true,
				message: "Could not compute fingerprint for target node",
			});
		}

		const refreshedIssue = await recheckSingleIssueWithModel({
			node,
			issueType: issue.issue_type,
			client,
			selectionImage,
			deviceType,
		});

		const reviewCacheStore = readReviewCache();
		const fileCache = getUserFileReviewCache(
			reviewCacheStore,
			userId,
			fileKey,
		);

		if (!fileCache.nodeReviews[issue.node_id]) {
			fileCache.nodeReviews[issue.node_id] = {
				nodeId: node.id,
				nodeName: node.name || "",
				fingerprint,
				issues: [],
				lastReviewedAt: new Date().toISOString(),
			};
		}

		const nodeReview = fileCache.nodeReviews[issue.node_id];
		nodeReview.nodeName = node.name || "";
		nodeReview.fingerprint = fingerprint;
		nodeReview.lastReviewedAt = new Date().toISOString();

		const keptIssues = (nodeReview.issues || []).filter(
			(item) => item.issue_type !== issue.issue_type,
		);

		if (refreshedIssue) {
			keptIssues.push(refreshedIssue);
		}

		nodeReview.issues = dedupeIssues(keptIssues);

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
			fingerprint,
			timestamp: new Date().toISOString(),
		});

		res.json({
			issueType: issue.issue_type,
			nodeId: issue.node_id,
			issue: refreshedIssue
				? {
						...refreshedIssue,
						node_fingerprint: fingerprint,
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

		const reviewCacheStore = readReviewCache();
		const fileCache = getUserFileReviewCache(
			reviewCacheStore,
			userId,
			fileKey,
		);

		fileCache.nodeReviews = {};
		fileCache.screens = {};
		fileCache.latestSelectionSignature = null;

		writeReviewCache(reviewCacheStore);

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
