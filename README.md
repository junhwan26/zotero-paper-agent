# Paper Agent

Zotero plugin for paper summarization and Q&A in the PDF reader sidebar.

Source code: [https://github.com/junhwan26/zotero-paper-agent](https://github.com/junhwan26/zotero-paper-agent)

## Quick Start (Development)

```bash
cd /Users/junhwan/Desktop/zotero-plugin-template
cp .env.example .env
npm install
npm start
```

Required in `.env`:

- `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`
- `ZOTERO_PLUGIN_PROFILE_PATH`

## Plugin Functions

- Summarize the current paper in the reader sidebar
- Ask questions about the paper (RAG-based context retrieval)
- Keep and continue chat history per paper
- Click summary section headings to jump to PDF pages
- Configure LLM/Embedding endpoints and models in Preferences

## Installing

### Install from Release (recommended)

1. Open the latest release:
   [https://github.com/junhwan26/zotero-paper-agent/releases/latest](https://github.com/junhwan26/zotero-paper-agent/releases/latest)
2. Download the `.xpi` asset
3. In Zotero: `Tools > Plugins > gear icon > Install Plugin From File...`
4. Select the downloaded `.xpi`

### Build `.xpi` locally

```bash
cd /Users/junhwan/Desktop/zotero-plugin-template
npm run build
ls -lah .scaffold/build/*.xpi
```

Build output:

- `.scaffold/build/*.xpi`
- `.scaffold/build/update.json` or `.scaffold/build/update-beta.json`

## Configuration

Open `Preferences > Paper Agent`:

- LLM Endpoint / Model / API Key
- Embedding Endpoint / Model
- Hybrid retrieval on/off
- Local mode (Ollama/OpenAI-compatible)
- Reader standalone mode

Prompts are editable in:

- `addon/content/paperChatPrompts.json`

## Releasing

Use tag-based release workflow:

```bash
npm version patch
git push origin main --follow-tags
```

GitHub Actions will build and publish release assets.

Detailed release guide:

- `GITHUB_RELEASE_GUIDE.md`

## License

AGPL-3.0-or-later
