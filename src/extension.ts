import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('ai-bridge.stageFiles', async (uri: vscode.Uri, allUris: vscode.Uri[]) => {
        
        // 1. Setup Staging Directory
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const stagingDir = path.join(os.tmpdir(), 'ai-bridge', timestamp);
        fs.mkdirSync(stagingDir, { recursive: true });

        // 2. Determine Workspace Root (for relative paths)
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;

        // 3. Process Files
        // Handle edge case: if triggered via command palette, allUris might be undefined
        const filesToStage = allUris || [uri]; 
        const stagedFiles: string[] = [];

        if (!filesToStage[0]) {
            vscode.window.showErrorMessage("No files selected.");
            return;
        }

        try {
            for (const fileUri of filesToStage) {
                const stats = fs.statSync(fileUri.fsPath);
                
                // Only handle files for now (skipping folders to keep logic simple)
                if (stats.isFile()) {
                    let relativePath = path.basename(fileUri.fsPath);
                    
                    // If inside a workspace, preserve the folder structure (e.g. src/components/Button.tsx)
                    if (workspaceFolder && fileUri.fsPath.startsWith(workspaceFolder)) {
                        relativePath = path.relative(workspaceFolder, fileUri.fsPath);
                    }
                    
                    // Create subfolders in staging dir if necessary
                    const destPath = path.join(stagingDir, relativePath);
                    fs.mkdirSync(path.dirname(destPath), { recursive: true });
                    
                    // Copy the file
                    fs.copyFileSync(fileUri.fsPath, destPath);
                    stagedFiles.push(relativePath);
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error staging files: ${error}`);
            return;
        }

        if (stagedFiles.length === 0) {
            vscode.window.showWarningMessage("No valid files were staged. Did you select a directory instead of files?");
            return;
        }

        // 4. Ask User for the Goal
        const userGoal = await vscode.window.showInputBox({ 
            prompt: "What is your goal with these files?",
            placeHolder: "e.g., Check for bugs, Refactor to React Hooks, etc."
        });

        if (!userGoal) { return; } // User cancelled

        // 5. Generate the System Prompt
        const systemPrompt = generateSystemPrompt(userGoal, stagedFiles);

        // 6. Create Webview Panel
        const panel = vscode.window.createWebviewPanel(
            'aiBridge', 
            'AI Studio Staging', 
            vscode.ViewColumn.Beside, 
            { enableScripts: true }
        );
        
        panel.webview.html = getWebviewContent(systemPrompt, stagingDir, stagedFiles);
        
        // Handle "Open Folder" click from the UI
        panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'openFolder') {
                // Open the OS file explorer to that folder
                vscode.env.openExternal(vscode.Uri.file(stagingDir));
            }
        });
    });

    context.subscriptions.push(disposable);
}

function generateSystemPrompt(goal: string, fileList: string[]): string {
    // This relies on the structure you defined in the plan
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
  "search_queries": ["search query if you need to find a file by concept"],
  "code_changes": [
    {
      "file_path": "src/components/TargetFile.tsx",
      "type": "FULL_REWRITE" | "DIFF",
      "content": "The new code content here"
    }
  ]
}`;
}

function getWebviewContent(prompt: string, folderPath: string, files: string[]) {
    // Escaping backslashes for Windows paths in JS string
    const safePath = folderPath.replace(/\\/g, '\\\\');
    
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            body { font-family: sans-serif; padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
            h2 { color: var(--vscode-textLink-foreground); }
            textarea { width: 100%; height: 300px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-widget-border); }
            button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 10px 20px; border: none; cursor: pointer; font-size: 14px; }
            button:hover { background: var(--vscode-button-hoverBackground); }
            .step { margin-bottom: 20px; padding: 15px; border: 1px solid var(--vscode-widget-border); border-radius: 5px; }
            code { background: var(--vscode-textBlockQuote-background); padding: 2px 5px; border-radius: 3px; }
        </style>
    </head>
    <body>
        <h2>🚀 Staging Complete</h2>
        
        <div class="step">
            <h3>Step 1: Attach Files</h3>
            <p>I have staged <b>${files.length}</b> file(s) at:</p>
            <code>${folderPath}</code>
            <br/><br/>
            <button onclick="openFolder()">📂 Open Folder to Drag-and-Drop</button>
        </div>

        <div class="step">
            <h3>Step 2: The Prompt</h3>
            <p>Copy this JSON-enforcing prompt into AI Studio:</p>
            <textarea id="promptBox">${prompt}</textarea>
            <br/><br/>
            <button onclick="copyText()">📋 Copy Prompt</button>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            
            function openFolder() {
                vscode.postMessage({ command: 'openFolder' });
            }

            function copyText() {
                const copyText = document.getElementById("promptBox");
                copyText.select();
                document.execCommand("copy");
            }
        </script>
    </body>
    </html>`;
}

export function deactivate() {}