# AccessibilityCheck

A Figma plugin prototype for AI-powered accessibility checking with on-demand explanations.

## Structure

- `ui.html`: plugin UI
- `code.ts`: Figma plugin controller
- `backend/server.js`: local backend for GPT calls and logging

## Setup

### Plugin

```bash
npm install
npm run build
cd backend
npm install
npm run dev
