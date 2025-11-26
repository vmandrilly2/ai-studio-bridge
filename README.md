# AI Studio Bridge

Stages your open files and a filtered project structure into a temporary folder for quick upload to Google AI Studio.

## Features

- Command `AI Studio: Stage Open Files & Structure` available from the Command Palette and context menus.
- Generates `_PROJECT_STRUCTURE.txt` based on `.gitignore` and standard ignore folders.
- Flattens staged file paths (`src/utils/helper.ts` → `src__utils__helper.ts`).
- Shows a webview with a prebuilt system prompt and a button to open the staging folder.

## Usage

1. Open your project.
2. Run `AI Studio: Stage Open Files & Structure`.
3. Drag the staged files from the opened folder into Google AI Studio.

## Requirements

- VS Code `^1.80.0`.

## License

MIT
