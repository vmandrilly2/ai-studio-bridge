import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Keep track of the active staging directory per session
let currentStagingRoot: string = "";

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('ai-bridge.stageFiles', async (uri: vscode.Uri, allUris: vscode.Uri[]) => {
        
        // 1. Setup Staging Directory
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        currentStagingRoot = path.join(os.tmpdir(), 'ai-bridge', timestamp);
        const round1Dir = path.join(currentStagingRoot, 'round_1');
        fs.mkdirSync(round1Dir, { recursive: true });

        // 2. Determine Workspace Root
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;

        // 3. Process Files
        const filesToStage = allUris || [uri]; 
        const stagedFiles: string[] = [];

        if (!filesToStage[0]) {
            vscode.window.showErrorMessage("No files selected.");
            return;
        }

        try {
            for (const fileUri of filesToStage) {
                const stats = fs.statSync(fileUri.fsPath);
                if (stats.isFile()) {
                    let relativePath = path.basename(fileUri.fsPath);
                    if (workspaceFolder && fileUri.fsPath.startsWith(workspaceFolder)) {
                        relativePath = path.relative(workspaceFolder, fileUri.fsPath);
                    }
                    
                    const destPath = path.join(round1Dir, relativePath);
                    fs.mkdirSync(path.dirname(destPath), { recursive: true });
                    fs.copyFileSync(fileUri.fsPath, destPath);
                    stagedFiles.push(relativePath);
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error staging files: ${error}`);
            return;
        }

        // 4. Ask User for Goal
        const userGoal = await vscode.window.showInputBox({ 
            prompt: "What is your goal with these files?",
            placeHolder: "e.g., Check for bugs, Refactor to React Hooks, etc."
        });
        if (!userGoal) { return; }

        // 5. Generate Prompt
        const systemPrompt = generateSystemPrompt(userGoal, stagedFiles);

        // 6. Create Webview
        const panel = vscode.window.createWebviewPanel(
            'aiBridge', 
            'AI Studio Staging', 
            vscode.ViewColumn.Beside, 
            { enableScripts: true }
        );
        
        // Pass just the path string, let the HTML handle escaping for the initial load
        panel.webview.html = getWebviewContent(systemPrompt, round1Dir, stagedFiles);
        
        // 7. Handle Messages (Open Folder AND Process JSON)
        panel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'openFolder') {
                // If the webview sent a specific path, use it. Otherwise default to round1
                const dirToOpen = message.path || round1Dir;
                vscode.env.openExternal(vscode.Uri.file(dirToOpen));
            }
            
            if (message.command === 'processResponse') {
                await handleAiResponse(message.json, panel, workspaceFolder);
            }
        });
    });

    context.subscriptions.push(disposable);
}

async function handleAiResponse(jsonString: string, panel: vscode.WebviewPanel, workspaceRoot: string | undefined) {
    try {
        // Clean up common AI JSON markdown artifacts if present (```json ... ```)
        const cleanedJson = jsonString.replace(/```json/g, '').replace(/```/g, '').trim();
        const response = JSON.parse(cleanedJson);

        // CASE A: AI Needs More Context
        if (response.status === "NEED_CONTEXT" && response.request_files && workspaceRoot) {
            const requestedFiles: string[] = response.request_files;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const roundDirName = `context_${timestamp}`;
            const nextRoundDir = path.join(currentStagingRoot, roundDirName);
            fs.mkdirSync(nextRoundDir, { recursive: true });

            let foundCount = 0;
            const missingFiles: string[] = [];

            for (const reqFile of requestedFiles) {
                const absPath = path.join(workspaceRoot, reqFile);
                
                if (fs.existsSync(absPath)) {
                    const destPath = path.join(nextRoundDir, reqFile);
                    fs.mkdirSync(path.dirname(destPath), { recursive: true });
                    fs.copyFileSync(absPath, destPath);
                    foundCount++;
                } else {
                    missingFiles.push(reqFile);
                }
            }

            // Send raw path to Webview. Webview JS will handle it as a data object.
            panel.webview.postMessage({
                command: 'updateStatus',
                text: `Staged <b>${foundCount}</b> new files for context.`,
                newPath: nextRoundDir, // Sending raw string path
                missing: missingFiles
            });
            
            vscode.window.showInformationMessage(`Prepared ${foundCount} files for Round 2.`);
        } 
        // CASE B: AI Provided Code Changes
        else if (response.code_changes) {
             vscode.window.showInformationMessage("Code changes detected! (Logic coming in Step 4)");
        }

    } catch (e) {
        vscode.window.showErrorMessage("Invalid JSON format. Make sure to paste only the JSON object.");
    }
}

function generateSystemPrompt(goal: string, fileList: string[]): string {
    return `I am providing the following files as attachments:
${fileList.map(f => `- ${f}`).join('\n')}

GOAL: ${goal}

INSTRUCTIONS:
You are an expert coding assistant. You must output your response in STRICT JSON format.
Do not output markdown text outside the JSON.

1. If you need more context to do the job correctly (e.g., you see an import but don't have the file), request it.
2. If you have enough context, propose the code changes.

Use the following JSON schema:

{
  "status": "NEED_CONTEXT" | "READY",
  "reasoning": "Short explanation of your analysis",
  "request_files": ["src/utils/missing_helper.ts", "src/types.ts"], 
  "code_changes": [
    {
      "file_path": "src/components/TargetFile.tsx",
      "type": "FULL_REWRITE" | "DIFF",
      "content": "The new code content here"
    }
  ]
}`;
}

function getWebviewContent(prompt: string, round1Path: string, files: string[]) {
    // Only escape for the initial HTML injection
    const safeRound1Path = round1Path.replace(/\\/g, '\\\\');
    
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            body { font-family: 'Segoe UI', sans-serif; padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
            h2 { color: var(--vscode-textLink-foreground); }
            textarea { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-widget-border); font-family: monospace; padding: 5px; }
            .prompt-box { height: 150px; }
            .json-box { height: 150px; }
            button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 8px 16px; border: none; cursor: pointer; font-size: 13px; margin-top: 5px; border-radius: 2px; }
            button:hover { background: var(--vscode-button-hoverBackground); }
            .step { margin-bottom: 20px; padding: 15px; border: 1px solid var(--vscode-widget-border); border-radius: 5px; }
            code { background: var(--vscode-textBlockQuote-background); padding: 2px 5px; border-radius: 3px; }
            #missingFiles { color: var(--vscode-errorForeground); margin-top: 10px; }
        </style>
    </head>
    <body>
        <h2>🚀 AI Studio Bridge</h2>
        
        <div class="step">
            <h3>1. Initial Prompt</h3>
            <p>Copy this to AI Studio and drag content of <code>round_1</code> folder.</p>
            <textarea id="promptBox" class="prompt-box">${prompt}</textarea>
            <br/>
            <button onclick="copyText()">📋 Copy Prompt</button>
            <button onclick="openInitialFolder()">📂 Open 'round_1' Folder</button>
        </div>

        <div class="step">
            <h3>2. Handle Response</h3>
            <p>Paste the JSON response from Gemini here:</p>
            <textarea id="responseBox" class="json-box" placeholder='{ "status": "NEED_CONTEXT", ... }'></textarea>
            <br/>
            <button onclick="processResponse()">⚙️ Process Response</button>
        </div>

        <div id="statusArea" class="step" style="display:none; border-left: 4px solid var(--vscode-notificationsInfoIcon-foreground);">
            <h3>3. Next Steps</h3>
            <p id="statusText"></p>
            <div id="missingFiles"></div>
            <br/>
            <button id="nextRoundBtn">📂 Open New Context Folder</button>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            
            // Variable to store the path dynamically received from extension
            let pendingNewPath = "";

            function openInitialFolder() {
                // Use the specific path injected at creation time
                vscode.postMessage({ command: 'openFolder', path: '${safeRound1Path}' });
            }

            function copyText() {
                const copyText = document.getElementById("promptBox");
                copyText.select();
                document.execCommand("copy");
            }

            function processResponse() {
                const text = document.getElementById("responseBox").value;
                vscode.postMessage({ command: 'processResponse', json: text });
            }

            // Listener for messages from the extension
            window.addEventListener('message', event => {
                const message = event.data;
                
                if (message.command === 'updateStatus') {
                    // 1. Update UI text
                    document.getElementById('statusArea').style.display = 'block';
                    document.getElementById('statusText').innerHTML = message.text;
                    
                    // 2. Store the path in our variable (No backslash escaping issues here)
                    pendingNewPath = message.newPath;

                    // 3. Update missing files list
                    if (message.missing && message.missing.length > 0) {
                        document.getElementById('missingFiles').innerText = "Could not find: " + message.missing.join(', ');
                    } else {
                        document.getElementById('missingFiles').innerText = "";
                    }
                }
            });

            // Bind click handler to the variable
            document.getElementById('nextRoundBtn').addEventListener('click', () => {
                if(pendingNewPath) {
                    vscode.postMessage({ command: 'openFolder', path: pendingNewPath });
                }
            });
        </script>
    </body>
    </html>`;
}

export function deactivate() {}