import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ignore from 'ignore'; 

let currentStagingRoot: string = "";

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('ai-bridge.stageWorkspace', async () => {
        
        // 1. Setup Staging
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

        // 2. Initialize Ignore Filter (Root Level)
        const ig = ignore();
        // Always ignore these common clutter folders
        ig.add(['.git', '.vscode', 'node_modules', 'dist', 'out', 'build', '__pycache__', '.DS_Store', 'venv', '.env']);
        
        // Load root .gitignore
        const gitIgnorePath = path.join(workspaceFolder, '.gitignore');
        if (fs.existsSync(gitIgnorePath)) {
            try {
                const gitIgnoreContent = fs.readFileSync(gitIgnorePath, 'utf-8');
                ig.add(gitIgnoreContent);
            } catch (e) { console.log("Could not read .gitignore"); }
        }

        // 3. Generate Tree
        try {
            // We pass the Workspace Root as the 'base' for calculating relative paths
            const tree = generateFileTree(workspaceFolder, workspaceFolder, "", ig);
            const treePath = path.join(round1Dir, '_PROJECT_STRUCTURE.txt');
            fs.writeFileSync(treePath, tree);
            stagedFilesList.push("_PROJECT_STRUCTURE.txt");
        } catch (err) {
            console.error("Error generating tree", err);
        }

        // 4. Stage Opened Files
        const openDocs = vscode.workspace.textDocuments;
        for (const doc of openDocs) {
            if (doc.uri.scheme === 'file' && doc.fileName.startsWith(workspaceFolder)) {
                const relativePath = path.relative(workspaceFolder, doc.fileName);
                
                // Skip if it's ignored by git (optional, but good practice)
                if (ig.ignores(relativePath)) continue;
                if (relativePath.includes('_PROJECT_STRUCTURE')) continue;

                // Flatten: src/utils/helper.ts -> src__utils__helper.ts
                const flatName = relativePath.split(path.sep).join('__');
                const destPath = path.join(round1Dir, flatName);
                
                fs.writeFileSync(destPath, doc.getText());
                stagedFilesList.push(relativePath);
            }
        }

        // 5. User Goal
        const userGoal = await vscode.window.showInputBox({ 
            prompt: "What is your goal?",
            placeHolder: "e.g. Fix the login bug in AuthController"
        });
        if (!userGoal) { return; }

        // 6. Generate Prompt
        const systemPrompt = generateSystemPrompt(userGoal, stagedFilesList);

        // 7. UI
        const panel = vscode.window.createWebviewPanel('aiBridge', 'AI Studio Staging', vscode.ViewColumn.Beside, { enableScripts: true });
        panel.webview.html = getWebviewContent(systemPrompt, round1Dir);
        
        panel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'openFolder') {
                const dirToOpen = message.path || round1Dir;
                vscode.env.openExternal(vscode.Uri.file(dirToOpen));
            }
        });
    });

    context.subscriptions.push(disposable);
}

/**
 * Recursive Tree Generator
 * @param currentDir The absolute path of the directory we are currently crawling
 * @param rootDir The absolute path of the workspace root (used to calculate relative paths for .gitignore)
 * @param prefix The visual prefix for the tree (│   ├── )
 * @param ig The ignore instance
 */
function generateFileTree(currentDir: string, rootDir: string, prefix: string, ig: any): string {
    let output = '';
    let entries: fs.Dirent[] = [];
    
    try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (e) { return ''; }

    // Sort: Directories first, then files
    entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
    });

    // Filter entries using the Ignore instance
    const filteredEntries = entries.filter(entry => {
        const absolutePath = path.join(currentDir, entry.name);
        // Get path relative to WORKSPACE ROOT (e.g., "Backend/venv")
        let relativePath = path.relative(rootDir, absolutePath);
        
        // Convert Windows backslashes to forward slashes for the 'ignore' library
        relativePath = relativePath.split(path.sep).join('/');

        // If it's a directory, the ignore lib sometimes likes a trailing slash to match rules like "folder/"
        if (entry.isDirectory()) {
            relativePath += '/';
        }

        return !ig.ignores(relativePath);
    });

    filteredEntries.forEach((entry, index) => {
        const isLast = index === filteredEntries.length - 1;
        const marker = isLast ? '└── ' : '├── ';
        
        output += `${prefix}${marker}${entry.name}\n`;
        
        if (entry.isDirectory()) {
            const newPrefix = prefix + (isLast ? '    ' : '│   ');
            output += generateFileTree(path.join(currentDir, entry.name), rootDir, newPrefix, ig);
        }
    });
    
    return output;
}

function generateSystemPrompt(goal: string, fileList: string[]): string {
    return `I am attaching a set of files. 
1. "_PROJECT_STRUCTURE.txt": Contains the full file tree of the codebase (respecting .gitignore).
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