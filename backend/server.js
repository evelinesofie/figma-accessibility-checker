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
	return `${issue.issue_type || "other"}|${issue.node_id || "unknown-node"}`;
}

function getDismissedKey(userId, fileKey, issue) {
	return `${userId}|${fileKey}|${createIssueKey(issue)}`;
}

function getDismissedNodeStateKey(fileKey, nodeId, nodeFingerprint) {
	return `${fileKey}|${nodeId}|${nodeFingerprint || "no-fingerprint"}`;
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

function dismissIssueForUser(userId, fileKey, issue, nodeFingerprint) {
	const store = readDismissedIssues();
	const existing = Array.isArray(store[userId]) ? store[userId] : [];
	const dismissKey = getDismissedKey(userId, fileKey, issue);
	const nodeStateKey = getDismissedNodeStateKey(
		fileKey,
		issue.node_id,
		nodeFingerprint,
	);

	const updatedEntries = existing.filter((item) => {
		if (item.fileKey !== fileKey) return true;
		if (item.nodeId !== issue.node_id) return true;

		return item.nodeFingerprint !== nodeFingerprint;
	});

	updatedEntries.push({
		dismissKey,
		fileKey,
		issueType: issue.issue_type,
		nodeId: issue.node_id,
		nodeName: issue.node_name,
		nodeFingerprint: nodeFingerprint || null,
		nodeStateKey,
		dismissedAt: new Date().toISOString(),
	});

	store[userId] = updatedEntries;
	writeDismissedIssues(store);
}

function resetDismissedIssuesForUser(userId, fileKey) {
	const store = readDismissedIssues();
	const existing = Array.isArray(store[userId]) ? store[userId] : [];
	store[userId] = existing.filter((item) => item.fileKey !== fileKey);
	writeDismissedIssues(store);
}

function getActiveDismissedMapForUserAndFile(userId, fileKey, nodeIndex) {
	const store = readDismissedIssues();
	const entries = Array.isArray(store[userId]) ? store[userId] : [];
	const activeByNodeState = new Set();
	const staleDismissKeys = [];

	for (const item of entries) {
		if (item.fileKey !== fileKey) continue;

		const currentFingerprint = getNodeFingerprintFromIndex(
			nodeIndex,
			item.nodeId,
		);

		if (!currentFingerprint) {
			continue;
		}

		if (
			!item.nodeFingerprint ||
			item.nodeFingerprint === currentFingerprint
		) {
			const nodeStateKey = getDismissedNodeStateKey(
				fileKey,
				item.nodeId,
				currentFingerprint,
			);
			activeByNodeState.add(nodeStateKey);
		} else {
			staleDismissKeys.push(item.dismissKey);
		}
	}

	if (staleDismissKeys.length > 0) {
		const filtered = entries.filter(
			(item) => !staleDismissKeys.includes(item.dismissKey),
		);
		store[userId] = filtered;
		writeDismissedIssues(store);
	}

	return activeByNodeState;
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

function buildPrompt(compactScreen) {
	return `
You are an AI accessibility reviewer for Figma screens.

Your task is to inspect the provided screen structure and identify likely accessibility issues.
Be useful, grounded, and selective. Focus on the strongest plausible design-level accessibility concerns supported by the provided data.

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

General guidelines:
- You are reviewing a design mockup, not live code.
- Focus on issues such as very small text, weak hierarchy, unclear labels, likely color contrast problems, and touch targets that appear too small.
- Base every issue strictly on evidence visible in the provided data.
- Do not invent technical details you cannot infer.
- Return at most 10 issues.
- Prefer fewer, stronger, better-grounded issues over many weak ones.
- If there are no clear issues, return an empty issues array and a short overall assessment.
- Only report issues that can be meaningfully improved in the Figma design itself.
- Do not report implementation-only or code-only accessibility issues.
- Exclude issues such as missing alt text, ARIA attributes, semantic HTML structure, keyboard event handling, screen reader roles, or other properties that cannot be directly fixed in Figma.
- If an issue depends mainly on front-end code rather than the design mockup, do not include it.

Figma-fixable issue guidance:
- Include only issues that a designer could act on by changing text, color, size, spacing, labels, hierarchy, or visual structure in the mockup.
- Exclude issues that require developer implementation, content management settings, or code-level semantics.

Node anchoring requirements:
- Each issue must be tied to ONE specific node.
- node_id must exactly match the "id" field of a node from the provided screen data.
- node_name must exactly match the "name" field of that same node.
- Do not invent or modify node_id or node_name.
- Always select the most relevant node for the issue.

Issue deduplication requirements:
- Do not report multiple issues of the same issue_type for the same node.
- Do not create near-duplicate issues that describe the same underlying problem in slightly different words.
- If several possible concerns exist on one node, choose the single most important one unless a second issue is clearly distinct and strongly justified.

Issue typing:
- issue_type must be exactly one of:
  "small_text", "low_contrast", "small_touch_target", "unclear_label", "weak_visual_hierarchy", "other"
- Do not invent new issue types.

Writing requirements for UI use:
- title must be short, concrete, and descriptive.
- Prefer element-first titles such as "Button has no visible text label" or "Text may have low contrast".
- explanation should briefly describe what is wrong in 1–2 sentences.
- why_it_matters should briefly explain the user impact in 1–2 sentences.
- suggestion should be a short, actionable fix line suitable for showing directly on the issue card.
- Avoid debug-style wording, internal system language, code references, or implementation details.

Contrast-specific guidance:
- When solid hex colors are available for text and its likely background, treat contrast as a stronger and more reliable signal.
- If the foreground and background hex colors appear very similar, you may state the contrast concern more confidently.
- If the available hex values strongly suggest low contrast, explain that the issue is based on the provided color values rather than a visual guess.
- If the background color is unclear, missing, layered, or cannot be reasonably inferred, use more cautious wording such as "may have low contrast" or "contrast is difficult to verify from the available design data."
- Do not claim exact WCAG compliance or failure unless the provided data makes that judgment reasonably supportable.
- Prefer grounded contrast judgments from provided hex values over vague visual speculation.

Uncertainty guidance:
- Be confident when the data is strong.
- Be cautious when the data is incomplete.
- If evidence is weak, do not report the issue.

Tone:
- Keep explanations clear, practical, and designer-friendly.

Screen data:
${JSON.stringify(compactScreen, null, 2)}
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

async function analyzeScreenWithModel(compactScreen, nodeIndex, client) {
	const prompt = buildPrompt(compactScreen);

	const response = await client.responses.create({
		model: "gpt-5-mini",
		input: prompt,
		text: {
			format: {
				type: "json_schema",
				name: "accessibility_review",
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
			},
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
app.use(express.json({ limit: "2mb" }));

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
		const nodeIndex = buildNodeIndex(compactScreen);

		const userId = req.headers["x-user-id"] || "unknown";
		const sessionId = req.headers["x-session-id"] || "unknown";
		const condition = req.headers["x-condition"] || "unknown";
		const demandMode = req.headers["x-demand-mode"] || "unknown";
		const uiMode = req.headers["x-ui-mode"] || "unknown";
		const fileKey =
			req.headers["x-file-key"] ||
			req.body?.meta?.fileKey ||
			"unknown-file";

		appendEvent({
			userId,
			sessionId,
			condition,
			uiMode,
			demandMode,
			fileKey,
			eventType: "run_check",
			selectionCount: compactScreen.selectionCount,
			totalNodes: compactScreen.totalNodes,
			textNodes: compactScreen.textNodes,
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
		const nodesToReview = [];
		const currentNodeIds = new Set();

		for (const node of currentNodes) {
			currentNodeIds.add(node.id);

			const currentFingerprint =
				typeof node.fingerprint === "string" &&
				node.fingerprint.length > 0
					? node.fingerprint
					: stableHash(node);

			const cachedEntry = fileReviewCache[node.id];

			if (
				cachedEntry &&
				cachedEntry.fingerprint === currentFingerprint &&
				Array.isArray(cachedEntry.issues)
			) {
				reusedIssues.push(...cachedEntry.issues);
			} else {
				nodesToReview.push(node);
			}
		}

		for (const cachedNodeId of Object.keys(fileReviewCache)) {
			if (!currentNodeIds.has(cachedNodeId)) {
				delete fileReviewCache[cachedNodeId];
			}
		}

		let newlyReviewedIssues = [];
		let overallAssessment = "";

		if (nodesToReview.length > 0) {
			const subScreen = buildSubScreenFromNodes(nodesToReview);
			const subNodeIndex = buildNodeIndex(subScreen);

			const analysis = await analyzeScreenWithModel(
				subScreen,
				subNodeIndex,
				client,
			);

			newlyReviewedIssues = analysis.issues;
			overallAssessment = analysis.overall_assessment || "";

			const issuesByNodeId = new Map();
			for (const issue of newlyReviewedIssues) {
				if (!issuesByNodeId.has(issue.node_id)) {
					issuesByNodeId.set(issue.node_id, []);
				}
				issuesByNodeId.get(issue.node_id).push(issue);
			}

			for (const node of nodesToReview) {
				const currentFingerprint =
					typeof node.fingerprint === "string" &&
					node.fingerprint.length > 0
						? node.fingerprint
						: stableHash(node);

				fileReviewCache[node.id] = {
					nodeId: node.id,
					nodeName: node.name,
					fingerprint: currentFingerprint,
					issues: issuesByNodeId.get(node.id) || [],
					reviewedAt: new Date().toISOString(),
				};
			}

			writeReviewCache(reviewCacheStore);
		}

		const mergedIssues = dedupeIssues([
			...reusedIssues,
			...newlyReviewedIssues,
		]).map((issue) => ({
			...issue,
			node_fingerprint: getNodeFingerprintFromIndex(
				nodeIndex,
				issue.node_id,
			),
		}));

		const activeDismissedNodeStates = getActiveDismissedMapForUserAndFile(
			userId,
			fileKey,
			nodeIndex,
		);

		const visibleIssues = mergedIssues.filter((issue) => {
			const currentFingerprint = getNodeFingerprintFromIndex(
				nodeIndex,
				issue.node_id,
			);

			const nodeStateKey = getDismissedNodeStateKey(
				fileKey,
				issue.node_id,
				currentFingerprint,
			);

			return !activeDismissedNodeStates.has(nodeStateKey);
		});

		const parsed = {
			summary: {
				total_nodes: compactScreen.totalNodes,
				text_nodes: compactScreen.textNodes,
			},
			overall_assessment:
				overallAssessment ||
				(nodesToReview.length === 0
					? "No element changes detected since the last check."
					: visibleIssues.length === 0
						? "Issues reviewed for changed elements. No visible issues to show after filtering."
						: "Issues updated for changed elements and reused for unchanged elements."),
			issues: visibleIssues,
		};

		appendEvent({
			userId,
			sessionId,
			condition,
			uiMode,
			demandMode,
			fileKey,
			eventType: "check_completed",
			issueCount: Array.isArray(parsed.issues) ? parsed.issues.length : 0,
			reusedIssueCount: reusedIssues.length,
			newlyReviewedIssueCount: newlyReviewedIssues.length,
			reviewedNodeCount: nodesToReview.length,
			unchangedNodeCount: currentNodes.length - nodesToReview.length,
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
		const uiMode = req.headers["x-ui-mode"] || "unknown";
		const fileKey =
			req.headers["x-file-key"] || req.body.fileKey || "unknown-file";

		const record = {
			userId,
			sessionId,
			condition,
			uiMode,
			demandMode,
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

app.post("/dismiss-issue", (req, res) => {
	try {
		const userId = req.headers["x-user-id"] || req.body.userId || "unknown";
		const sessionId = req.headers["x-session-id"] || "unknown";
		const condition = req.headers["x-condition"] || "unknown";
		const demandMode = req.headers["x-demand-mode"] || "unknown";
		const uiMode = req.headers["x-ui-mode"] || "unknown";
		const fileKey =
			req.headers["x-file-key"] || req.body.fileKey || "unknown-file";

		const issue = req.body.issue;
		const nodeFingerprint =
			typeof req.body.nodeFingerprint === "string"
				? req.body.nodeFingerprint
				: null;

		if (!issue || !issue.issue_type || !issue.node_id) {
			return res.status(400).json({
				error: true,
				message: "Missing required issue identity fields",
			});
		}

		dismissIssueForUser(userId, fileKey, issue, nodeFingerprint);

		appendEvent({
			userId,
			sessionId,
			condition,
			uiMode,
			demandMode,
			fileKey,
			eventType: "issue_dismissed",
			issueType: issue.issue_type,
			nodeId: issue.node_id,
			nodeName: issue.node_name || "",
			nodeFingerprint,
			timestamp: new Date().toISOString(),
		});

		res.json({ ok: true });
	} catch (error) {
		console.error("Dismiss issue error:", error);
		res.status(500).json({
			error: true,
			message:
				error instanceof Error
					? error.message
					: "Unknown dismiss error",
		});
	}
});

app.post("/reset-dismissed-issues", (req, res) => {
	try {
		const userId = req.headers["x-user-id"] || req.body.userId || "unknown";
		const sessionId = req.headers["x-session-id"] || "unknown";
		const condition = req.headers["x-condition"] || "unknown";
		const demandMode = req.headers["x-demand-mode"] || "unknown";
		const uiMode = req.headers["x-ui-mode"] || "unknown";
		const fileKey =
			req.headers["x-file-key"] || req.body.fileKey || "unknown-file";

		resetDismissedIssuesForUser(userId, fileKey);

		appendEvent({
			userId,
			sessionId,
			condition,
			uiMode,
			demandMode,
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
