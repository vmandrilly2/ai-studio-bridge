import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import ignore from 'ignore';

let currentStagingRoot: string = "";
let currentRoundDir: string = "";
let currentWorkspaceRoot: string = "";
let currentUserGoal: string = "";
let currentRound = 1;
let lastSystemPrompt: string = "";
let currentPanel: vscode.WebviewPanel | undefined;
let server: http.Server | undefined;
const PORT = 54321;

export function activate(context: vscode.ExtensionContext) {
    // AI Bridge activation start
    // 1. START LOCAL SERVER
    try {
        server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
            // Fix for CORS and Private Network Access (PNA) blocks in Chrome/Firefox
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Access-Control-Allow-Private-Network', 'true');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            // ENDPOINT: GET /prompt (Browser asks for the task)
            if (req.method === 'GET' && req.url === '/prompt') {
                if (!currentRoundDir || !fs.existsSync(currentRoundDir)) {
                     const warning = "WARNING: No files staged. Please run 'AI Bridge: Stage Workspace' in VS Code first.";
                     res.writeHead(200, { 'Content-Type': 'application/json' });
                     res.end(JSON.stringify({ prompt: warning }));
                     return;
                }
                const fullPayload = await getPromptWithFiles(currentRoundDir, lastSystemPrompt);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ prompt: fullPayload }));
                return;
            }

            // ENDPOINT: POST /response (Browser sends the AI solution)
            if (req.method === 'POST' && req.url === '/response') {
                let body = '';
                req.on('data', (chunk: Buffer) => body += chunk.toString());
                req.on('end', async () => {
                    try {
                        const data = JSON.parse(body);
                        const result = await vscode.commands.executeCommand('ai-bridge.applyResponse', data.text);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'received', result }));
                    } catch (e) {
                        console.error("[AI Bridge] JSON Parse Error on Server:", e);
                        res.writeHead(400);
                        res.end('Invalid JSON');
                    }
                });
                return;
            }

            res.writeHead(404);
            res.end();
        });

        server.listen(PORT, () => {
            console.log(`AI Bridge Server running on port ${PORT}`);
        });
    } catch (e) {
        console.error("Failed to start AI Bridge server", e);
    }

    // 2. STAGE COMMAND
    let disposable = vscode.commands.registerCommand('ai-bridge.stageWorkspace', async () => {
        currentRound = 1;
        
        // Setup Staging
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        currentStagingRoot = path.join(os.tmpdir(), 'ai-bridge', timestamp);
        const round1Dir = path.join(currentStagingRoot, 'round_1');
        fs.mkdirSync(round1Dir, { recursive: true });

        currentRoundDir = round1Dir;

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

        currentWorkspaceRoot = workspaceFolder;

        // Initialize Ignore Filter
        const ig = ignore();
        ig.add(['.git', '.vscode', 'node_modules', 'dist', 'out', 'build', '__pycache__', '.DS_Store', 'venv', '.env']);
        const gitIgnorePath = path.join(workspaceFolder, '.gitignore');
        if (fs.existsSync(gitIgnorePath)) {
            try {
                ig.add(fs.readFileSync(gitIgnorePath, 'utf-8'));
            } catch (e) { console.log("Could not read .gitignore"); }
        }

        const stagedFilesList: string[] = [];

        // Generate Tree
        try {
            const tree = generateFileTree(workspaceFolder, workspaceFolder, "", ig);
            const treePath = path.join(round1Dir, '_PROJECT_STRUCTURE.txt');
            fs.writeFileSync(treePath, tree);
            stagedFilesList.push("_PROJECT_STRUCTURE.txt");
        } catch (err) {
            console.error("Error generating tree", err);
        }

        // Stage Opened Files
        const openDocs = vscode.workspace.textDocuments;
        for (const doc of openDocs) {
            if (doc.uri.scheme === 'file' && doc.fileName.startsWith(workspaceFolder)) {
                const relativePath = path.relative(workspaceFolder, doc.fileName);
                if (ig.ignores(relativePath)) { continue; }
                if (relativePath.includes('_PROJECT_STRUCTURE')) { continue; }

                const flatName = relativePath.split(path.sep).join('__') + '.txt';
                const destPath = path.join(round1Dir, flatName);
                
                fs.writeFileSync(destPath, doc.getText());
                stagedFilesList.push(relativePath);
            }
        }

        // User Goal
        const userGoal = await vscode.window.showInputBox({ 
            prompt: "What is your goal?",
            placeHolder: "e.g. Fix the login bug in AuthController"
        });
        if (!userGoal) { return; }
        
        currentUserGoal = userGoal;

        // Generate Prompt
        const systemPrompt = generateSystemPrompt(userGoal, stagedFilesList);
        lastSystemPrompt = systemPrompt;

        // UI
        const panel = vscode.window.createWebviewPanel('aiBridge', 'AI Studio Staging', vscode.ViewColumn.Beside, { enableScripts: true });
        currentPanel = panel;
        updateWebview(panel, systemPrompt, round1Dir);
        
        panel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'openFolder') {
                const dirToOpen = message.path || round1Dir;
                vscode.env.openExternal(vscode.Uri.file(dirToOpen));
            }
            else if (message.command === 'processResponse') {
                await handleAIResponse(message.text, workspaceFolder!, userGoal);
            }
        });

        panel.onDidDispose(() => { currentPanel = undefined; }, null, context.subscriptions);
    });

    // 3. APPLY COMMAND (INTERNAL)
    let applyDisposable = vscode.commands.registerCommand('ai-bridge.applyResponse', async (jsonText: string) => {
        if (currentWorkspaceRoot) {
            return await handleAIResponse(jsonText, currentWorkspaceRoot, currentUserGoal);
        } else {
             vscode.window.showErrorMessage("No active workspace context. Run 'Stage Workspace' first.");
             return { action: 'ERROR' };
        }
    });

    context.subscriptions.push(disposable, applyDisposable);
}

