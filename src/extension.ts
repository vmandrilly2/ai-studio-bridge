import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let currentStagingRoot: string = "";

export function activate(context: vscode.ExtensionContext) {
    // Register command to allow running via Command Palette (Ctrl+Shift+P)
    let disposable = vscode.commands.registerCommand('ai-bridge.stageWorkspace', async () => {
        
        // 1. Setup Staging (Flat Folder)
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        currentStagingRoot = path.join(os.tmpdir(), 'ai-bridge', timestamp);
        const round1Dir = path.join(currentStagingRoot, 'round_1');
        fs.mkdirSync(round1Dir, { recursive: true });

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspaceFolder) {
            vscode.window.showErrorMessage("Please open a folder/workspace first.");
            return;
        }

        const stagedFilesList: string[] = [];

        // 2. Generate Smart File Tree (Respecting .gitignore)
        try {
            const ignores = parseGitIgnore(workspaceFolder);
            const tree = generateFileTree(workspaceFolder, "", ignores);
            const treePath = path.join(round1Dir, '_PROJECT_STRUCTURE.txt');
            fs.writeFileSync(treePath, tree);
            stagedFilesList.push("_PROJECT_STRUCTURE.txt");
        } catch (err) {
            console.error("Error generating tree", err);
        }

        // 3. Stage Currently Opened Files (Flattened)
        const openDocs = vscode.workspace.textDocuments;
        
        for (const doc of openDocs) {
            // Filter out output panel logs, git diffs, etc.
            if (doc.uri.scheme === 'file' && doc.fileName.startsWith(workspaceFolder)) {
                const relativePath = path.relative(workspaceFolder, doc.fileName);
                
                // Flatten: src/components/App.tsx -> src__components__App.tsx
                const flatName = relativePath.split(path.sep).join('__');
                const destPath = path.join(round1Dir, flatName);
                
                // Save content
                fs.writeFileSync(destPath, doc.getText());
                stagedFilesList.push(relativePath);
            }
        }

        // 4. Ask User for Goal
        const userGoal = await vscode.window.showInputBox({ 
            prompt: "What is your goal?",
            placeHolder: "e.g. Find where validation logic is located and fix the email regex"
        });
        if (!userGoal) { return; }

        // 5. Generate Prompt
        const systemPrompt = generateSystemPrompt(userGoal, stagedFilesList);

        // 6. Launch UI
        const panel = vscode.window.createWebviewPanel('aiBridge', 'AI Studio Staging', vscode.ViewColumn.Beside, { enableScripts: true });
        panel.webview.html = getWebviewContent(systemPrompt, round1Dir);
        
        // Listeners 
        panel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'openFolder') {
                const dirToOpen = message.path || round1Dir;
                vscode.env.openExternal(vscode.Uri.file(dirToOpen));
            }
        });
    });

    context.subscriptions.push(disposable);
}

// --- Helper: GitIgnore Parser ---
function parseGitIgnore(root: string): string[] {
    const ignorePath = path.join(root, '.gitignore');
    const defaultIgnores = ['.git', 'node_modules', '.DS_Store', 'dist', 'out', 'build', '.vscode', '__pycache__'];
    
    if (fs.existsSync(ignorePath)) {
        const content = fs.readFileSync(ignorePath, 'utf-8');
        const lines = content.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))
            // Simple conversion: remove trailing slashes
            .map(l => l.replace(/\/$/, '')); 
        return [...defaultIgnores, ...lines];
    }
    return defaultIgnores;
}

// --- Helper: Recursive Tree Generation ---
function generateFileTree(dir: string, prefix = '', ignores: string[]): string {
    let output = '';
    const name = path.basename(dir);
    
    // Basic ignore filtering (simple string matching, not full glob support for simplicity)
    if (ignores.includes(name)) { return ''; }

    try {
        let entries = fs.readdirSync(dir, { withFileTypes: true });
        
        // Sort: Directories first, then files
        entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });

        // Filter entries based on ignores
        entries = entries.filter(e => !ignores.includes(e.name));

        entries.forEach((entry, index) => {
            const isLast = index === entries.length - 1;
            const marker = isLast ? '└── ' : '├── ';
            const newPrefix = prefix + (isLast ? '    ' : '│   ');
            
            output += `${prefix}${marker}${entry.name}\n`;
            
            if (entry.isDirectory()) {
                output += generateFileTree(path.join(dir, entry.name), newPrefix, ignores);
            }
        });
    } catch (e) { return ''; }
    
    return output;
}

function generateSystemPrompt(goal: string, fileList: string[]): string {
    // Filter out structure file from the "Opened Files" list for clarity
    const openedFiles = fileList.filter(f => f !== '_PROJECT_STRUCTURE.txt');

    return `I am attaching a set of files. 
1. "_PROJECT_STRUCTURE.txt": Contains the full file tree of the project.
2. Source code files: These are the tabs I currently have open. (Note: filenames are flattened, e.g. "src__utils.ts" maps to "src/utils.ts").

GOAL: ${goal}

INSTRUCTIONS:
You are an expert coding assistant. Output response in STRICT JSON.

A. IF YOU HAVE ENOUGH CONTEXT:
   Set "status": "COMPLETED".
   Provide the code in "code_changes". You can provide a "FULL_REWRITE" or a "DIFF" (unified diff format).

B. IF YOU NEED MORE CONTEXT:
   Set "status": "NEED_CONTEXT".
   1. Check "_PROJECT_STRUCTURE.txt" to see what files exist.
   2. Request specific files using "request_files".
   3. If you don't know the filename, use "search_queries" to run a text search on the codebase (e.g. "definition of User interface").

JSON SCHEMA:
{
  "status": "NEED_CONTEXT" | "COMPLETED",
  "reasoning": "Brief explanation of your plan",
  "request_files": ["path/to/file1", "src/utils/helper.ts"],
  "search_queries": ["text to find"],
  "code_changes": [
    {
      "file_path": "src/components/App.tsx",
      "type": "FULL_REWRITE", 
      "content": "..."
    }
  ]
}`;
}

function getWebviewContent(prompt: string, folderPath: string) {
    const safePath = folderPath.replace(/\\/g, '\\\\');
    return `
    <html>
    <body style="font-family: sans-serif; padding: 20px;">
        <h2>🚀 Staging Complete</h2>
        
        <div style="background: #252526; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
            <h3 style="margin-top:0;">1. Files Ready</h3>
            <p>Folder contains your open tabs + Project Structure.</p>
            <button onclick="openFolder()" style="padding: 8px 16px; cursor: pointer;">📂 Open Folder (Ctrl+A -> Drag to AI Studio)</button>
        </div>

        <div style="background: #252526; padding: 15px; border-radius: 5px;">
            <h3 style="margin-top:0;">2. System Prompt</h3>
            <textarea id="p" style="width:100%; height:200px; background: #1e1e1e; color: #d4d4d4; border: 1px solid #3c3c3c;">${prompt}</textarea>
            <br/><br/>
            <button onclick="copyText()" style="padding: 8px 16px; cursor: pointer;">📋 Copy Prompt</button>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            function openFolder() { vscode.postMessage({command: 'openFolder', path: '${safePath}'}); }
            function copyText() { document.getElementById('p').select(); document.execCommand('copy'); }
        </script>
    </body>
    </html>`;
}

export function deactivate() {}