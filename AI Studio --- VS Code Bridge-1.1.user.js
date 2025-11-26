// ==UserScript==
// @name         AI Studio <-> VS Code Bridge
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  Automate moving text between AI Studio and VS Code
// @author       You
// @match        https://aistudio.google.com/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    const VSCODE_API = "http://localhost:54321";

    function log(msg, data = null) {
        if (data) console.log(`[AI Bridge] ${msg}`, data);
        else console.log(`[AI Bridge] ${msg}`);
    }

    function createUI() {
        if (document.getElementById('ai-bridge-container')) return;

        const div = document.createElement('div');
        div.id = 'ai-bridge-container';
        div.style.position = 'fixed';
        div.style.bottom = '20px';
        div.style.right = '20px';
        div.style.zIndex = '9999';
        div.style.background = '#222';
        div.style.padding = '10px';
        div.style.borderRadius = '8px';
        div.style.border = '1px solid #555';
        div.style.color = 'white';
        div.style.display = 'flex';
        div.style.gap = '10px';

        const btnPull = document.createElement('button');
        btnPull.id = 'btn-pull';
        btnPull.innerText = "⬇️ Load Prompt";
        btnPull.style.padding = '8px';
        btnPull.style.cursor = 'pointer';
        btnPull.onclick = () => fetchFromVSCode();

        const btnPush = document.createElement('button');
        btnPush.id = 'btn-push';
        btnPush.innerText = "⬆️ Send Code";
        btnPush.style.padding = '8px';
        btnPush.style.cursor = 'pointer';
        btnPush.onclick = sendToVSCode;

        div.appendChild(btnPull);
        div.appendChild(btnPush);
        document.body.appendChild(div);
        log("UI Created");
    }

    function fetchFromVSCode(silent = false) {
        const btn = document.getElementById('btn-pull');
        if (btn) btn.innerText = "⏳ Loading...";

        GM_xmlhttpRequest({
            method: "GET",
            url: `${VSCODE_API}/prompt`,
            onload: function(response) {
                if (response.status === 200) {
                    const data = JSON.parse(response.responseText);

                    let input = document.querySelector('textarea');
                    if (!input) input = document.querySelector('div[contenteditable="true"]');

                    if (input) {
                        // Wrap in markdown block to preserve structure in AI Studio
                        const safeContent = "```\n" + data.prompt + "\n```";
                        
                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                        if (nativeInputValueSetter && input instanceof HTMLTextAreaElement) {
                            nativeInputValueSetter.call(input, safeContent);
                        } else {
                            input.value = safeContent;
                            input.innerText = safeContent;
                        }

                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        
                        if (btn) {
                            btn.innerText = "✅ Loaded!";
                            setTimeout(() => btn.innerText = "⬇️ Load Prompt", 2000);
                        }
                    } else {
                        if (!silent) alert("Could not find input box. Click the chat input first.");
                        if (btn) btn.innerText = "⬇️ Load Prompt";
                    }
                } else {
                    if (!silent) alert("VS Code not responding.");
                    if (btn) btn.innerText = "⬇️ Load Prompt";
                }
            },
            onerror: () => {
                if (!silent) alert("Connection failed. Check VS Code.");
                if (btn) btn.innerText = "⬇️ Load Prompt";
            }
        });
    }

    function sendToVSCode() {
        log("Attempting to extract code...");
        let content = "";

        // Strategy 1: Find all 'pre code' or 'code' blocks
        // AI Studio usually wraps code in <pre> or specific containers
        const codeBlocks = Array.from(document.querySelectorAll('pre code, code, ms-code-block code'));
        log(`Found ${codeBlocks.length} code blocks.`);

        // We are specifically looking for the LAST block that looks like a JSON response
        // The AI output is usually at the bottom. The prompt might be at the top.
        for (let i = codeBlocks.length - 1; i >= 0; i--) {
            const text = codeBlocks[i].innerText || codeBlocks[i].textContent;
            // Check if it looks like the JSON schema we expect
            if (text.includes('"status":') && (text.includes('"COMPLETED"') || text.includes('"NEED_CONTEXT"'))) {
                content = text;
                log("Found JSON-like block at index " + i);
                break;
            }
        }

        // Strategy 2: If no JSON block found, try the very last code block of any kind
        if (!content && codeBlocks.length > 0) {
            log("No obvious JSON block found. Fallback to last code block.");
            content = codeBlocks[codeBlocks.length - 1].innerText || codeBlocks[codeBlocks.length - 1].textContent;
        }

        // Strategy 3: Selection
        if (!content) {
            content = window.getSelection().toString();
            if (content) log("Using text selection.");
        }

        if (!content) {
            alert("Could not find any code blocks and no text is selected.");
            return;
        }

        log("Payload length:", content.length);
        log("Payload snippet:", content.substring(0, 100));

        const btn = document.getElementById('btn-push');
        const originalText = btn ? btn.innerText : "⬆️ Send Code";
        if (btn) btn.innerText = "⏳ Sending...";

        GM_xmlhttpRequest({
            method: "POST",
            url: `${VSCODE_API}/response`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ text: content }),
            onload: function(response) {
                log("Response status:", response.status);
                if (response.status === 200) {
                    const respData = JSON.parse(response.responseText);
                    
                    if (btn) {
                        btn.innerText = "✅ Sent!";
                        setTimeout(() => btn.innerText = originalText, 2000);
                    }

                    // AUTO-LOAD if VS Code requested context
                    if (respData.result && respData.result.action === 'NEED_CONTEXT') {
                        log("Context requested. Auto-loading...");
                        setTimeout(() => fetchFromVSCode(true), 500);
                    }
                } else {
                    alert("Error sending to VS Code. Check console logs.");
                    if (btn) {
                        btn.innerText = "❌ Error";
                        setTimeout(() => btn.innerText = originalText, 2000);
                    }
                }
            },
            onerror: (err) => {
                log("Connection error", err);
                alert("Connection failed.");
                if (btn) btn.innerText = originalText;
            }
        });
    }

    setTimeout(createUI, 3000);
})();