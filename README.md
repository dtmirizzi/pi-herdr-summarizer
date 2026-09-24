# @dtmirizzi/pi-herdr-summarizer

<p align="center">
  <img src="assets/logo.png" width="256" height="256" alt="Logo">
</p>

Auto-name [herdr](https://herdr.ai) workspaces using AI summaries. Reads your pi session to understand what you're working on, then asks an LLM for a short, descriptive label (1–3 words).

## Install

```bash
pi install dtmirizzi/pi-herdr-summarizer
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/dtmirizzi/pi-herdr-summarizer"]
}
```

## Usage

Run `/herdr-summarize` from pi (inside herdr) to auto-name all workspaces.

Or let the LLM call it:

```
summarize my herdr workspaces
```

## API key

Supports any of these environment variables (tried in order):

1. Pi's configured models (OpenRouter, Anthropic, or OpenAI)
2. `OPENROUTER_API_KEY`
3. `ANTHROPIC_API_KEY`
4. `OPENAI_API_KEY`

Falls back to the directory name if no API key is available.

## How it works

1. Calls `herdr api snapshot` to discover workspaces
2. Reads the pi session file for each workspace to find what you're working on
3. Sends the task context to an LLM with a prompt to summarize in 1–3 words
4. Renames the herdr workspace via its socket API

## License

MIT