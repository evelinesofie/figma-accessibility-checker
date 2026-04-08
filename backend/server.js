import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, "data");
const eventsFile = path.join(dataDir, "events.jsonl");

if (!fs.existsSync(dataDir)) {
	fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(eventsFile)) {
	fs.writeFileSync(eventsFile, "", "utf8");
}

function appendEvent(event) {
	fs.appendFileSync(eventsFile, JSON.stringify(event) + "\n", "utf8");
	console.log("WROTE EVENT TO:", eventsFile);
}

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const client = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

console.log("API key loaded:", !!process.env.OPENAI_API_KEY);

function makeCompactScreen(screen) {
	const nodes = Array.isArray(screen?.nodes) ? screen.nodes : [];

	const compactNodes = nodes.slice(0, 120).map((node) => ({
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
Be useful but not overly strict. Focus on plausible design-level accessibility concerns.

Return ONLY valid JSON with this exact schema:
{
  "summary": {
    "total_nodes": number,
    "text_nodes": number
  },
  "overall_assessment": string,
  "issues": [
    {
      "title": string,
      "node_name": string,
      "severity": "low" | "medium" | "high",
      "explanation": string,
      "why_it_matters": string,
      "suggestion": string
    }
  ]
}

Guidelines:
- You are reviewing a design mockup, not live code.
- Consider issues such as very small text, weak hierarchy, unclear labels, probable contrast concerns based on colors, and touch targets that appear too small.
- Do not invent technical details you cannot infer.
- If evidence is weak, phrase the issue as a likely concern.
- Return at most 6 issues.
- If there are no clear issues, return an empty issues array and a short overall assessment.

Screen data:
${JSON.stringify(compactScreen, null, 2)}
  `.trim();
}

app.get("/health", (_req, res) => {
	res.json({ ok: true });
});

app.post("/analyze", async (req, res) => {
	try {
		const compactScreen = makeCompactScreen(req.body.screen);
		const prompt = buildPrompt(compactScreen);

		const userId = req.headers["x-user-id"] || "unknown";
		const sessionId = req.headers["x-session-id"] || "unknown";
		const condition = req.headers["x-condition"] || "unknown";

		appendEvent({
			userId,
			sessionId,
			condition,
			eventType: "run_check",
			selectionCount: compactScreen.selectionCount,
			totalNodes: compactScreen.totalNodes,
			textNodes: compactScreen.textNodes,
			timestamp: new Date().toISOString(),
		});

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
										title: { type: "string" },
										node_name: { type: "string" },
										severity: {
											type: "string",
											enum: ["low", "medium", "high"],
										},
										explanation: { type: "string" },
										why_it_matters: { type: "string" },
										suggestion: { type: "string" },
									},
									required: [
										"title",
										"node_name",
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

		const outputText = response.output_text;
		const parsed = JSON.parse(outputText);

		if (!parsed.summary) {
			parsed.summary = {
				total_nodes: compactScreen.totalNodes,
				text_nodes: compactScreen.textNodes,
			};
		}

		appendEvent({
			userId,
			sessionId,
			condition,
			eventType: "check_completed",
			issueCount: Array.isArray(parsed.issues) ? parsed.issues.length : 0,
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

		if (error?.status) {
			message = `OpenAI/API error ${error.status}: ${message}`;
		}

		res.status(500).json({
			error: true,
			message,
		});
	}
});

app.post("/log", async (req, res) => {
	try {
		const userId = req.headers["x-user-id"] || "unknown";
		const sessionId = req.headers["x-session-id"] || "unknown";
		const condition = req.headers["x-condition"] || "unknown";

		const record = {
			userId,
			sessionId,
			condition,
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

app.listen(port, () => {
	console.log(`Backend listening on http://localhost:${port}`);
});
