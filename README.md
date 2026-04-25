# Tribunal — Multi-Model AI Validator

Chrome extension that orchestrates structured discussions between Claude, ChatGPT, and Gemini using your existing subscriptions.

## How It Works

1. Open the extension popup
2. Enter your prompt and select a starting model
3. Choose how many discussion passes (1-10)
4. Click "Start Discussion"
5. The extension opens model tabs, injects prompts, captures responses, and routes critiques between models
6. View the full discussion and final synthesized answer

## Installation (Development)

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select this folder (`ai-validation-extension/`)
5. The Tribunal icon appears in your extensions bar

## Prerequisites

- You must be logged into claude.ai, chatgpt.com, and gemini.google.com
- Works with free and paid subscriptions

## Project Structure

```
ai-validation-extension/
  manifest.json           — Extension config
  src/
    background/index.js   — Orchestration logic
    content/
      claude.js           — Content script for claude.ai
      chatgpt.js          — Content script for chatgpt.com
      gemini.js           — Content script for gemini.google.com
    popup/
      popup.html          — Extension popup UI
      popup.js            — Popup interactions
    utils/
      prompts.js          — Critique/revision/synthesis templates
      storage.js          — Chrome storage utilities
  public/icons/           — Extension icons
```
