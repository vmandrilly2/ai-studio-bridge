import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ignore from 'ignore';

let currentStagingRoot: string = "";
let currentRound = 1;
let lastSystemPrompt: string = "";

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('ai-bridge.stageWorkspace', async () => {
        currentRound = 1;
        
        // 1. Setup Staging
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        currentStagingRoot = path.join(os.tmpdir(), 'ai-bridge', timestamp);
        const round1Dir = path.join(currentStagingRoot, 'round_1');
        fs.mkdirSync(round1Dir, { recursive: true });

        let workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
            const picked = await vscode.window.showOpenDialog({ 
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                title: "Select a workspace folder to stage"
            });
            if (!picked || picked.length === 0) { vscode.window.showErrorMessage("No folder selected."); return; }
            workspaceFolder = picked[0].fsPath;
        }

        // 2. Initialize Ignore Filter
        const ig = ignore();
        ig.add(['.git', '.vscode', 'node_modules', 'dist', 'out', 'build', '__pycache__', '.DS_Store', 'venv', '.env']);
        const gitIgnorePath = path.join(workspaceFolder, '.gitignore');
        if (fs.existsSync(gitIgnorePath)) {
            try {
                ig.add(fs.readFileSync(gitIgnorePath, 'utf-8'));
            } catch (e) { console.log("Could not read .gitignore"); }
        }

        const stagedFilesList: string[] = [];

        // 3. Generate Tree
        try {
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
                if (ig.ignores(relativePath)) { continue; }
                if (relativePath.includes('_PROJECT_STRUCTURE')) { continue; }

                // Flatten and append .txt
                const flatName = relativePath.split(path.sep).join('__') + '.txt';
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
        lastSystemPrompt = systemPrompt;

        // 7. UI
        const panel = vscode.window.createWebviewPanel('aiBridge', 'AI Studio Staging', vscode.ViewColumn.Beside, { enableScripts: true });
        updateWebview(panel, systemPrompt, round1Dir);
        
        panel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'openFolder') {
                const dirToOpen = message.path || round1Dir;
                vscode.env.openExternal(vscode.Uri.file(dirToOpen));
            }
            else if (message.command === 'processResponse') {
                await handleAIResponse(message.text, workspaceFolder!, userGoal, panel);
            }
        });
    });

    context.subscriptions.push(disposable);
}

