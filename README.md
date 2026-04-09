# AI Accessibility Checker (Figma Plugin)

## Overview

A Figma plugin that detects accessibility issues in designs using AI and explanations.

---

## Features

- AI-based detection of accessibility issues (e.g., contrast, labels, hierarchy)
- Interactive issue cards with:
    - Fix suggestions (always visible)
    - Optional explanations
- Three explanation modes:
    - **On-demand** (button)
    - **Low-demand** (subtle “?” with nudge)
    - **Always-visible**
- Issue dismissal with persistence across sessions
- Efficient re-analysis using node fingerprinting

---

## Architecture

- **UI:** HTML, CSS, JS (Figma plugin UI)
- **Plugin:** TypeScript (node extraction, communication)
- **Backend:** Node.js + Express + OpenAI API

---

## Setup

### Backend

```bash
npm install
node server.js
```