// Helper: Fix double-encoded JSON issues in content fields
function normalizeJsonLikeResponse(t: string): string {
    let s = t;
    const r = /"content"\s*:\s*"(<<<<<<< SEARCH[\s\S]*?>>>>>>> REPLACE)"/g;
    s = s.replace(r, (_m, g1) => {
        const esc = g1.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return '"content":"' + esc + '"';
    });
    return s;
}

async function handleAIResponse(jsonText: string, workspaceRoot: string, goal: string): Promise<{ action: string }> {
    console.log("[AI Bridge] Handling Response. Length:", jsonText.length);
    let data: any;
    try {
        let t = normalizeJsonLikeResponse(jsonText.trim());
        
        // Try to extract JSON from code fences if present
        const candidates: string[] = [];
        const fenceStart = t.indexOf('```');
        if (fenceStart !== -1) {
            const fenceEnd = t.indexOf('```', fenceStart + 3);
            if (fenceEnd !== -1) {
                let inner = t.slice(fenceStart + 3, fenceEnd).trim();
                inner = inner.replace(/^json\s*/, '').trim();
                candidates.push(inner);
            } else {
                // maybe fence at end
                candidates.push(t.replace(/^```(json)?\s*/, '').replace(/\s*```$/, '').trim());
            }
        }
        candidates.push(t);

        // Try sub-block heuristics
        const bStart = t.indexOf('[');
        const bEnd = t.lastIndexOf(']');
        if (bStart !== -1 && bEnd !== -1 && bEnd > bStart) {
            candidates.push(t.substring(bStart, bEnd + 1));
        }
        const oStart = t.indexOf('{');
        const oEnd = t.lastIndexOf('}');
        if (oStart !== -1 && oEnd !== -1 && oEnd > oStart) {
            candidates.push(t.substring(oStart, oEnd + 1));
        }

        let parsed: any;
        let ok = false;
        for (const c of candidates) {
            if (!c) { continue; }
            try {
                parsed = JSON.parse(c);
                ok = true;
                break;
            } catch {}
        }

        if (!ok) { 
            console.error("[AI Bridge] Parsing failed. Raw content (first 500 chars):", t.substring(0, 500));
            throw new Error('parse'); 
        }

        if (Array.isArray(parsed)) {
            data = { status: 'COMPLETED', code_changes: parsed };
        } else if (parsed && !parsed.status && Array.isArray(parsed.code_changes)) {
            data = { ...parsed, status: 'COMPLETED' };
        } else {
            data = parsed;
        }
    } catch (e) {
        vscode.window.showErrorMessage("Invalid JSON. Check VS Code Debug Console for raw output.");
        return { action: 'ERROR' };
    }

    if (data.status === 'COMPLETED') {
        if (data.code_changes && Array.isArray(data.code_changes)) {
            const edit = new vscode.WorkspaceEdit();
            let appliedCount = 0;

            const changesByFile = new Map<string, any[]>();
            for (const change of data.code_changes) {
                if (change.type === 'FULL_REWRITE' || change.type === 'DIFF' || change.type === 'PATCH') {
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
                        } else if (change.type === 'DIFF') {
                            workingContent = applySearchReplace(workingContent, change.content);
                        } else if (change.type === 'PATCH') {
                            const asDiff = patchEnvelopeToDiffForFile(change.content, change.file_path);
                            workingContent = applySearchReplace(workingContent, asDiff);
                        }
                    }
                    
                    // Apply the edit to the open document or create new
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
                    try {
                        // Snapshot this round
                        const modifiedFiles = Array.from(changesByFile.keys());
                        currentRound++;
                        const roundDir = path.join(currentStagingRoot, `round_${currentRound}`);
                        fs.mkdirSync(roundDir, { recursive: true });
                        for (const fp of modifiedFiles) {
                            const srcPath = path.join(workspaceRoot, fp);
                            if (fs.existsSync(srcPath)) {
                                const flatName = fp.split('/').join('__') + '.txt';
                                fs.copyFileSync(srcPath, path.join(roundDir, flatName));
                            }
                        }
                        currentRoundDir = roundDir;
                        lastSystemPrompt = "Here are the modified pages after changes, please confirm to the user if the changes have been correctly applied.";
                        if (currentPanel) {
                            updateWebview(currentPanel, lastSystemPrompt, roundDir);
                        }
                    } catch {}
                } else {
                    vscode.window.showErrorMessage("Failed to apply workspace edit.");
                }
            } else {
                vscode.window.showWarningMessage("Status is COMPLETED but no code_changes found.");
            }
        } else {
            vscode.window.showWarningMessage("Status is COMPLETED but no code_changes found.");
        }
        return { action: 'COMPLETED' };
    } else if (data.status === 'NEED_CONTEXT') {
        currentRound++;
        const roundDir = path.join(currentStagingRoot, `round_${currentRound}`);
        fs.mkdirSync(roundDir, { recursive: true });

        currentRoundDir = roundDir;
        const stagedFiles: string[] = [];

        // Try to keep project structure available
        try {
             const structFile = path.join(currentStagingRoot, 'round_1', '_PROJECT_STRUCTURE.txt');
             if (fs.existsSync(structFile)) {
                 fs.copyFileSync(structFile, path.join(roundDir, '_PROJECT_STRUCTURE.txt'));
                 stagedFiles.push("_PROJECT_STRUCTURE.txt");
             }
        } catch {}

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
        
        // RE-GENERATE PROMPT with new files and instructions so AI knows what to do
        lastSystemPrompt = generateSystemPrompt(goal, stagedFiles);

        if (currentPanel) {
            updateWebview(currentPanel, lastSystemPrompt, roundDir);
        }
        
        vscode.window.showInformationMessage(`Round ${currentRound} prepared with ${stagedFiles.length} files.`);
        return { action: 'NEED_CONTEXT' };
    } else {
        vscode.window.showWarningMessage("Response missing valid status. Paste either an object with 'status' or an array of code changes.");
        return { action: 'UNKNOWN' };
    }
}