async function handleAIResponse(jsonText: string, workspaceRoot: string, goal: string, panel: vscode.WebviewPanel) {
    let data: any;
    try {
        let cleanJson = jsonText.trim();
        if (cleanJson.startsWith('```')) {
            cleanJson = cleanJson.replace(/^```(json)?\s*/, '').replace(/\s*```$/, '');
        }
        const parsed = JSON.parse(cleanJson);
        if (Array.isArray(parsed)) {
            data = { status: 'COMPLETED', code_changes: parsed };
        } else if (parsed && !parsed.status && Array.isArray(parsed.code_changes)) {
            data = { ...parsed, status: 'COMPLETED' };
        } else {
            data = parsed;
        }
    } catch (e) {
        vscode.window.showErrorMessage("Invalid JSON. Please ensure you pasted valid JSON (optionally inside ```json code fences).");
        return;
    }

    if (data.status === 'COMPLETED') {
        if (data.code_changes && Array.isArray(data.code_changes)) {
            const edit = new vscode.WorkspaceEdit();
            let appliedCount = 0;

            const changesByFile = new Map<string, any[]>();
            for (const change of data.code_changes) {
                if (change.type === 'FULL_REWRITE' || change.type === 'DIFF') {
                    const arr = changesByFile.get(change.file_path) || [];
                    arr.push(change);
                    changesByFile.set(change.file_path, arr);
                }
            }

            for (const [filePath, changes] of changesByFile.entries()) {
                const targetPath = path.join(workspaceRoot, filePath);
                const uri = vscode.Uri.file(targetPath);
                try {
                    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                    let workingContent = '';
                    let doc: vscode.TextDocument | null = null;
                    if (fs.existsSync(targetPath)) {
                        doc = await vscode.workspace.openTextDocument(uri);
                        workingContent = doc.getText();
                    }
                    for (const change of changes) {
                        if (change.type === 'FULL_REWRITE') {
                            workingContent = change.content;
                        } else {
                            workingContent = applySearchReplace(workingContent, change.content);
                        }
                    }
                    if (doc) {
                        const fullRange = new vscode.Range(
                            doc.positionAt(0),
                            doc.positionAt(doc.getText().length)
                        );
                        edit.replace(uri, fullRange, workingContent);
                    } else {
                        edit.createFile(uri, { overwrite: true });
                        edit.insert(uri, new vscode.Position(0, 0), workingContent);
                    }
                    appliedCount++;
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to prepare edit for ${filePath}`);
                }
            }

            if (appliedCount > 0) {
                const success = await vscode.workspace.applyEdit(edit);
                if (success) {
                    vscode.window.showInformationMessage(`Applied changes to ${appliedCount} files. Please review and save.`);
                } else {
                    vscode.window.showErrorMessage("Failed to apply workspace edit.");
                }
            } else {
                vscode.window.showWarningMessage("Status is COMPLETED but no code_changes found.");
            }
        } else {
            vscode.window.showWarningMessage("Status is COMPLETED but no code_changes found.");
        }
    } else if (data.status === 'NEED_CONTEXT') {
        // Handle Context Request -> New Round
        currentRound++;
        const roundDir = path.join(currentStagingRoot, `round_${currentRound}`);
        fs.mkdirSync(roundDir, { recursive: true });

        const stagedFiles: string[] = [];

        // 1. Copy requested files
        if (data.request_files && Array.isArray(data.request_files)) {
            for (const reqFile of data.request_files) {
                const srcPath = path.join(workspaceRoot, reqFile);
                if (fs.existsSync(srcPath)) {
                     const flatName = reqFile.split('/').join('__') + '.txt';
                     fs.copyFileSync(srcPath, path.join(roundDir, flatName));
                     stagedFiles.push(reqFile);
                }
            }
        }
        
        // 2. Update Webview and Open Folder automatically
        updateWebview(panel, lastSystemPrompt, roundDir);
        vscode.env.openExternal(vscode.Uri.file(roundDir));
        
        vscode.window.showInformationMessage(`Round ${currentRound} prepared with ${stagedFiles.length} files.`);
    } else {
        vscode.window.showWarningMessage("Response missing valid status. Paste either an object with 'status' or an array of code changes.");
    }
}

function generateFileTree(currentDir: string, rootDir: string, prefix: string, ig: any): string {
    let output = '';
    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (e) { return ''; }

    entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) { return -1; }
        if (!a.isDirectory() && b.isDirectory()) { return 1; }
        return a.name.localeCompare(b.name);
    });

    const filteredEntries = entries.filter(entry => {
        const absolutePath = path.join(currentDir, entry.name);
        let relativePath = path.relative(rootDir, absolutePath);
        relativePath = relativePath.split(path.sep).join('/');
        if (entry.isDirectory()) { relativePath += '/'; }
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
1. "_PROJECT_STRUCTURE.txt": Contains the full file tree.
2. Source code files: Flattened filenames ending in .txt (e.g. "src__utils.ts.txt" maps to "src/utils.ts").

GOAL: ${goal}

INSTRUCTIONS:
You are an expert coding assistant. Output response in STRICT JSON format, wrapped in a markdown code block (e.g. \`\`\`json ... \`\`\`).

A. IF YOU HAVE ENOUGH CONTEXT:
   Set "status": "COMPLETED".
   Provide the code in "code_changes".
   - Use "type": "FULL_REWRITE" for new files or when rewriting the entire content.
   - Use "type": "DIFF" for partial edits. Format content as SEARCH/REPLACE blocks:
     <<<<<<< SEARCH
     original code line 1
     original code line 2
     =======
     new code line 1
     new code line 2
     >>>>>>> REPLACE

   *Note*: SEARCH must match exact indentation and whitespace. Line endings are normalized (CRLF/LF), but indentation must match exactly.

B. IF YOU NEED MORE CONTEXT:
   Set "status": "NEED_CONTEXT".
   1. Request specific files using "request_files".

JSON SCHEMA:
{
  "status": "NEED_CONTEXT" | "COMPLETED",
  "reasoning": "Brief explanation",
  "request_files": ["src/utils/helper.ts"],
  "code_changes": [
    {
      "file_path": "src/components/App.tsx",
      "type": "FULL_REWRITE" | "DIFF", 
      "content": "..."
    }
  ]
}`;
}

function applySearchReplace(original: string, diff: string): string {
    let result = original;
    const blockRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
    let match;
    while ((match = blockRegex.exec(diff)) !== null) {
        const [_, search, replace] = match;
        // Escape regex special characters in search block
        const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Normalize line endings to match \r\n, \n, etc.
        const searchPattern = escapedSearch.split(/\r?\n/).join('\\r?\\n');
        const searchRegex = new RegExp(searchPattern);
        
        if (searchRegex.test(result)) {
            result = result.replace(searchRegex, replace);
        } else {
             vscode.window.showWarningMessage("Could not find SEARCH block in file. Check line endings and indentation.");
        }
    }
    return result;
}

function updateWebview(panel: vscode.WebviewPanel, prompt: string, folderPath: string) {
    const safePath = folderPath.replace(/\\/g, '\\\\');
    panel.webview.html = `
    <html>
    <body style="font-family: sans-serif; padding: 20px; background-color: #1e1e1e; color: #ccccc7;">
        <h2>🚀 AI Studio Bridge</h2>
        
        <div style="background: #252526; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
            <h3 style="margin-top:0;">1. Stage Files</h3>
            <p>Files staged at: <code>${folderPath}</code></p>
            <button onclick="openFolder()" style="padding: 8px 16px; cursor: pointer; background: #007acc; color: white; border: none; border-radius: 3px;">📂 Open Folder</button>
            <p style="font-size: 0.9em; color: #aaa;">Tip: Select All -> Drag to AI Studio</p>
        </div>

        <div style="background: #252526; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
            <h3 style="margin-top:0;">2. System Prompt</h3>
            <textarea id="p" style="width:100%; height:150px; background: #3c3c3c; color: #d4d4d4; border: 1px solid #555;">${prompt}</textarea>
            <br/><br/>
            <button onclick="copyText()" style="padding: 8px 16px; cursor: pointer; background: #444; color: white; border: none; border-radius: 3px;">📋 Copy Prompt</button>
        </div>

        <div style="background: #252526; padding: 15px; border-radius: 5px;">
            <h3 style="margin-top:0;">3. Apply AI Response</h3>
            <p>Paste the JSON response from AI Studio below:</p>
            <textarea id="aiInput" placeholder="{ \"status\": ... }" style="width:100%; height:150px; background: #3c3c3c; color: #d4d4d4; border: 1px solid #555;"></textarea>
            <br/><br/>
            <button onclick="processResponse()" style="padding: 8px 16px; cursor: pointer; background: #0e639c; color: white; border: none; border-radius: 3px;">▶️ Apply / Next Step</button>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            function openFolder() { vscode.postMessage({command: 'openFolder', path: '${safePath}'}); }
            function copyText() { document.getElementById('p').select(); document.execCommand('copy'); }
            function processResponse() {
                const text = document.getElementById('aiInput').value;
                if (!text.trim()) return;
                vscode.postMessage({command: 'processResponse', text: text});
            }
        </script>
    </body>
    </html>`;
}

export function deactivate() {}