async function getPromptWithFiles(stagingDir: string, basePrompt: string): Promise<string> {
    let hugePrompt = basePrompt + "\n\n=== ATTACHED FILES ===\n";
    if (!fs.existsSync(stagingDir)) return hugePrompt;

    const files = fs.readdirSync(stagingDir);
    for (const file of files) {
        const fullPath = path.join(stagingDir, file);
        if (fs.statSync(fullPath).isFile()) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            hugePrompt += `\n--- START OF FILE ${file} ---\n${content}\n--- END OF FILE ---\n`;
        }
    }
    return hugePrompt;
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
   - Use "type": "PATCH" for partial edits. Content MUST be a patch envelope we can apply:

     *** Begin Patch
     *** Update File: src/path/to/file.ts
     @@
     -old line
     +new line
     *** End Patch

   Rules:
   - Use relative file paths.
   - Include only the hunks relevant to the target file.
   - Prefix context with a single space, removals with '-', additions with '+'.

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
      "type": "FULL_REWRITE" | "PATCH", 
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
        
        // Normalize line endings to LF for reliable matching
        const normalize = (s: string) => s.replace(/\r\n/g, '\n');
        const normalizedResult = normalize(result);
        const normalizedSearch = normalize(search);
        
        const index = normalizedResult.indexOf(normalizedSearch);
        
        if (index !== -1) {
            // Replace content in the normalized string - Note: This converts mixed line endings to LF
            // This is generally acceptable for modern VS Code dev.
            result = normalizedResult.substring(0, index) + replace + normalizedResult.substring(index + normalizedSearch.length);
        } else {
             vscode.window.showWarningMessage("Could not find SEARCH block in file. Check line endings and indentation.");
        }
    }
    return result;
}

function patchEnvelopeToDiffForFile(patch: string, targetFile: string): string {
    const lines = patch.split(/\r?\n/);
    let inUpdate = false;
    let collects: string[] = [];
    let outBlocks: string[] = [];
    const pushBlock = () => {
        if (collects.length > 0) {
            const hunk = collects.join('\n');
            const hLines = hunk.split('\n');
            const search: string[] = [];
            const replace: string[] = [];
            for (const l of hLines) {
                if (l.startsWith(' ')) { search.push(l.slice(1)); replace.push(l.slice(1)); }
                else if (l.startsWith('-')) { search.push(l.slice(1)); }
                else if (l.startsWith('+')) { replace.push(l.slice(1)); }
            }
            outBlocks.push('<<<<<<< SEARCH\n' + search.join('\n') + '\n=======\n' + replace.join('\n') + '\n>>>>>>> REPLACE');
            collects = [];
        }
    };
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('*** Update File:')) {
            const f = l.replace('*** Update File:', '').trim();
            inUpdate = (f === targetFile);
            continue;
        }
        if (!inUpdate) { continue; }
        if (l.startsWith('@@')) { pushBlock(); collects = []; continue; }
        if (l.startsWith('*** End Patch')) { break; }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
            collects.push(l);
        }
    }
    pushBlock();
    return outBlocks.join('\n');
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

export function deactivate() {
    if (server) { server.close(); }
}